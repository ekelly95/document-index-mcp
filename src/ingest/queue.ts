import { Semaphore } from "async-mutex";

/**
 * How many documents may be indexed at once, across the whole process.
 *
 * `withDocumentLock` prevents two writers for the SAME document. It says
 * nothing about different ones, and nothing did: `ingest_document` returns
 * immediately and indexes in the background, so a client that calls it for six
 * papers starts six concurrent indexing runs. Each holds its own file buffer
 * and its own pdfjs document, and all six drive the same single-threaded ONNX
 * model and the same single SQLite writer. They do not go faster than one
 * would; they contend for CPU, multiply peak memory by six, and lengthen every
 * individual ingest.
 *
 * The bulk CLI never had this problem because it awaits each document in turn.
 * The default here makes the MCP path behave the same way, deliberately: for
 * CPU-bound embedding on one machine, serial IS the fast configuration, and
 * fire-and-forget already means nobody is waiting on a response.
 *
 * Raise it with --ingest-concurrency=N or DOCUMENT_INDEX_INGEST_CONCURRENCY if a
 * future engine can genuinely use the parallelism.
 */
export const DEFAULT_INGEST_CONCURRENCY = 1;

export interface IngestQueue {
  /** Run `fn` once a slot is free. Queued work is FIFO. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Documents indexing right now. */
  active(): number;
  /** Documents admitted but not yet started. */
  waiting(): number;
}

export function createIngestQueue(concurrency = DEFAULT_INGEST_CONCURRENCY): IngestQueue {
  const limit = Math.max(1, Math.floor(concurrency));
  const semaphore = new Semaphore(limit);
  let active = 0;
  let waiting = 0;

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      waiting++;
      const [, release] = await semaphore.acquire();
      waiting--;
      active++;
      try {
        return await fn();
      } finally {
        active--;
        release();
      }
    },
    active: () => active,
    waiting: () => waiting,
  };
}
