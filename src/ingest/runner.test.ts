import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FlagEmbedding } from "fastembed";
import { loadConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { openDatabase, type Db } from "../db/sqlite.js";
import { NO_LOCK } from "../db/processLock.js";
import { indexCounts } from "../db/chunksRepo.js";
import {
  INGEST_LEASE_MS,
  LEASE_RENEW_INTERVAL_MS,
  ingestLeaseIsLive,
  insertDocument,
  recoverInterrupted,
  renewLease,
  type DocumentRow,
} from "../db/documentsRepo.js";
import {
  Embedder,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_NAME,
  type InitEmbedding,
} from "../embeddings/embedder.js";
import { hybridSearch } from "../retrieval/hybrid.js";
import { createIngestQueue, type IngestQueue } from "./queue.js";
import { beginIngest, drainIngests, resumeIngests } from "./runner.js";

/**
 * Ingest lifecycle, driven directly rather than over MCP.
 *
 * The point of this file is failure. `tools.test.ts` proves that a SUCCESSFUL
 * re-ingest of an edited file replaces the version it supersedes; nothing
 * proved what happened when the replacement failed halfway, which is the case
 * that used to destroy the only copy the library had.
 *
 * The embedder is stubbed, so no model is downloaded and no ONNX runs — and
 * stubbing it is also the only way to make embedding fail on demand, which is
 * the most realistic mid-ingest failure there is (the real one downloads
 * ~130MB from Google Cloud Storage on first use).
 */

/** A deterministic unit-ish vector of the width vec_chunks actually declares. */
const VECTOR = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 7) / 10);

/**
 * A model that works for `failAfterBatches` calls and then throws.
 *
 * Failing on a LATER batch rather than the first is deliberate: it leaves the
 * doomed ingest with chunks, FTS rows and vectors already committed, so the
 * test covers cleanup of partial state as well as survival of the predecessor.
 */
function stubInit(failAfterBatches = Infinity): InitEmbedding {
  let calls = 0;
  const model = {
    async *embed(inputs: string[]) {
      if (calls++ >= failAfterBatches) {
        throw new Error("embedding backend went away");
      }
      yield inputs.map(() => VECTOR);
    },
  } as unknown as FlagEmbedding;
  return async () => model;
}

/**
 * A model that lets `passBatches` batches through and then blocks until
 * released, so a document can be held in 'processing' for as long as a test
 * needs to look at it.
 */
/**
 * `release` lets the writer carry on. `abandon` fails it where it stands.
 *
 * Both exist because a test that parks a writer has to settle it somehow before
 * the file ends, and for a writer whose state has already been reclaimed,
 * letting it carry on is not an option — that is the corruption the lease
 * exists to prevent. Failing the gate settles the promise without resuming
 * anything.
 */
function gatedInit(passBatches = 0): {
  init: InitEmbedding;
  release: () => void;
  abandon: () => void;
} {
  let release!: () => void;
  let abandon!: () => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    abandon = () => reject(new Error("the test abandoned this ingest at the gate"));
  });
  // A handler so failing a gate nothing is waiting on cannot become an
  // unhandled rejection; the awaiting `embed` below still sees the throw.
  gate.catch(() => {});
  let calls = 0;
  const model = {
    async *embed(inputs: string[]) {
      if (calls++ >= passBatches) await gate;
      yield inputs.map(() => VECTOR);
    },
  } as unknown as FlagEmbedding;
  return { init: async () => model, release, abandon };
}

/**
 * Block until a document has committed at least `atLeast` chunks.
 *
 * Needed because a parser reads its source lazily — `parse()` is an async
 * generator whose body does not run until the chunker pulls the first block —
 * so a test that rewrites the file too early races the read it is trying to
 * set up. Committed chunks are the observable proof that the source was
 * consumed. (That laziness is the same window bug 4.3 describes; this waits it
 * out rather than pretending it is not there.)
 */
