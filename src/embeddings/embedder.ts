import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import { MAX_TOKENS } from "../pipeline/chunker.js";

/**
 * bge-small-en-v1.5, 384 dimensions, via fastembed (ONNX Runtime on CPU).
 *
 * Downloaded once on first use (~65 MB) from huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q
 * and cached. One of the server's two network calls; the other is OCR language
 * data on the first scanned PDF.
 */

export const EMBEDDING_MODEL = EmbeddingModel.BGESmallENV15;
/**
 * Recorded in the index so vectors from different models are never mixed.
 * fastembed 3 moved the download from GCS to Hugging Face, but the weights are
 * byte-identical (see MODEL_FILE_SHA256), so the name is unchanged.
 */
export const EMBEDDING_MODEL_NAME = "fast-bge-small-en-v1.5";
export const EMBEDDING_DIM = 384;
const BATCH_SIZE = 64;

/** Where fastembed 3 caches this model: `<cacheDir>/<repo, "/" → "_">`. */
export const MODEL_DIR_NAME = "Qdrant_bge-small-en-v1.5-onnx-Q";

/**
 * The files that decide what a vector means, pinned. The download has no
 * signature of its own, so this is the only thing between a tampered or
 * truncated cache and an index built from it.
 */
export const MODEL_FILE_SHA256: Readonly<Record<string, string>> = {
  "model_optimized.onnx": "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431",
  "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
};

export class ModelIntegrityError extends Error {
  override readonly name = "ModelIntegrityError";
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Refuse a model directory whose pinned files do not match. */
export async function verifyModelFiles(modelDir: string): Promise<void> {
  for (const [name, expected] of Object.entries(MODEL_FILE_SHA256)) {
    const file = path.join(modelDir, name);
    let actual: string;
    try {
      actual = await sha256File(file);
    } catch (err) {
      throw new ModelIntegrityError(`Embedding model file ${name} is unreadable: ${String(err)}`);
    }
    if (actual !== expected) {
      throw new ModelIntegrityError(
        `Embedding model file ${name} does not match its pinned SHA-256 ` +
          `(expected ${expected}, got ${actual}). Delete ${modelDir} to re-download it.`,
      );
    }
  }
}

/**
 * BGE v1.5 asks for an instruction on the QUERY side only; passages are
 * embedded raw.
 *
 * fastembed's own `queryEmbed`/`passageEmbed` helpers are not usable here:
 * they prepend "query: " and "passage: ", which are the E5 family's prefixes,
 * not BGE's. Applying them would embed passages and queries under a convention
 * the model was never trained on. So `embed()` is called directly for both
 * sides and the correct instruction is applied here.
 */
const BGE_QUERY_INSTRUCTION =
  "Represent this sentence for searching relevant passages: ";

export interface EmbeddableChunk {
  text: string;
  sectionPath: readonly string[];
  overlapPrefix: string | null;
  /**
   * The document's title. Optional so the chunker's own tests need not invent
   * one; every real ingest supplies it.
   */
  documentTitle?: string | undefined;
}

/**
 * The string actually fed to the model.
 *
 * The section path travels with the text so that "3.2 Sampling" is part of
 * what the vector means, and the overlap prefix restores context that the
 * boundary law cut off. Neither is stored: `document_chunks.text` stays clean,
 * so what a caller reads back is exactly what is on the page.
 *
 * The title leads, when there is one, because a passage carries no trace of
 * which document it came from. A question naming its source — "what does the
 * ResNet paper say about degradation" — otherwise has nothing in the vector
 * space to match the naming half against, and competes only on the topic half
 * against every document that discusses it. Titles are short, so the cost to
 * the passage's own meaning is small.
 */
export function composeEmbedInput(chunk: EmbeddableChunk): string {
  const parts: string[] = [];
  if (chunk.documentTitle) parts.push(chunk.documentTitle);
  if (chunk.sectionPath.length > 0) parts.push(chunk.sectionPath.join(" › "));
  if (chunk.overlapPrefix) parts.push(chunk.overlapPrefix);
  parts.push(chunk.text);
  return parts.join("\n\n");
}

/**
 * How the model gets loaded. Injectable so the retry-after-failure path can be
 * tested without a network, which is the one thing a test of it must not need.
 */
export interface EmbedderInitOptions {
  model: Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
  cacheDir: string;
  maxLength: number;
}

/**
 * Declared here rather than as `Parameters<typeof FlagEmbedding.init>[0]`:
 * `init` is overloaded, so that form resolves to the LAST overload — the
 * custom-model one — and rejects a standard model. fastembed's package exports
 * do not re-export `InitStandardOptions`, so the three fields actually passed
 * are spelled out instead.
 */
export type InitEmbedding = (opts: EmbedderInitOptions) => Promise<FlagEmbedding>;

/**
 * Load the real model, then check it against the pinned hashes before it is
 * used. Verified after init rather than before because fastembed's download is
 * private to it; a mismatch still means nothing is ever embedded with it.
 */
export const initVerifiedModel: InitEmbedding = async (opts) => {
  const model = await FlagEmbedding.init({ ...opts, showDownloadProgress: false });
  await verifyModelFiles(path.join(opts.cacheDir, MODEL_DIR_NAME));
  return model;
};

export class Embedder {
  private model: FlagEmbedding | null = null;
  private initPromise: Promise<FlagEmbedding> | null = null;

