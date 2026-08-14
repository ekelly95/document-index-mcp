import { byRowids, type HydratedChunkRow } from "../db/chunksRepo.js";
import type { Db } from "../db/sqlite.js";
import { packVector } from "../db/sqlite.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { ChunkKind } from "../pipeline/ir.js";

/**
 * Hybrid retrieval: FTS5 BM25 and sqlite-vec KNN, fused with Reciprocal Rank
 * Fusion. RRF is used rather than score normalisation because BM25 scores and
 * cosine distances have no common scale and no stable range across queries.
 */

export interface FusionTuning {
  /**
   * The RRF constant. It decides whether fusion rewards *agreement between the
   * legs* or *conviction within one leg*, and the difference is not subtle.
   *
   * At the textbook k = 60 with ten candidates per leg, every rank from 1 to 10
   * scores between 1/61 and 1/70 — a spread of 14%. Two legs each ranking a
   * chunk tenth therefore sum to more than either leg ranking a chunk first, so
   * the fusion is effectively voting on whether both legs found something at
   * all. That is fine when both legs are competent and actively harmful when
   * one is not: measured over the stress corpus, the lexical leg answers only
   * 12% of paraphrased questions inside the top three, and at k = 60 its vote
   * still dragged hybrid down from the semantic leg's 60% to 32%.
   *
   * Lowering k widens the gap between ranks, so a leg that is confident can
   * outvote a leg that merely also saw the chunk.
   */
  k: number;
  /** Multiplier on the lexical leg's contribution. */
  lexicalWeight: number;
  /** Multiplier on the semantic leg's contribution. */
  semanticWeight: number;
}

/**
 * Tuned against `eval/questions.json` over the stress corpus, 2026-08-13,
 * on schema v4 embeddings (which carry the document title).
 *
 * |                          | R@1 | R@3 | R@5 |   MRR |
 * |--------------------------|-----|-----|-----|-------|
 * | lexical only             | 27% | 38% | 45% | 0.333 |
 * | semantic only            | 39% | 57% | 64% | 0.501 |
 * | hybrid, `k = 60` (old)   | 32% | 59% | 68% | 0.465 |
 * | hybrid, this             | 43% | 64% | 66% | 0.548 |
 *
 * The bar was semantic-only, not lexical: hybrid beating the weaker leg it
 * contains proves nothing. The old default cleared neither.
 *
 * `k = 2, semantic x 2` scored a statistically identical 0.549 with a better
 * R@1 (45%) and a worse R@3 (61%). MRR could not separate them, so R@3 chose:
 * an agent reads the top few hits, not only the first, and the lighter semantic
 * weighting leaves more authority with the lexical leg on exact identifiers.
 *
 * Read the exact numbers with some suspicion — the configuration was chosen by
 * MRR on the same 56 questions it is scored against, so the peak is fitted, and
 * it moved once already when the embedding input changed. The *shape* is
 * steadier: every setting with `k <= 5` and `semanticWeight >= 1.5` scores
 * 0.525–0.549, a broad plateau well clear of both the old default and
 * semantic-only. It is the plateau that justifies the change; the exact summit
 * is a detail, and a held-out question set is the obvious next improvement.
 *
 * Run `pnpm eval --sweep` after touching anything that affects ranking — that
 * includes what goes into the embedded text, not only these constants.
 */
export const DEFAULT_FUSION: FusionTuning = {
  k: 2,
  lexicalWeight: 1,
  semanticWeight: 1.5,
};

/**
 * DEVIATION from the source spec's flat OVERFETCH = 4, which applied every
 * filter after fusion over 4x k candidates. That does not survive contact with
 * a sparse filter: tables are ~2% of a typical corpus, so 4 x 10 = 40
 * candidates would yield about one table.
 *
 * The overfetch is per LEG, because the two legs are not equally capable.
 * document_id, kind and page_range go into the lexical leg's own SQL, so every
 * candidate it returns already satisfies them and a tight net is enough.
 *
 * The vector leg can pre-filter on document_id and nothing else — that is the
 * vec0 partition key, and vec_chunks carries no other column. An earlier
 * version of this comment claimed pushed-down filters "cost no overfetch at
 * all", which was true only of the lexical leg; with a 2x net a `kind: table`
 * query got essentially zero tables from the vector side, quietly degrading
 * hybrid search to lexical-only exactly when it was asked to be selective.
 * So anything that can only be applied after the KNN scan is paid for with a
 * much wider net instead. A vec0 scan costs the scan, not k, so raising k is
 * close to free.
 */