async function waitForChunks(documentId: string, atLeast: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (rowsOf(documentId) < atLeast) {
    assert.ok(Date.now() < deadline, `${documentId} never reached ${atLeast} chunks`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let library: string;
let db: Db;
let queue: IngestQueue;
let baseConfig: ReturnType<typeof loadConfig>;

/**
 * A context sharing the one database, with an embedder of the caller's choosing.
 *
 * Built by hand rather than through `createContext`, which would also take the
 * exclusive index lock — these tests deliberately run several "processes"
 * worth of contexts against one database, and the lock is covered on its own
 * in `db/processLock.test.ts`.
 */
function contextWith(init: InitEmbedding): AppContext {
  return {
    config: baseConfig,
    db,
    embedder: new Embedder(baseConfig.modelCacheDir, init),
    // One queue per test, shared by every context that test builds — the
    // production shape, where several callers contend for one process-wide
    // budget. Fresh each test so a deliberately parked ingest cannot hold a
    // slot into the next one.
    queue,
    lock: NO_LOCK,
    // These contexts stand in for separate processes, which is exactly the case
    // where only one of them would hold the lock.
    primary: false,
  };
}

/** Enough sections to need more than one embedding batch (BATCH_SIZE is 64). */
function draft(claim: string): string {
  const sections = Array.from({ length: 80 }, (_, i) =>
    [`## Section ${i + 1}`, "", `${claim} Numbered paragraph ${i + 1}.`, ""].join("\n"),
  );
  return `# Draft\n\n${sections.join("\n")}`;
}

const rowsOf = (documentId: string): number =>
  (db
    .prepare("SELECT count(*) AS c FROM document_chunks WHERE document_id = ?")
    .get(documentId) as { c: number }).c;

// Ordered by id, not created_at: ULIDs sort by creation time and are unique,
// where two rows written in the same millisecond would tie on created_at.
const docsAtPath = (sourcePath: string): { id: string; ingest_status: string }[] =>
  db
    .prepare("SELECT id, ingest_status FROM documents WHERE source_path = ? ORDER BY id")
    .all(sourcePath) as { id: string; ingest_status: string }[];

async function lexicalHits(query: string): Promise<string[]> {
  const hits = await hybridSearch(db, contextWith(stubInit()).embedder, {
    query,
    k: 20,
    mode: "lexical",
  });
  return [...new Set(hits.map((h) => h.row.document_id))];
}

beforeEach(async () => {
  library = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-runner-"));
  baseConfig = loadConfig([`--library=${library}`, `--models=${path.join(library, "models")}`]);
  db = openDatabase(baseConfig.dbPath, {
    embeddingModel: EMBEDDING_MODEL_NAME,
    embeddingDim: EMBEDDING_DIM,
  });
  queue = createIngestQueue();
});

afterEach(async () => {
  db.close();
  await fs.rm(library, { recursive: true, force: true });
});

test("shutdown waits for an in-flight ingest instead of discarding it", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));

  const gate = gatedInit(1);
  const running = await beginIngest(contextWith(gate.init), "draft.md");
  await waitForChunks(running.documentId, 64);

  // Drain must not return while the document is still going. Before this, the
  // signal handler called process.exit(0) here and every chunk was discarded:
  // the row stayed 'processing' and the next startup cleared it.
  let drained = false;
  const drain = drainIngests(5_000).then((n) => {
    drained = true;
    return n;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(drained, false, "shutdown abandoned a live ingest");

  gate.release();
  assert.equal(await drain, 0, "drain reported work left over");

  const row = db
    .prepare("SELECT ingest_status FROM documents WHERE id = ?")
    .get(running.documentId) as { ingest_status: string };
  assert.equal(row.ingest_status, "ready", "the ingest did not get to finish");

  resumeIngests();
});

test("shutdown gives up rather than hanging, and says what it left", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));

  // Never released: a document that will not reach a safe point in time.
  const gate = gatedInit(1);
  const stuck = await beginIngest(contextWith(gate.init), "draft.md");
  await waitForChunks(stuck.documentId, 64);

  assert.equal(await drainIngests(100), 1, "a stuck ingest was not reported as abandoned");

  // It keeps its 'processing' row with an unrenewed lease, which is exactly
  // what recovery reclaims on the next start.
  const row = db
    .prepare("SELECT ingest_status FROM documents WHERE id = ?")
    .get(stuck.documentId) as { ingest_status: string };
  assert.equal(row.ingest_status, "processing");
  assert.equal(recoverInterrupted(db, Date.now() + INGEST_LEASE_MS + 1), 1);

  resumeIngests();
  // Failed rather than released, and awaited: see `gatedInit`. A gate left
  // parked is a promise that never settles, and node's test runner then reports
  // "Promise resolution is still pending but the event loop has already
  // resolved" and cancels every test after it in this file.
  gate.abandon();
  await stuck.done.catch(() => {});
});

