import { byRowids, vectorsFor, type HydratedChunkRow } from "../db/chunksRepo.js";
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
   * The RRF constant. Low k widens the gap between ranks, so a confident leg can
   * outvote a leg that merely also saw the chunk; at the textbook k = 60 with ten
   * candidates, ranks 1-10 score within 14% of each other and fusion degrades to
   * voting on agreement.
   */
  k: number;
  /** Multiplier on the lexical leg's contribution. */
  lexicalWeight: number;
  /** Multiplier on the semantic leg's contribution. */
  semanticWeight: number;
}

/**
 * Tuned against `eval/questions.json` over the stress corpus, 2026-08-13, with
 * the document title in the embedded text (schema v4):
 *
 * |                          | R@1 | R@3 | R@5 |   MRR |
 * |--------------------------|-----|-----|-----|-------|
 * | lexical only             | 27% | 38% | 45% | 0.333 |
 * | semantic only            | 39% | 57% | 64% | 0.501 |
 * | hybrid, `k = 60` (old)   | 32% | 59% | 68% | 0.465 |
 * | hybrid, this             | 43% | 64% | 66% | 0.548 |
 *
 * The exact peak is fitted to those questions; what justifies it is the
 * plateau (every `k <= 5` with semantic weight >= 1.5 scores 0.525-0.549). Run
 * `pnpm eval --sweep` after changing anything that affects ranking, including
 * what goes into the embedded text.
 */
export const DEFAULT_FUSION: FusionTuning = {
  k: 2,
  lexicalWeight: 1,
  semanticWeight: 1.5,
};

/**
 * Overfetch is per leg. The lexical leg pushes document_id, kind, page_range
 * and the ready check into its own SQL, so a tight net is enough; the vector leg
 * can pre-filter only on document_id (the vec0 partition key), so anything else
 * is paid for with a wider net. A vec0 scan costs the scan, not k.
 */
const PUSHED_DOWN_OVERFETCH = 2;
const POST_FILTER_OVERFETCH = 32;
/** Reference lists are a minority of a corpus, so skipping them needs only a little slack. */
const REFERENCE_EXCLUSION_OVERFETCH = 4;

/**
 * How many times a saturated leg may be re-run with a doubled net when the
 * filters left fewer than k hits. Three doublings take the vector leg to 256x;
 * past that a filter is selective enough that "few" is the answer.
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
  /** Fused rank score. Orders hits; says nothing about relevance on its own. */
  score: number;
  snippet: string;
  /**
   * Cosine similarity between the query and this chunk's embedding.
   * Comparable across queries, unlike `score`. Null in lexical mode, where the
   * query is never embedded.
   */
  similarity: number | null;
  /** Whether full-text search matched the query's words in this chunk. */
  lexicalMatch: boolean;
}

/**
 * Below this best-hit similarity the library probably does not cover the
 * question. Calibrated for bge-small-en-v1.5 on a real 11-chapter textbook
 * library (2026-10): 25 on-topic questions scored 0.731-0.849, 15 off-topic
 * ones 0.398-0.575, so this sits in the gap. A question near the library's
 * subject but not answered by it will land around here; that is what "low"
 * is for. Re-measure if the embedding model or embedded text changes.
 */
export const CONFIDENT_SIMILARITY = 0.65;

export type Confidence = "high" | "low";

/** How far to trust a result set, or null when there is no similarity to judge by. */
export function assessConfidence(hits: readonly Hit[]): Confidence | null {
  const sims = hits.map((h) => h.similarity).filter((s): s is number => s !== null);
  if (sims.length === 0) return hits.length === 0 ? "low" : null;
  return Math.max(...sims) >= CONFIDENT_SIMILARITY ? "high" : "low";
}

/**
 * A safe FTS5 MATCH expression: terms extracted and quoted individually
 * (quotes, hyphens and NEAR are operators), joined with OR because natural
 * questions share few exact terms with any one passage. BM25 still ranks
 * passages matching more, and rarer, terms first.
 */