const PUSHED_DOWN_OVERFETCH = 2;
const POST_FILTER_OVERFETCH = 32;

/**
 * How many times a leg may be re-run with a wider net before giving up.
 *
 * The overfetch above is a guess about how selective a filter is, and a guess
 * is all it can be: `kind: table` over a corpus of tables needs no widening,
 * and over a corpus with three tables in it no fixed multiple is enough. When
 * a leg comes back saturated — it returned exactly as many candidates as it
 * was asked for, so there were more — and the filters still left fewer than k
 * hits, the honest move is to ask for more rather than return a short list
 * that looks like an exhausted corpus.
 *
 * Bounded because each round costs another vec0 scan. Three doublings take the
 * vector leg from 32x to 256x, which for k=10 is 2,560 candidates: past that,
 * a filter is selective enough that the answer really is "few".
 */
const MAX_ESCALATIONS = 3;

export interface SearchFilter {
  kind?: ChunkKind;
  sectionPrefix?: string;
  pageRange?: [number, number];
}

export interface HybridQuery {
  query: string;
  documentId?: string;
  k: number;
  mode: "hybrid" | "lexical" | "semantic";
  filter?: SearchFilter;
  /**
   * Overrides `DEFAULT_FUSION`. Only the evaluation harness passes this — the
   * tools deliberately do not expose it, because a per-call ranking knob turns
   * every future search-quality question into "which weights was it using?".
   */
  fusion?: FusionTuning;
}

export interface Hit {
  row: HydratedChunkRow;
  score: number;
  snippet: string;
}

/**
 * Build a safe FTS5 MATCH expression.
 *
 * Raw user text cannot go in: `NEAR`, `*`, quotes and parentheses are all
 * operators, so a question containing an apostrophe or a hyphen would be a
 * syntax error rather than a search. Terms are extracted, quoted individually,
 * and joined with OR — natural-language queries share few exact terms with any
 * one passage, and implicit AND would return nothing for most of them. BM25
 * still ranks passages matching more, and rarer, terms above the rest.
 */
export function toFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Does this section path sit under `prefix`?
 *
 * Compared segment by segment. The previous implementation joined the path
 * with " › " and called startsWith on the result, which made a filter of
 * "Part II" match every chunk under "Part III — Results" — the joined string
 * really does start with those characters. Comparing segments confines a
 * filter to the level it names.
 *
 * Within a segment the match is still a prefix, but one that has to end on a
 * word boundary. That keeps the convenience of typing a heading's opening
 * words — "Part II" finds "Part II — Methods", "3" finds both "3.1 Design" and
 * "3.2 Sampling" — without letting "Part II" swallow "Part III" or "3.2" reach
 * into "3.25". A caller can also paste a rendered location straight back in,
 * since describeLocation prints the same separator.
 */