test("no new ingest is accepted once shutdown has begun", async () => {
  await fs.writeFile(path.join(library, "draft.md"), draft("Badgers."));
  await drainIngests(100);
  await assert.rejects(
    beginIngest(contextWith(stubInit()), "draft.md"),
    /shutting down/,
    "a new document was admitted during shutdown",
  );
  resumeIngests();
});

test("recovery reclaims an abandoned ingest but never a live one", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));

  const gate = gatedInit(1);
  const stalled = await beginIngest(contextWith(gate.init), "draft.md");
  await waitForChunks(stalled.documentId, 64);

  // A live writer renews its lease on every batch, so a sweep running now must
  // leave it completely alone. Before the lease existed this deleted the
  // writer's committed chunks and marked its document failed, while the writer
  // carried on and finalised it as 'ready' with a chunk_count that no longer
  // matched the table.
  assert.equal(recoverInterrupted(db), 0, "a live ingest was reaped");
  assert.equal(rowsOf(stalled.documentId), 64, "a live ingest lost its chunks");

  // And a second caller stands off rather than trampling it.
  assert.equal((await beginIngest(contextWith(stubInit()), "draft.md")).outcome, "joined");

  // The same row, judged a lease-length later, is abandoned.
  assert.equal(recoverInterrupted(db, Date.now() + INGEST_LEASE_MS + 1), 1);
  assert.equal(rowsOf(stalled.documentId), 0, "an abandoned ingest kept its chunks");

  // The gate is deliberately never RELEASED: letting the writer resume after
  // its state has been reclaimed is the corruption this whole change exists to
  // prevent, and there is nothing to learn from staging it here.
  //
  // It is still failed and awaited, though. This used to say that a parked
  // promise holds no handle and so does not keep the test process alive, which
  // is true and beside the point — node's test runner notices the pending
  // promise anyway, reports "Promise resolution is still pending but the event
  // loop has already resolved", and cancels every test after it in this file.
  // Nine of them, in CI, on every platform, while the file passed locally.
  gate.abandon();
  await stalled.done.catch(() => {});
});

test("a lease renewal touches only a live claim", () => {
  insertDocument(db, {
    id: "01RENEW",
    title: "Held",
    sourcePath: "held.md",
    format: "md",
    sha256: "c".repeat(64),
    engineUsed: "ts-fast",
    locatorScheme: "section",
    locatorCount: 1,
    embeddingModel: EMBEDDING_MODEL_NAME,
    ingestWarning: null,
  });
  const backdate = () =>
    db
      .prepare("UPDATE documents SET updated_at = ? WHERE id = '01RENEW'")
      .run(new Date(Date.now() - INGEST_LEASE_MS - 1000).toISOString());
  const row = () =>
    db.prepare("SELECT * FROM documents WHERE id = '01RENEW'").get() as DocumentRow;

  backdate();
  assert.equal(ingestLeaseIsLive(row()), false);
  renewLease(db, "01RENEW");
  assert.equal(ingestLeaseIsLive(row()), true, "a processing claim was not renewed");

  // Once the claim is gone there is nothing to renew: a timer that outlives
  // its ingest must not resurrect the lease of a finished or failed document.
  db.prepare("UPDATE documents SET ingest_status = 'ready' WHERE id = '01RENEW'").run();
  backdate();
  const before = row().updated_at;
  renewLease(db, "01RENEW");
  assert.equal(row().updated_at, before, "a settled document's lease was renewed");
});

