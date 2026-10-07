import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FlagEmbedding } from "fastembed";
import {
  composeEmbedInput,
  Embedder,
  MODEL_FILE_SHA256,
  ModelIntegrityError,
  verifyModelFiles,
  type InitEmbedding,
} from "./embedder.js";

/**
 * Init downloads the model on first run, so it is the one call here that
 * routinely fails for reasons that pass. These tests use the injected init
 * seam: a test that a failed download can be retried must not need a download.
 */

const CHUNK = { text: "body", sectionPath: ["3.2 Sampling"], overlapPrefix: null };

/** Minimal stand-in for the ONNX model: one fixed vector per input. */
function stubModel(): FlagEmbedding {
  return {
    async *embed(inputs: string[]) {
      yield inputs.map(() => [0.1, 0.2, 0.3]);
    },
  } as unknown as FlagEmbedding;
}

test("a failed init is not cached, so the next call can retry", async () => {
  let attempts = 0;
  const flaky: InitEmbedding = async () => {
    attempts++;
    if (attempts === 1) throw new Error("getaddrinfo ENOTFOUND huggingface.co");
    return stubModel();
  };

  const embedder = new Embedder("unused", flaky);

  await assert.rejects(embedder.embedPassages([CHUNK]), /ENOTFOUND/);

  // Before the fix this threw the same first error for the life of the
  // process: the rejected promise stayed cached, so a machine that came back
  // online still could not embed anything until the server was restarted.
  const vectors = await embedder.embedPassages([CHUNK]);
  assert.equal(vectors.length, 1);
  assert.equal(attempts, 2);
});

test("a successful init is cached, so concurrent callers share one download", async () => {
  let attempts = 0;
  const counting: InitEmbedding = async () => {
    attempts++;
    return stubModel();
  };

  const embedder = new Embedder("unused", counting);
  await Promise.all([
    embedder.embedPassages([CHUNK]),
    embedder.embedPassages([CHUNK]),
    embedder.warmup(),
  ]);
  await embedder.embedQuery("later still");

  assert.equal(attempts, 1);
});

test("the embedded input carries the section path, and the stored text does not", () => {
  const input = composeEmbedInput({
    text: "The sampling frame was drawn from enrolled students.",
    sectionPath: ["Part II — Methods", "3.2 Sampling"],
    overlapPrefix: "…the preceding sentence.",
  });

  assert.ok(input.startsWith("Part II — Methods › 3.2 Sampling"));
  assert.ok(input.includes("…the preceding sentence."));
  assert.ok(input.endsWith("The sampling frame was drawn from enrolled students."));
});

test("the document title leads the embedded input when there is one", () => {
  // A passage carries no trace of which document it came from, so a query that
  // names its source has nothing to match the naming half against. The title
  // goes first and is still not stored.
  const input = composeEmbedInput({
    text: "Deeper networks are harder to optimise.",
    sectionPath: ["4. Experiments"],
    overlapPrefix: null,
    documentTitle: "Deep Residual Learning for Image Recognition",
  });

  assert.ok(input.startsWith("Deep Residual Learning for Image Recognition"));
  assert.ok(input.includes("4. Experiments"));
  assert.ok(input.endsWith("Deeper networks are harder to optimise."));
});

test("a model file that does not match its pinned hash is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-model-"));
  try {
    for (const name of Object.keys(MODEL_FILE_SHA256)) {
      fs.writeFileSync(path.join(dir, name), "not the model");
    }
    await assert.rejects(verifyModelFiles(dir), (err: unknown) => {
      assert.ok(err instanceof ModelIntegrityError);
      assert.match(err.message, /does not match its pinned SHA-256/);
      return true;
    });

    fs.rmSync(path.join(dir, "tokenizer.json"));
    fs.writeFileSync(path.join(dir, "model_optimized.onnx"), "still not the model");
    await assert.rejects(verifyModelFiles(dir), ModelIntegrityError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent title changes nothing about the composed input", () => {
  const withoutKey = composeEmbedInput({ text: "body", sectionPath: [], overlapPrefix: null });
  const withUndefined = composeEmbedInput({
    text: "body",
    sectionPath: [],
    overlapPrefix: null,
    documentTitle: undefined,
  });
  assert.equal(withoutKey, "body");
  assert.equal(withUndefined, "body");
});