export function sectionPathMatches(
  sectionPath: readonly string[],
  prefix: string,
): boolean {
  // "›" is awkward to type, so a plain ">" is accepted as the same separator.
  const wanted = prefix
    .split(/\s*[›>]\s*/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (wanted.length === 0) return true;
  if (wanted.length > sectionPath.length) return false;

  return wanted.every((want, i) => {
    const segment = sectionPath[i]!.trim().toLowerCase();
    if (!segment.startsWith(want)) return false;
    const next = segment[want.length];
    return next === undefined || !/[\p{L}\p{N}]/u.test(next);
  });
}

interface LexicalResult {
  ids: number[];
  snippets: Map<number, string>;
}

function lexicalLeg(db: Db, q: HybridQuery, limit: number): LexicalResult {
  const match = toFtsQuery(q.query);
  if (!match) return { ids: [], snippets: new Map() };

  // A document still being indexed is a partial corpus, and a hit from one is
  // indistinguishable from a hit from a finished document. Restricting to
  // 'ready' is what recoverInterrupted's comment already asks for on behalf of
  // crashed ingests; it applies just as much to a live one.
  const where: string[] = ["search_fts MATCH ?", "d.ingest_status = 'ready'"];
  const params: unknown[] = [match];

  if (q.documentId) {
    where.push("c.document_id = ?");
    params.push(q.documentId);
  }
  if (q.filter?.kind) {
    where.push("c.kind = ?");
    params.push(q.filter.kind);
  }
  if (q.filter?.pageRange) {
    where.push("c.page_number BETWEEN ? AND ?");
    params.push(q.filter.pageRange[0], q.filter.pageRange[1]);
  }

  // bm25() returns a negative score where more negative is better, so ASC.
  const rows = db
    .prepare(
      `SELECT c.id AS id,
              bm25(search_fts) AS score,
              snippet(search_fts, 0, '«', '»', '…', 12) AS snip
         FROM search_fts
         JOIN document_chunks c ON c.id = search_fts.rowid
         JOIN documents d ON d.id = c.document_id
        WHERE ${where.join(" AND ")}
        ORDER BY score
        LIMIT ?`,
    )
    .all(...params, limit) as { id: number; score: number; snip: string }[];

  return {
    ids: rows.map((r) => Number(r.id)),
    snippets: new Map(rows.map((r) => [Number(r.id), r.snip])),
  };
}

async function semanticLeg(
  db: Db,
  embedder: Embedder,
  q: HybridQuery,
  limit: number,
): Promise<number[]> {
  const vector = await embedder.embedQuery(q.query);

  // document_id is the vec0 partition key, so scoping to one document
  // pre-filters the KNN scan rather than discarding results afterwards.
  const scoped = q.documentId !== undefined;
  const rows = db
    .prepare(
      `SELECT chunk_rowid AS id
         FROM vec_chunks
        WHERE embedding MATCH ?
          AND k = ?
          ${scoped ? "AND document_id = ?" : ""}
        ORDER BY distance`,
    )
    .all(
      ...(scoped
        ? [packVector(vector), limit, q.documentId]
        : [packVector(vector), limit]),
    ) as { id: number | bigint }[];

  return rows.map((r) => Number(r.id));
}

/**
 * A ~300 character window centred on the passage's most query-relevant
 * sentence.
 *
 * DEVIATION from the source spec, which scored each sentence against the query
 * *embedding*. That would cost one model inference per sentence per hit —
 * measured at ~50ms each on this machine, so a 10-hit result set would take
 * several seconds. Term overlap is a cheap proxy that picks the same sentence
 * in the overwhelming majority of cases, and the fallback is the passage head.
 */
export function semanticSnippet(text: string, query: string, maxChars = 300): string {
  if (text.length <= maxChars) return text;

  const terms = new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  );

  // matchAll rather than a running offset. The pattern needs a non-terminator
  // to start a match, so it cannot match a LEADING run of ".!?" — text opening
  // with an ellipsis skipped those characters entirely, and every offset
  // accumulated afterwards was short by that much, sliding the window off the
  // sentence it had chosen. Reading m.index makes the bookkeeping unnecessary
  // rather than merely correct.
  const sentences = [...text.matchAll(/[^.!?]+[.!?]*/g)];
  if (sentences.length === 0) return `${text.slice(0, maxChars).trimEnd()}…`;

  let best = sentences[0]!;
  let bestScore = -1;
  for (const sentence of sentences) {
    const words = sentence[0].toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    let score = 0;
    for (const w of words) if (terms.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  if (bestScore <= 0) return `${text.slice(0, maxChars).trimEnd()}…`;

  const centre = (best.index ?? 0) + best[0].length / 2;
  const start = Math.max(0, Math.floor(centre - maxChars / 2));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export async function hybridSearch(
  db: Db,
  embedder: Embedder,
  q: HybridQuery,
): Promise<Hit[]> {
  // What each leg cannot answer for itself, and therefore has to over-fetch
  // against.
  //
  // The vector leg pre-filters on document_id and nothing else — that is the
  // vec0 partition key and vec_chunks carries no other column — so kind,
  // page_range, section_prefix and the ready check all cost it candidates.
  //
  // The lexical leg pushes document_id, kind, page_range and ready into its
  // own SQL. It CANNOT push section_prefix: section paths are stored as a JSON
  // array, so there is no column to compare against. An earlier version
  // escalated only the vector leg for section_prefix while leaving this one at
  // 2x, and the comment here claimed the lexical leg "already honours all of
  // them" — it does not. A section-scoped query therefore handed 20 unfiltered
  // candidates to a filter the leg knew nothing about while the vector leg got
  // 1,600, and hybrid quietly degraded to semantic-only: the exact mirror of
  // the failure the 32x constant was introduced to fix.
  const lexicalPostFiltered = q.filter?.sectionPrefix !== undefined;
  const semanticPostFiltered =
    q.filter !== undefined &&
    (q.filter.kind !== undefined ||
      q.filter.pageRange !== undefined ||
      q.filter.sectionPrefix !== undefined);

  let lexicalLimit = q.k * (lexicalPostFiltered ? POST_FILTER_OVERFETCH : PUSHED_DOWN_OVERFETCH);
  let semanticLimit = q.k * (semanticPostFiltered ? POST_FILTER_OVERFETCH : PUSHED_DOWN_OVERFETCH);

  let hits: Hit[] = [];
  for (let round = 0; ; round++) {
    const lexical = q.mode !== "semantic"
      ? lexicalLeg(db, q, lexicalLimit)
      : { ids: [], snippets: new Map<number, string>() };
    const semantic = q.mode !== "lexical"
      ? await semanticLeg(db, embedder, q, semanticLimit)
      : [];

    hits = fuseAndHydrate(db, q, lexical, semantic);
    if (hits.length >= q.k || round >= MAX_ESCALATIONS) break;

    // A leg that returned exactly what it was asked for had more to give; one
    // that returned less is exhausted, and asking again would re-scan the same
    // corpus for the same answer.
    const lexicalSaturated = lexicalPostFiltered && lexical.ids.length === lexicalLimit;
    const semanticSaturated = semanticPostFiltered && semantic.length === semanticLimit;
    if (!lexicalSaturated && !semanticSaturated) break;

    if (lexicalSaturated) lexicalLimit *= 2;
    if (semanticSaturated) semanticLimit *= 2;
  }

  return hits;
}

/**
 * Weighted Reciprocal Rank Fusion over the two legs' candidate lists.
 *
 * Exported, like the other pure parts of this module, so the ranking property
 * can be pinned in a test without standing up a database and a 130MB model.
 * Returns `[chunkRowid, score]` pairs, best first.
 */
export function fuseRankings(
  lexicalIds: readonly number[],
  semanticIds: readonly number[],
  tuning: FusionTuning,
): [number, number][] {
  const fused = new Map<number, number>();
  const legs: readonly (readonly [readonly number[], number])[] = [
    [lexicalIds, tuning.lexicalWeight],
    [semanticIds, tuning.semanticWeight],
  ];
  for (const [leg, weight] of legs) {
    if (weight === 0) continue;
    leg.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + weight / (tuning.k + rank + 1));
    });
  }

  return [...fused.entries()].sort((a, b) => {
    // Ties broken by rowid so a fixed query over a fixed corpus is stable.
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] - b[0];
  });
}