test("a slow ingest renews its lease between batches", async (t) => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));

  // Only setInterval is mocked: the polling helpers below use setTimeout and
  // must keep running on real time.
  t.mock.timers.enable({ apis: ["setInterval"] });

  const gate = gatedInit(1);
  const stalled = await beginIngest(contextWith(gate.init), "draft.md");
  await waitForChunks(stalled.documentId, 64);

  // Simulate a batch that takes longer than the whole lease — OCR territory.
  // Progress-based renewal alone would let this live writer be reaped and its
  // document handed to a second writer.
  db.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - INGEST_LEASE_MS - 1000).toISOString(),
    stalled.documentId,
  );
  const row = () =>
    db.prepare("SELECT * FROM documents WHERE id = ?").get(stalled.documentId) as DocumentRow;
  assert.equal(ingestLeaseIsLive(row()), false, "backdating did not expire the lease");

  t.mock.timers.tick(LEASE_RENEW_INTERVAL_MS + 1);
  assert.equal(ingestLeaseIsLive(row()), true, "the renewal timer did not fire");
  assert.equal(recoverInterrupted(db), 0, "a renewed ingest was still reaped");

  gate.release();
  await stalled.done;
  assert.equal(row().ingest_status, "ready");

  // After finalisation the interval is cleared; further ticks change nothing.
  const settled = row().updated_at;
  t.mock.timers.tick(LEASE_RENEW_INTERVAL_MS + 1);
  assert.equal(row().updated_at, settled, "a finished ingest's timer kept firing");
});

test("an ingest whose lease has expired can be taken over, not joined forever", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));
  const first = await beginIngest(contextWith(stubInit()), "draft.md");
  await first.done;

  // What a killed process leaves behind: chunks on disk and a row still
  // claiming to be working on them. Written directly rather than by stalling a
  // real ingest, because a live in-process writer would still hold that
  // document's mutex — the one thing a crashed process does NOT leave behind.
  db.prepare(
    "UPDATE documents SET ingest_status = 'processing', updated_at = ? WHERE id = ?",
  ).run(new Date(Date.now() - INGEST_LEASE_MS - 1000).toISOString(), first.documentId);

  // 'processing' with an expired lease means nothing, so the next caller must
  // be able to take the document over. Without this, one crash would make that
  // file permanently un-ingestable: every retry would politely "join" an
  // ingest that is never going to progress.
  const takenOver = await beginIngest(contextWith(stubInit()), "draft.md");
  assert.equal(takenOver.outcome, "started", "an abandoned claim still blocked its own file");
  assert.equal(takenOver.documentId, first.documentId, "takeover should reuse the row");
  await takenOver.done;

  const row = db
    .prepare("SELECT ingest_status FROM documents WHERE id = ?")
    .get(first.documentId) as { ingest_status: string };
  assert.equal(row.ingest_status, "ready");
  assert.deepEqual(await lexicalHits("starlight"), [first.documentId]);

  const counts = indexCounts(db);
  assert.equal(counts.fts, counts.chunks, "takeover left FTS orphans");
  assert.equal(counts.vectors, counts.chunks, "takeover left vector orphans");
});

test("a replacement that fails mid-index leaves the previous version searchable", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));

  const first = await beginIngest(contextWith(stubInit()), "draft.md");
  await first.done;
  const originalChunks = rowsOf(first.documentId);
  assert.ok(originalChunks > 64, "fixture must span more than one embedding batch");

  // The edit. Same path, new bytes, therefore a new sha and a new document.
  await fs.writeFile(file, draft("Badgers navigate by scent gradients."));

  const second = await beginIngest(contextWith(stubInit(1)), "draft.md");
  assert.equal(second.outcome, "started");
  assert.notEqual(second.documentId, first.documentId);
  await assert.rejects(second.done, /embedding backend went away/);

  // The whole point: the old version is untouched and still answering.
  const original = db
    .prepare("SELECT ingest_status, chunk_count FROM documents WHERE id = ?")
    .get(first.documentId) as { ingest_status: string; chunk_count: number } | undefined;
  assert.ok(original, "the previous version was deleted by a failed replacement");
  assert.equal(original.ingest_status, "ready");
  assert.equal(rowsOf(first.documentId), originalChunks, "the previous version lost chunks");
  assert.deepEqual(await lexicalHits("starlight"), [first.documentId]);

  // The failed attempt is recorded, and left nothing behind but its row.
  const failed = db
    .prepare("SELECT ingest_status, error_message FROM documents WHERE id = ?")
    .get(second.documentId) as { ingest_status: string; error_message: string | null };
  assert.equal(failed.ingest_status, "failed");
  assert.match(failed.error_message ?? "", /embedding backend went away/);
  assert.equal(rowsOf(second.documentId), 0, "the failed attempt kept its partial chunks");

  const counts = indexCounts(db);
  assert.equal(counts.fts, counts.chunks, "the failed attempt left FTS orphans");
  assert.equal(counts.vectors, counts.chunks, "the failed attempt left vector orphans");

  // Two rows at one path is the correct interim state: one live, one diagnosis.
  assert.deepEqual(
    docsAtPath("draft.md").map((d) => d.ingest_status),
    ["ready", "failed"],
  );
});

