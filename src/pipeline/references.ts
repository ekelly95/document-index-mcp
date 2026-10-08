import type { DraftChunk } from "./chunker.js";

/**
 * Reference lists, tagged so search can leave them out by default.
 *
 * Every chapter of a textbook or paper ends in pages of citations, and they
 * are the worst kind of near-miss: a passage of titles like "Effects of
 * caffeine intake on muscle strength: a systematic review" matches a question
 * about caffeine and strength on every word while answering nothing. Measured
 * on the NCSF library, 10-30% of each chapter's chunks were reference list.
 *
 * Tagged, not dropped: they stay readable with get_chunk_context and
 * searchable with `filter.kind: "references"`.
 */

const REFERENCE_HEADING = /^(?:references?|bibliography|works cited|literature cited|reference list|sources)$/i;

const CITATION = new RegExp(
  [
    // Volume: pages, year — "15: 3-12, 2015", "51(4): e0178819, 2017"
    String.raw`\b\d+(?:\s*\(\d+\))?:\s*[eE]?\d+(?:\s*[-–]\s*\d+)?,\s*(?:19|20)\d{2}\b`,
    // A numbered author entry — "14. Burd NA," / "7. Mozaffarian D,"
    String.raw`(?:^|\s)\d{1,3}\.\s+\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}{1,3})?[,.]`,
    String.raw`\bet al\b`,
    String.raw`\bdoi:\s*\S+|https?://doi\.org/\S+`,
  ].join("|"),
  "gu",
);

/** Is this passage, on its own, dense enough with citations to be a reference list? */
export function looksLikeReferenceList(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  const hits = (text.match(CITATION) ?? []).length;
  return words >= 15 && hits >= 3 && (hits * 100) / words >= 2.5;
}

const underReferenceHeading = (chunk: DraftChunk): boolean =>
  chunk.sectionPath.some((segment) => REFERENCE_HEADING.test(segment.trim()));

/**
 * Retype reference-list chunks as `references`.
 *
 * A chunk counts if it sits under a References-style heading or is dense with
 * citations — or if it is sandwiched between two that are, since one long
 * title-heavy entry can dip below the density bar mid-list. Tables and code
 * keep their kind.
 */
export async function* markReferences(chunks: AsyncIterable<DraftChunk>): AsyncIterable<DraftChunk> {
  const isRef = (c: DraftChunk) => underReferenceHeading(c) || looksLikeReferenceList(c.text);
  const retype = (c: DraftChunk): DraftChunk =>
    c.kind === "table" || c.kind === "code" ? c : { ...c, kind: "references" };

  let previousWasRef = false;
  let held: DraftChunk | null = null;
  for await (const chunk of chunks) {
    const ref = isRef(chunk);
    if (held) {
      const sandwiched: boolean = previousWasRef && ref;
      yield sandwiched ? retype(held) : held;
      previousWasRef = sandwiched;
      held = null;
    }
    if (ref) {
      yield retype(chunk);
      previousWasRef = true;
    } else if (previousWasRef) {
      held = chunk; // decided by what follows
    } else {
      yield chunk;
      previousWasRef = false;
    }
  }
  if (held) yield held;
}