/** Fuse the two legs, hydrate the survivors, and apply what SQL could not. */
function fuseAndHydrate(
  db: Db,
  q: HybridQuery,
  lexical: LexicalResult,
  semantic: readonly number[],
): Hit[] {
  const ranked = fuseRankings(lexical.ids, semantic, q.fusion ?? DEFAULT_FUSION);
  if (ranked.length === 0) return [];

  // The semantic leg is unfiltered beyond its partition, so its candidates
  // still have to be checked. That happens in SQL during hydration rather than
  // in the loop below: with the wide nets above, filtering afterwards would
  // mean loading thousands of rows including their full text purely to discard
  // them.
  const rows = byRowids(
    db,
    ranked.map(([id]) => id),
    {
      readyOnly: true,
      ...(q.filter?.kind === undefined ? {} : { kind: q.filter.kind }),
      ...(q.filter?.pageRange === undefined ? {} : { pageRange: q.filter.pageRange }),
    },
  );

  const hits: Hit[] = [];
  for (const [id, score] of ranked) {
    const row = rows.get(id);
    if (!row) continue;

    // The one filter that cannot be pushed into SQL at all: section paths are
    // stored as a JSON array, so there is nothing to compare a column against.
    if (
      q.filter?.sectionPrefix &&
      !sectionPathMatches(JSON.parse(row.section_path) as string[], q.filter.sectionPrefix)
    ) {
      continue;
    }

    hits.push({
      row,
      score,
      snippet: lexical.snippets.get(id) ?? semanticSnippet(row.text, q.query),
    });
    if (hits.length >= q.k) break;
  }

  return hits;
}