  constructor(
    private readonly cacheDir: string,
    private readonly init: InitEmbedding = initVerifiedModel,
  ) {}

  /**
   * Initialise once, even under concurrent callers. The promise is cached
   * rather than the model so two parallel ingests cannot both trigger a
   * download.
   */
  private ready(): Promise<FlagEmbedding> {
    if (this.model) return Promise.resolve(this.model);
    if (!this.initPromise) {
      const attempt = this.init({
        model: EMBEDDING_MODEL,
        cacheDir: this.cacheDir,
        // Matches the chunker's hard cap. fastembed pads every input to this
        // width, so it is a direct cost lever: 512 => ~140s per 400-page book on
        // this machine, 400 => ~105s.
        maxLength: MAX_TOKENS,
      }).then((m) => {
        this.model = m;
        return m;
      });

      // A FAILED init must not be cached. The first run downloads ~65MB over
      // the network, so it is the one call here that routinely fails for
      // reasons that pass — offline, a flaky hop, a half-written cache. Caching
      // the rejected promise made every later embed in the process rethrow that
      // same first error until restart, long after the network came back.
      //
      // The identity check stops a stale failure from clearing a newer attempt,
      // and this .catch is a separate handled branch, so no unhandled rejection
      // is created while `initPromise` still rejects for real awaiters.
      attempt.catch(() => {
        if (this.initPromise === attempt) this.initPromise = null;
      });

      this.initPromise = attempt;
    }
    return this.initPromise;
  }

  /** Warm the model (and trigger any download) before timing-sensitive work. */
  async warmup(): Promise<void> {
    await this.ready();
  }

  async embedPassages(chunks: readonly EmbeddableChunk[]): Promise<number[][]> {
    if (chunks.length === 0) return [];
    const model = await this.ready();
    const inputs = chunks.map(composeEmbedInput);

    const out: number[][] = [];
    for await (const batch of model.embed(inputs, BATCH_SIZE)) {
      for (const v of batch) out.push(v);
    }
    if (out.length !== inputs.length) {
      throw new Error(
        `Embedder returned ${out.length} vectors for ${inputs.length} inputs`,
      );
    }
    return out;
  }

  async embedQuery(query: string): Promise<number[]> {
    const model = await this.ready();
    const input = `${BGE_QUERY_INSTRUCTION}${query}`;
    const batch = await model.embed([input], 1).next();
    const vector = batch.value?.[0];
    if (!vector) throw new Error("Embedder produced no vector for the query");
    return vector;
  }
}