test("retrying after a failed replacement supersedes the old version", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));
  const first = await beginIngest(contextWith(stubInit()), "draft.md");
  await first.done;

  await fs.writeFile(file, draft("Badgers navigate by scent gradients."));
  await assert.rejects((await beginIngest(contextWith(stubInit(1)), "draft.md")).done);

  // Same bytes, working embedder. This takes the restartIngest path — the sha
  // is already known and failed — and must still evict the predecessor.
  const retry = await beginIngest(contextWith(stubInit()), "draft.md");
  assert.equal(retry.outcome, "started");
  await retry.done;

  assert.deepEqual(
    docsAtPath("draft.md").map((d) => d.ingest_status),
    ["ready"],
    "the retry did not evict the superseded version",
  );
  assert.equal(
    db.prepare("SELECT id FROM documents WHERE id = ?").get(first.documentId),
    undefined,
    "the superseded document is still present",
  );
  assert.deepEqual(await lexicalHits("starlight"), []);
  assert.deepEqual(await lexicalHits("gradients"), [retry.documentId]);

  const counts = indexCounts(db);
  assert.equal(counts.fts, counts.chunks);
  assert.equal(counts.vectors, counts.chunks);
});

test("one ready plus one processing is the legal interim state for a path", async () => {
  // Distinctive nouns, not "version one/two": the lexical leg ORs its terms,
  // so a word shared by every revision matches all of them and proves nothing.
  const file = path.join(library, "draft.md");
  await fs.writeFile(file, draft("Badgers navigate by starlight."));
  const first = await beginIngest(contextWith(stubInit()), "draft.md");
  await first.done;

  // Hold a replacement open, so the path legitimately carries a 'ready' row
  // and a 'processing' row at the same time. Deferred superseding is what
  // makes that state legal; before it, version one was already deleted here.
  await fs.writeFile(file, draft("Badgers navigate by scent gradients."));
  // Let the first batch through, then block: the replacement now holds real,
  // committed chunks while still 'processing', which is the state search has
  // to be able to ignore.
  const gate = gatedInit(1);
  const stalled = await beginIngest(contextWith(gate.init), "draft.md");
  assert.equal(stalled.outcome, "started");
  await waitForChunks(stalled.documentId, 64);

  assert.deepEqual(
    docsAtPath("draft.md").map((d) => d.ingest_status),
    ["ready", "processing"],
  );
  // ...and the old version is still the one answering, because search covers
  // only 'ready' — even though the replacement has 64 chunks in the index.
  assert.deepEqual(await lexicalHits("starlight"), [first.documentId]);
  assert.deepEqual(await lexicalHits("gradients"), [], "a processing document was searched");

  // A THIRD version cannot be admitted: it has no way to know which of the two
  // it supersedes. Safe to rewrite the file now — waitForChunks above proved
  // the stalled ingest has already consumed its own source.
  await fs.writeFile(file, draft("Badgers navigate by echolocation."));
  await assert.rejects(
    beginIngest(contextWith(stubInit()), "draft.md"),
    /still indexing/,
    "a third version was admitted while a replacement was in flight",
  );

  gate.release();
  await stalled.done;

  assert.deepEqual(
    docsAtPath("draft.md").map((d) => d.ingest_status),
    ["ready"],
    "finalising the replacement did not evict its predecessor",
  );
  assert.deepEqual(await lexicalHits("starlight"), []);
  assert.deepEqual(await lexicalHits("gradients"), [stalled.documentId]);
});
