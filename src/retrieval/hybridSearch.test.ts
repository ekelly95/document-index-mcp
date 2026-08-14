import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FlagEmbedding } from "fastembed";
import { openDatabase, type Db } from "../db/sqlite.js";
import { insertChunks } from "../db/chunksRepo.js";
import { insertDocument, finalizeDocument } from "../db/documentsRepo.js";
import {
  Embedder,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_NAME,
} from "../embeddings/embedder.js";
import type { ChunkKind } from "../pipeline/ir.js";
import { hybridSearch } from "./hybrid.js";

/**
 * hybridSearch itself: fusion, overfetch selection and filter pushdown.
 *
 * None of it had any test coverage. `hybrid.test.ts` covers the three exported
 * pure helpers precisely because they can be reached without a database and a
 * 130MB model — which left the function those helpers exist to serve
 * completely unasserted. A stub embedder makes it reachable.
 */

let dir: string;
let db: Db;
let embedder: Embedder;

/**
 * A stand-in model whose vectors encode a known ordering.
 *
 * Chunk text carries a marker like "rank07"; the vector puts that number in
 * its first dimension. The query embeds to zero, so nearest-neighbour order is
 * ascending rank — deterministic, and it lets a test say exactly which chunks
 * the vector leg should return and in what order.
 */
function rankedModel(): FlagEmbedding {
  return {
    async *embed(inputs: string[]) {
      yield inputs.map((text) => {
        const rank = Number(/rank(\d+)/.exec(text)?.[1] ?? 0);
        const v = new Array<number>(EMBEDDING_DIM).fill(0);
        v[0] = rank;
        return v;
      });
    },
  } as unknown as FlagEmbedding;
}

interface Seed {
  text: string;
  kind?: ChunkKind;
  page?: number;
  section?: string[];
}

/** Index chunks directly, bypassing the parser and chunker. */
function seed(documentId: string, chunks: readonly Seed[], status = "ready"): void {
  insertDocument(db, {
    id: documentId,
    title: documentId,
    sourcePath: `${documentId}.md`,
    format: "md",
    sha256: `sha-${documentId}`,
    engineUsed: "ts-fast",
    locatorScheme: "page",
    locatorCount: chunks.length,
    embeddingModel: EMBEDDING_MODEL_NAME,
    ingestWarning: null,
  });

  insertChunks(
    db,
    documentId,
    chunks.map((c, i) => {
      const rank = Number(/rank(\d+)/.exec(c.text)?.[1] ?? 0);
      const embedding = new Array<number>(EMBEDDING_DIM).fill(0);
      embedding[0] = rank;
      return {
        chunkId: `${documentId}-${i}`,
        seq: i,
        kind: c.kind ?? ("text" as ChunkKind),
        locator: { type: "page" as const, value: String(c.page ?? i + 1), ordinal: i },
        pageNumber: c.page ?? i + 1,
        sectionPath: c.section ?? [],
        bbox: null,
        text: c.text,
        tokenCount: 10,
        embedding,
      };
    }),
  );

  if (status === "ready") {
    finalizeDocument(db, documentId, {
      chunkCount: chunks.length,
      locatorCount: chunks.length,
      outlineJson: "[]",
    });
  }
}

const search = (q: Parameters<typeof hybridSearch>[2]) => hybridSearch(db, embedder, q);
const textsOf = (hits: { row: { text: string } }[]) => hits.map((h) => h.row.text);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-hybrid-"));
  db = openDatabase(path.join(dir, "document-index.db"), {
    embeddingModel: EMBEDDING_MODEL_NAME,
    embeddingDim: EMBEDDING_DIM,
  });
  embedder = new Embedder(dir, async () => rankedModel());
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a document still indexing is never searched", async () => {
  seed("done", [{ text: "badgers rank01" }]);
  seed("busy", [{ text: "badgers rank02" }], "processing");

  for (const mode of ["hybrid", "lexical", "semantic"] as const) {
    const hits = await search({ query: "badgers", k: 10, mode });
    assert.deepEqual(textsOf(hits), ["badgers rank01"], `${mode} returned a partial corpus`);
  }
});

test("document_id scopes both legs", async () => {
  seed("a", [{ text: "badgers rank01" }]);
  seed("b", [{ text: "badgers rank02" }]);

  const hits = await search({ query: "badgers", k: 10, mode: "hybrid", documentId: "b" });
  assert.deepEqual(textsOf(hits), ["badgers rank02"]);
});

