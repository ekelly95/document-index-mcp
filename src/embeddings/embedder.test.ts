import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FlagEmbedding } from "fastembed";
import {
  composeEmbedInput,
  Embedder,
  fitEmbedInput,
  loadModelTokenCounter,
  MODEL_FILE_SHA256,
  ModelIntegrityError,
  verifyModelFiles,
  type InitEmbedding,
} from "./embedder.js";
import { fitToBudget, type DraftChunk } from "../pipeline/chunker.js";

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

test("context gives way so the chunk's own text always reaches the model", async () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const count = async (t: string) => t.split(/\s+/).filter(Boolean).length;
  const chunk = {
    text: words(90),
    sectionPath: ["Part", "Chapter", "Section"],
    overlapPrefix: words(20),
    documentTitle: "A Title",
  };

  const roomy = await fitEmbedInput(chunk, count, 200);
  assert.equal(roomy, composeEmbedInput(chunk), "context was dropped when it fitted");

  const tight = await fitEmbedInput(chunk, count, 96);
  assert.ok((await count(tight)) <= 96);
  assert.ok(tight.endsWith(chunk.text), "the passage itself was cut");
  assert.ok(tight.startsWith("A Title"), "the title went before cheaper context");

  const bare = await fitEmbedInput(chunk, count, 90);
  assert.equal(bare, chunk.text);
});

test("with the real tokenizer, fitted chunks never exceed the model window", {
  skip: process.env["DOCUMENT_INDEX_TEST_REAL_MODEL"] !== "1" || !process.env["DOCUMENT_INDEX_MODEL_CACHE"],
}, async () => {
  const count = await loadModelTokenCounter(process.env["DOCUMENT_INDEX_MODEL_CACHE"]!);
  // Numeric tables are where chars/4 under-counts worst.
  const table = [
    "| Nutrient | RDA | UL | % DV |",
    "| --- | --- | --- | --- |",
    ...Array.from({ length: 60 }, (_, i) => `| ${i}.5 mg/kg | 1.${i} g | ${i * 7}% | ${i}/${i + 3} |`),
  ].join("\n");
  async function* drafts(): AsyncIterable<DraftChunk> {
    yield {
      kind: "table",
      locator: { type: "page", value: "33", ordinal: 32 },
      sectionPath: ["Micronutrients and Water", "Recommended Dietary Allowances"],
      bbox: null,
      text: table,
      overlapPrefix: "preceding text ".repeat(10),
      tokenCount: 0,
    };
  }

  let parts = 0;
  for await (const chunk of fitToBudget(drafts(), count)) {
    parts++;
    const input = await fitEmbedInput(
      { ...chunk, documentTitle: "NCSF Ch 5 – Micronutrients and Water" },
      count,
    );
    assert.ok(input.endsWith(chunk.text));
    assert.ok((await count(input)) <= 400, `fitted input is ${await count(input)} tokens`);
  }
  assert.ok(parts > 1, "the table was not split");
});