export function toFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Does this section path sit under `prefix`? Compared segment by segment, each
 * a prefix ending on a word boundary, so "Part II" finds "Part II — Methods" but
 * not "Part III", and "3" finds "3.1" but "3.2" does not reach "3.25". ">" is
 * accepted for "›".
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

  // A document still indexing is a partial corpus; only 'ready' ones answer.
  const where: string[] = ["search_fts MATCH ?", "d.ingest_status = 'ready'"];
  const params: unknown[] = [match];

  if (q.documentId) {
    where.push("c.document_id = ?");
    params.push(q.documentId);
  }
  if (q.filter?.kind) {
    where.push("c.kind = ?");
    params.push(q.filter.kind);
  } else {
    where.push("c.kind <> 'references'");
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

function semanticLeg(
  db: Db,
  vector: readonly number[],
  q: HybridQuery,
  limit: number,
): number[] {
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
 * A ~300 character window centred on the passage's sentence with the most
 * query terms. Term overlap rather than embedding each sentence, which would
 * cost ~50ms per sentence per hit.
 */
export function semanticSnippet(text: string, query: string, maxChars = 300): string {
  if (text.length <= maxChars) return text;

  const terms = new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  );

  // matchAll, so each sentence's offset is read rather than accumulated (a
  // leading "..." once threw every later offset off).
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
  // against. The vector leg pre-filters on document_id only (the vec0
  // partition key), so kind, page_range, section_prefix, the ready check and
  // the default reference-list exclusion all cost it candidates. The lexical
  // leg pushes everything but section_prefix (JSON, no column) into its SQL.
  const lexicalPostFiltered = q.filter?.sectionPrefix !== undefined;
  const selective =
    q.filter !== undefined &&
    (q.filter.kind !== undefined ||
      q.filter.pageRange !== undefined ||
      q.filter.sectionPrefix !== undefined);
  const excludesReferences = q.filter?.kind === undefined;

  let lexicalLimit = q.k * (lexicalPostFiltered ? POST_FILTER_OVERFETCH : PUSHED_DOWN_OVERFETCH);
  let semanticLimit =
    q.k *
    (selective
      ? POST_FILTER_OVERFETCH
      : excludesReferences
        ? REFERENCE_EXCLUSION_OVERFETCH
        : PUSHED_DOWN_OVERFETCH);
  const semanticPostFiltered = selective || excludesReferences;

  // Embedded once, not once per escalation round.
  const vector = q.mode !== "lexical" ? await embedder.embedQuery(q.query) : null;

  let hits: Hit[] = [];
  for (let round = 0; ; round++) {
    const lexical = q.mode !== "semantic"
      ? lexicalLeg(db, q, lexicalLimit)
      : { ids: [], snippets: new Map<number, string>() };
    const semantic = vector ? semanticLeg(db, vector, q, semanticLimit) : [];

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

  if (vector) {
    // Exact cosine from the stored vectors. Both sides are unit-normalised, so
    // it is the dot product. This is the one number here that means the same
    // thing from one query to the next.
    const stored = vectorsFor(db, hits.map((h) => h.row.id));
    for (const hit of hits) {
      const v = stored.get(hit.row.id);
      if (!v) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * vector[i]!;
      hit.similarity = dot;
    }
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

  // The vector leg's candidates are filtered in SQL during hydration, so the
  // wide nets above never load thousands of rows of text just to discard them.
  const rows = byRowids(
    db,
    ranked.map(([id]) => id),
    {
      readyOnly: true,
      ...(q.filter?.kind === undefined ? { excludeKind: "references" as const } : { kind: q.filter.kind }),
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
      similarity: null,
      lexicalMatch: lexical.snippets.has(id),
    });
    if (hits.length >= q.k) break;
  }

  return hits;
}