test("fusion ranks a chunk both legs agree on above either leg's own best", async () => {
  // "badgers" is lexically present in all three; the vector leg orders by
  // rank. Only the first is high on both.
  seed("d", [
    { text: "badgers badgers badgers rank01" },
    { text: "badgers rank02" },
    { text: "unrelated prose rank03" },
  ]);

  const hits = await search({ query: "badgers", k: 3, mode: "hybrid" });
  assert.equal(hits[0]!.row.text, "badgers badgers badgers rank01");
  // Agreement still counts: this chunk is at the top of both legs and beats one
  // that leads only a single leg. What is no longer true is the stronger claim
  // this comment used to make — that a chunk found by one leg alone can never
  // outrank a chunk near the top of both. It can now, once the rank gap is wide
  // enough, and that change is what stopped hybrid scoring below its own
  // semantic leg. See DEFAULT_FUSION and the conviction test in hybrid.test.ts.
  assert.ok(hits[0]!.score > hits[1]!.score);
});

test("results are stable for a fixed query over a fixed corpus", async () => {
  seed("d", Array.from({ length: 12 }, (_, i) => ({ text: `badgers rank${String(i).padStart(2, "0")}` })));
  const once = textsOf(await search({ query: "badgers", k: 5, mode: "hybrid" }));
  const twice = textsOf(await search({ query: "badgers", k: 5, mode: "hybrid" }));
  assert.deepEqual(once, twice);
});

test("k is honoured, and fewer than k is returned rather than padded", async () => {
  seed("d", [{ text: "badgers rank01" }, { text: "badgers rank02" }]);
  assert.equal((await search({ query: "badgers", k: 1, mode: "hybrid" })).length, 1);
  assert.equal((await search({ query: "badgers", k: 50, mode: "hybrid" })).length, 2);
});

test("the kind filter survives a corpus where tables are rare", async () => {
  // The case POST_FILTER_OVERFETCH exists for: one table buried in prose that
  // matches the query just as well. The vector leg cannot filter on kind, so
  // without a wide net the table never reaches hydration.
  const chunks: Seed[] = Array.from({ length: 200 }, (_, i) => ({
    text: `sampling prose rank${String(i + 10).padStart(3, "0")}`,
  }));
  chunks.push({ text: "sampling table rank900", kind: "table" });
  seed("d", chunks);

  const hits = await search({
    query: "sampling",
    k: 5,
    mode: "hybrid",
    filter: { kind: "table" },
  });
  assert.deepEqual(textsOf(hits), ["sampling table rank900"]);
});

test("a section_prefix query does not starve the lexical leg", async () => {
  // The bug: section_prefix escalated the vector leg to 32x but left the
  // lexical leg at 2x — and the lexical leg cannot filter on section_prefix
  // either, because section_path is JSON. In lexical mode there is no vector
  // leg to compensate, so the wanted chunk has to come from the widened
  // lexical net or not at all.
  const chunks: Seed[] = Array.from({ length: 200 }, (_, i) => ({
    text: `sampling prose rank${String(i + 10).padStart(3, "0")}`,
    section: ["Part I"],
  }));
  chunks.push({ text: "sampling conclusion rank900", section: ["Part II"] });
  seed("d", chunks);

  const hits = await search({
    query: "sampling",
    k: 5,
    mode: "lexical",
    filter: { sectionPrefix: "Part II" },
  });
  assert.deepEqual(textsOf(hits), ["sampling conclusion rank900"]);
});

test("a page_range filter is pushed into the lexical leg", async () => {
  seed("d", [
    { text: "badgers rank01", page: 1 },
    { text: "badgers rank02", page: 50 },
    { text: "badgers rank03", page: 99 },
  ]);

  const hits = await search({
    query: "badgers",
    k: 10,
    mode: "hybrid",
    filter: { pageRange: [40, 60] },
  });
  assert.deepEqual(textsOf(hits), ["badgers rank02"]);
});

test("an empty corpus returns nothing rather than throwing", async () => {
  assert.deepEqual(await search({ query: "badgers", k: 10, mode: "hybrid" }), []);
});

test("a query with no usable terms returns nothing from the lexical leg", async () => {
  seed("d", [{ text: "badgers rank01" }]);
  assert.deepEqual(await search({ query: "!!! ???", k: 10, mode: "lexical" }), []);
});

test("every hit carries a snippet, from whichever leg found it", async () => {
  seed("d", [{ text: `badgers rank01 ${"padding ".repeat(80)}end` }]);

  const lexical = await search({ query: "badgers", k: 5, mode: "lexical" });
  assert.match(lexical[0]!.snippet, /badgers/);

  const semantic = await search({ query: "badgers", k: 5, mode: "semantic" });
  assert.ok(semantic[0]!.snippet.length > 0);
  assert.ok(semantic[0]!.snippet.length <= 400, "semantic snippet was not bounded");
});
