import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FlagEmbedding } from "fastembed";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { INGEST_LEASE_MS, insertDocument, listProcessing } from "./db/documentsRepo.js";
import { IndexLockedError } from "./db/processLock.js";
import { Embedder, EMBEDDING_DIM, EMBEDDING_MODEL_NAME } from "./embeddings/embedder.js";

/**
 * What `createContext` wires together, and in what order.
 *
 * It had no tests. It is also where the server asks for the index lock, so the
 * ordering it establishes — lock before database, release if the database is
 * refused — is worth pinning, along with what it does when the answer is no.
 */

let library: string;
const contexts: { db: { close: () => void }; lock: { release: () => void } }[] = [];

const configFor = (lib: string) =>
  loadConfig([`--library=${lib}`, `--models=${path.join(lib, "models")}`]);

function track<T extends { db: { close: () => void }; lock: { release: () => void } }>(ctx: T): T {
  contexts.push(ctx);
  return ctx;
}

beforeEach(async () => {
  library = await fsp.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-context-"));
});

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      ctx.db.close();
    } catch {
      // Already closed by the test.
    }
    ctx.lock.release();
  }
  await fsp.rm(library, { recursive: true, force: true });
});

test("a supplied embedder is used instead of loading the real model", async () => {
  // The seam that makes a fast test tier possible at all. Embedder already
  // accepted an injectable init, but createContext built its own, so anything
  // going through it pulled the 130MB ONNX model down.
  const vector = new Array<number>(EMBEDDING_DIM).fill(0.5);
  const stub = new Embedder(
    library,
    async () =>
      ({
        async *embed(inputs: string[]) {
          yield inputs.map(() => vector);
        },
      }) as unknown as FlagEmbedding,
  );

  const ctx = track(createContext(configFor(library), { embedder: stub }));
  assert.equal(ctx.embedder, stub);
  assert.deepEqual(await ctx.embedder.embedQuery("anything"), vector);
});

test("the real embedder is still the default", () => {
  const ctx = track(createContext(configFor(library)));
  assert.ok(ctx.embedder instanceof Embedder);
});

test("the index lock is taken, and a second context runs as a peer", () => {
  const ctx = track(createContext(configFor(library)));
  assert.ok(fs.existsSync(`${ctx.config.dbPath}.lock`), "no lock file was created");
  assert.equal(ctx.primary, true);

  // Claude Desktop starts two processes for every MCP server it is given. The
  // second one used to throw here, which killed that whole connection.
  const peer = track(createContext(configFor(library)));
  assert.equal(peer.primary, false, "the second context should not hold the lock");
  assert.ok(
    fs.existsSync(`${ctx.config.dbPath}.lock`),
    "the peer removed the holder's lock file",
  );
});

test("a refused index does not stay locked", async () => {
  // openDatabase rejects an index built by a different embedding model, and
  // tells the caller to delete the file. Holding the lock afterwards would
  // leave that file looking like it was in use.
  const config = configFor(library);

  // Build an index that records a DIFFERENT model, so this build's expectation
  // is the thing that gets refused.
  const { openDatabase } = await import("./db/sqlite.js");
  const foreign = openDatabase(config.dbPath, {
    embeddingModel: "some-other-384d-model",
    embeddingDim: EMBEDDING_DIM,
  });
  foreign.close();

  assert.throws(() => createContext(config), /embedding model/);
  assert.equal(
    fs.existsSync(`${config.dbPath}.lock`),
    false,
    "a refused index was left locked",
  );
});

test("a caller that requires the lock is still refused when it cannot have it", () => {
  // The bulk CLI reaches the lock through createContext rather than taking it
  // itself, so relaxing the server's acquire silently relaxed the CLI's too and
  // `pnpm ingest` started running against a live server. This is that regression.
  const holder = track(createContext(configFor(library)));
  assert.equal(holder.primary, true);
  assert.throws(
    () => createContext(configFor(library), { requireIndexLock: true }),
    IndexLockedError,
  );
});

test("only the lock holder sweeps abandoned ingests", () => {
  const config = configFor(library);
  const holder = track(createContext(config));

  // A document left 'processing' by a writer that is long gone: old enough that
  // its lease has expired, so recovery is entitled to reclaim it.
  insertDocument(holder.db, {
    id: "doc-abandoned",
    title: "Abandoned",
    sourcePath: path.join(library, "abandoned.md"),
    format: "md",
    sha256: "a".repeat(64),
    engineUsed: "ts-fast",
    locatorScheme: "section",
    locatorCount: 1,
    embeddingModel: EMBEDDING_MODEL_NAME,
    ingestWarning: null,
  });
  holder.db
    .prepare("UPDATE documents SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - INGEST_LEASE_MS - 60_000).toISOString(), "doc-abandoned");

  // A peer starting while the holder is up must leave the sweep alone, even
  // though the lease says the row is fair game.
  const peer = track(createContext(config));
  assert.equal(peer.primary, false);
  assert.equal(listProcessing(peer.db).length, 1, "a peer swept a row it does not own");

  // The holder goes; whoever starts next inherits both the lock and the sweep.
  peer.db.close();
  holder.db.close();
  holder.lock.release();

  const successor = track(createContext(config));
  assert.equal(successor.primary, true, "the lock was not free after its holder released");
  assert.equal(listProcessing(successor.db).length, 0, "the lock holder did not sweep");
});

test("the ingest queue is built from the configured concurrency", () => {
  const ctx = track(
    createContext(loadConfig([`--library=${library}`, "--ingest-concurrency=3"])),
  );
  assert.equal(ctx.config.ingestConcurrency, 3);
  assert.equal(ctx.queue.active(), 0);
  assert.equal(ctx.queue.waiting(), 0);
});
