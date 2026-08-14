import type { FlagEmbedding } from "fastembed";
import { Embedder, EMBEDDING_DIM, type InitEmbedding } from "../embeddings/embedder.js";

/**
 * A deterministic stand-in for the real model, so a test can exercise the whole
 * pipeline without a 130 MB download and a second of ONNX startup.
 *
 * The end-to-end suite was the only thing loading the real model, and it cost
 * eleven of the suite's twelve seconds. What those tests assert is mechanism —
 * that a hit names its source, that filters push down, that a body read is
 * capped, that ingest supersedes — none of which is a claim about embedding
 * quality. Ranking quality is measured by `pnpm eval` against a real corpus,
 * which is a different exercise with a different corpus and its own numbers.
 *
 * So this is not a fake that returns noise: noise would leave the semantic leg
 * pulling arbitrary chunks into a fused ranking and quietly make those
 * assertions meaningless. It is a hashing bag-of-words vector, which gives
 * genuine word-overlap similarity — a query about badgers really does land
 * nearer a passage about badgers. The fused ordering is then stable and the
 * assertions mean what they say, while remaining a coarser instrument than the
 * real model, which is fine because none of them is grading relevance.
 *
 * What it cannot stand in for is the model pipeline itself: the download, the
 * tar extract that `patches/fastembed@2.1.0.patch` touches, and ONNX loading.
 * Those need the real thing, which is why `DOCUMENT_INDEX_TEST_REAL_MODEL`
 * exists and why CI still runs one job with it set.
 */

/** FNV-1a, for a stable bucket per token across platforms and runs. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function vectorFor(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    v[hashToken(token) % EMBEDDING_DIM]! += 1;
  }
  // L2-normalised, so distance between two texts reflects the proportion of
  // vocabulary they share rather than how long they are.
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

export function stubModel(): FlagEmbedding {
  return {
    async *embed(inputs: string[]) {
      yield inputs.map(vectorFor);
    },
  } as unknown as FlagEmbedding;
}

export const stubInitEmbedding: InitEmbedding = async () => stubModel();

/**
 * Set `DOCUMENT_INDEX_TEST_REAL_MODEL=1` to run against the real model instead.
 * CI sets it on one job, and the release workflow sets it too, so the download
 * and extract path are never untested — only untested *per platform*.
 */
export const usingRealModel = (): boolean =>
  process.env["DOCUMENT_INDEX_TEST_REAL_MODEL"] === "1";

/** The embedder a test should use, honouring that switch. */
export const testEmbedder = (cacheDir: string): Embedder =>
  usingRealModel() ? new Embedder(cacheDir) : new Embedder(cacheDir, stubInitEmbedding);
