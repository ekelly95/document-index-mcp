import type { ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db/sqlite.js";
import {
  acquireIndexLock,
  NO_LOCK,
  tryAcquireIndexLock,
  type IndexLock,
} from "./db/processLock.js";
import { createIngestQueue, type IngestQueue } from "./ingest/queue.js";
import { recoverInterrupted } from "./db/documentsRepo.js";
import { log } from "./log.js";
import { redactPathsInReplies } from "./tools/result.js";
import {
  Embedder,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_NAME,
} from "./embeddings/embedder.js";

/** Everything the tools and the CLI both need. Built once per process. */
export interface AppContext {
  config: ServerConfig;
  db: Db;
  embedder: Embedder;
  /** Bounds how many documents index at once. See `ingest/queue.ts`. */
  queue: IngestQueue;
  /** Released on shutdown. See `db/processLock.ts` for why it exists. */
  lock: IndexLock;
  /**
   * Did this process take the index lock?
   *
   * Only the holder runs startup recovery. A peer that did not take it is a
   * fully capable server otherwise — same database, same tools, same writes.
   */
  primary: boolean;
}

export interface ContextOptions {
  /**
   * Refuse to start without the index lock, instead of carrying on as a peer.
   *
   * The bulk CLI sets this and the server does not. Both are safe to run
   * alongside another writer — the lease sees to that — but a bulk run and an
   * interactive server contending for one machine is a fight nobody asked for,
   * and the CLI is the one that should give way.
   */
  requireIndexLock?: boolean;
  /**
   * An embedder supplied instead of the real thing.
   *
   * Only for tests. `Embedder` already accepts an injectable `InitEmbedding` so
   * the retry path can be tested without a network, but that seam was
   * unreachable through here — `createContext` constructed its own — which is
   * the whole reason the end-to-end suite loads the real 130MB ONNX model and
   * `hybridSearch` had no direct tests at all.
   */
  embedder?: Embedder;
}

export function createContext(
  config: ServerConfig,
  overrides: ContextOptions = {},
): AppContext {
  // First of all, and before anything can fail: an error thrown below is
  // reported by the caller, and its message carries these paths.
  redactPathsInReplies([
    { path: config.libraryRoot, as: "<library>" },
    { path: config.dbPath, as: "<index>" },
    { path: config.modelCacheDir, as: "<models>" },
  ]);

  // Before the database is even opened, and — for the server — non-fatally: a
  // host that starts two processes per server, as Claude Desktop does, makes
  // losing this race routine rather than exceptional. The loser is a peer, not
  // a failure. What the lock still decides is who runs the recovery sweep below,
  // and whether a caller that demanded it may proceed at all.
  const lock = overrides.requireIndexLock
    ? acquireIndexLock(config.dbPath)
    : tryAcquireIndexLock(config.dbPath);

  let db: Db;
  try {
    db = openDatabase(config.dbPath, {
      embeddingModel: EMBEDDING_MODEL_NAME,
      embeddingDim: EMBEDDING_DIM,
    });
  } catch (err) {
    // openDatabase refuses an index built by a different model or schema
    // version. Holding the lock afterwards would leave a file the caller has
    // just been told to delete looking like it is in use.
    lock?.release();
    throw err;
  }

  // A document left 'processing' whose lease has expired has no writer any
  // more — the process that owned it is gone. Its partial chunks would
  // otherwise keep answering searches as though the document were complete.
  //
  // This also releases the ingest claim: 'processing' is what marks a document
  // as owned (see beginIngest), so a row left behind by a crash would refuse
  // every future ingest of that file until it was cleared.
  //
  // Only the lock holder sweeps. The lease makes a second sweep harmless rather
  // than dangerous — it reclaims nothing a live writer is touching — but two
  // peers racing to reap the same rows is still work nobody needs, and pinning
  // it to the holder keeps exactly one process answerable for it.
  if (lock) {
    const recovered = recoverInterrupted(db);
    // warn rather than info: this discarded partially-written chunks.
    if (recovered > 0) log.warn(`reset ${recovered} interrupted ingest(s) to failed`);
  }

  return {
    config,
    db,
    embedder: overrides.embedder ?? new Embedder(config.modelCacheDir),
    queue: createIngestQueue(config.ingestConcurrency),
    lock: lock ?? NO_LOCK,
    primary: lock !== null,
  };
}
