import { Mutex } from "async-mutex";

/**
 * Ported from obsidian-mcp/src/vault/locks.ts, keyed by document instead of
 * by note path.
 *
 * DEVIATION from the source spec, which specified `proper-lockfile`. This is
 * an in-process backstop and nothing more: it stops two ingests of the same
 * document inside ONE process from interleaving their chunk / FTS / vector
 * writes.
 *
 * It is not the cross-process defence, and an earlier version of this comment
 * claimed it was — "there is one server process; SQLite's WAL already handles
 * cross-process contention". Both halves were wrong. `pnpm ingest` is a second
 * process, Claude Desktop starts two servers per entry, and WAL prevents page
 * corruption while saying nothing about who owns an ingest. What carries
 * ownership across processes is the lease on the `documents` row
 * (`ingest/runner.ts`), claimed inside BEGIN IMMEDIATE and reaped only when
 * stale. See db/processLock.ts for the separate question of which process runs
 * startup recovery.
 */

const registry = new Map<string, Mutex>();

function mutexFor(key: string): Mutex {
  let m = registry.get(key);
  if (!m) {
    m = new Mutex();
    registry.set(key, m);
  }
  return m;
}

/**
 * Exclusive access to a single document. Different documents run concurrently,
 * so a bulk ingest of distinct files stays parallel.
 *
 * The registry is deliberately never pruned. The source document released the
 * lock and then deleted the mutex from the registry as "opportunistic GC",
 * which is a correctness race: another caller can take a reference to that
 * mutex between the release and the delete, after which a third caller finds
 * the key missing and constructs a *different* mutex for the same key. Two
 * writers then hold two different locks for one document and the lock is
 * defeated — in the one module whose entire purpose is preventing that.
 *
 * Unbounded growth is not a real cost here: one Mutex per document ever
 * ingested.
 */
export async function withDocumentLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await mutexFor(key).acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
