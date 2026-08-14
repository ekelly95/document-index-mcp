import fs from "node:fs";
import path from "node:path";

/**
 * Who owns startup recovery for an index, and who may bulk-write it.
 *
 * Two kinds of process open the same database: the MCP server (`src/index.ts`)
 * and the bulk CLI (`src/cli/ingest.ts`). Running `pnpm ingest` while the server
 * was mid-index used to delete the server's committed chunks and vectors and
 * flip its row to 'failed'. The server never noticed: it holds an in-process
 * mutex that means nothing to another process, kept inserting from whatever
 * `seq` it had reached, and finished by calling `finalizeDocument` — publishing
 * a document as 'ready' with a `chunk_count` that no longer matched the rows in
 * the table. A silently incomplete book, indistinguishable from a complete one,
 * with no error anywhere.
 *
 * SQLite's WAL prevents corruption at the page level. It has nothing to say
 * about which process owns an ingest.
 *
 * What answers that now is the per-document lease (`INGEST_LEASE_MS` in
 * `db/documentsRepo.ts`). `recoverInterrupted` reclaims only rows nobody has
 * touched in five minutes, and `claimForIngest` runs in a BEGIN IMMEDIATE
 * transaction whose first branch leaves a live claim strictly alone. Both are
 * atomic across processes. This file never was.
 *
 * So the lock no longer decides who may open the index. It decides two narrower
 * things:
 *
 *   - Its holder runs startup recovery. Reaping abandoned ingests is one
 *     process's job and the holder is a fair way to pick one.
 *   - The bulk CLI still refuses to start without it — because a bulk run and an
 *     interactive server writing at once is a resource fight nobody asked for,
 *     not because it would corrupt anything.
 *
 * A server that cannot take it runs anyway, as a peer. Claude Desktop starts two
 * processes for every MCP server it is given, so refusing the second one killed
 * it on every single launch.
 *
 * The lock is advisory and deliberately simple: a file beside the database
 * holding the owner's pid, created with O_EXCL so creation is the atomic
 * operation. A lock whose owner is no longer running is reclaimed, so a crash
 * does not need manual cleanup. This is not a defence against a hostile local
 * user — nothing at this layer is.
 *
 * The pid alone is not quite enough to decide, which cost a real outage. A
 * process can outlive its own shutdown: one server drained, closed its
 * database, released, logged "stopped" and called process.exit(0) — and was
 * still there hours later, idle, because a native addon's teardown deadlocked.
 * Its release had left the file behind, and the pid in that file answered
 * "alive" forever, so every restart the host attempted was refused with no way
 * out but deleting the file by hand. Hence `released`: a lock its owner has
 * finished with is reclaimable whether or not that owner has managed to die.
 */

export class IndexLockedError extends Error {
  override readonly name = "IndexLockedError";
}

export interface IndexLock {
  /** Idempotent, and safe to call from an `exit` handler. */
  release(): void;
}

interface LockFile {
  pid: number;
  startedAt: string;
  /**
   * The owner is done with this index and will never write to it again. Set
   * only when `release` could not delete the file, as a second way of saying
   * what the file's absence would have said.
   */
  released: boolean;
}

const lockPathFor = (dbPath: string): string => `${dbPath}.lock`;

/**
 * Is a process with this pid still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to another user, which
 * counts as alive — refusing to steal a lock we cannot prove is dead is the
 * safe direction to be wrong in.
 */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(lockPath: string): LockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, startedAt, released } = parsed as Partial<LockFile>;
    if (typeof pid !== "number") return null;
    return {
      pid,
      startedAt: typeof startedAt === "string" ? startedAt : "unknown",
      released: released === true,
    };
  } catch {
    // Missing, truncated, or not JSON. A lock we cannot read is a lock we
    // cannot honour; treat it as abandoned rather than wedging the server on
    // a corrupt file it has no way to interpret.
    return null;
  }
}

type LockAttempt =
  | { readonly outcome: "acquired"; readonly lock: IndexLock }
  | { readonly outcome: "held"; readonly message: string };

/**
 * The single implementation both public entry points are built from, so the
 * decision about who holds the lock cannot drift from the explanation of it.
 */
function attemptIndexLock(dbPath: string): LockAttempt {
  const lockPath = lockPathFor(dbPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const write = (): boolean => {
    let fd: number;
    try {
      // "wx" is O_CREAT | O_EXCL: the create either happens or it does not,
      // with no window between checking and writing.
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      const contents: LockFile = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        released: false,
      };
      fs.writeFileSync(fd, JSON.stringify(contents));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };

  if (!write()) {
    const held = readLock(lockPath);
    if (held && !held.released && isRunning(held.pid)) {
      return {
        outcome: "held",
        message:
          `The index at ${dbPath} is already open in process ${held.pid} (since ${held.startedAt}). ` +
          `A bulk ingest needs the index to itself. Quit that process and try again. If you ` +
          `are certain it is gone, delete ${lockPath}.`,
      };
    }

    // The owner is gone, or has finished with the index and could not delete
    // its own lock, so this file is a leftover either way. Removing and
    // re-creating rather than overwriting keeps O_EXCL as the arbiter: if
    // another process is reclaiming at the same instant, exactly one of us
    // wins the create and the other reports the lock as held.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Someone else reclaimed it first; the create below will say so.
    }
    if (!write()) {
      const winner = readLock(lockPath);
      return {
        outcome: "held",
        message:
          `The index at ${dbPath} was claimed by process ${winner?.pid ?? "unknown"} while this ` +
          `one was reclaiming an abandoned lock.`,
      };
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);

    // Never evict a lock that names somebody else: a release arriving late —
    // after a reclaim and a restart — must not unlock the index out from under
    // whoever owns it now. A lock that cannot be READ is a different matter;
    // `acquireIndexLock` already treats one as abandoned, so leaving it in
    // place would only wedge the next start.
    const held = readLock(lockPath);
    if (held && held.pid !== process.pid) return;

    try {
      fs.unlinkSync(lockPath);
      return;
    } catch {
      // Already gone, the directory was removed (routine in tests), or the
      // delete was refused — on Windows anything holding the file open, from
      // a backup agent to a search indexer, is enough to refuse it.
    }

    // The file survived, still naming a pid that may well answer "alive", so
    // say in the file what deleting it would have said. A write is a different
    // syscall with different permissions and may land where the delete did not.
    try {
      if (fs.existsSync(lockPath)) {
        const contents: LockFile = {
          pid: process.pid,
          startedAt: held?.startedAt ?? "unknown",
          released: true,
        };
        fs.writeFileSync(lockPath, JSON.stringify(contents));
      }
    } catch {
      // Nothing further to try. The pid check stays the backstop, and the
      // error message tells the user which file to delete.
    }
  };

  // A crash that skips shutdown leaves the file behind; the pid check above
  // reclaims it next time. This handler just makes the common case tidy.
  process.on("exit", release);
  return { outcome: "acquired", lock: { release } };
}

/**
 * Take the index lock if it is going, and report plainly if it is not.
 *
 * For the MCP server, which must start either way: holding the lock means this
 * process runs startup recovery, and not holding it means a sibling already is.
 * Neither answer stops it serving.
 */
export function tryAcquireIndexLock(dbPath: string): IndexLock | null {
  const attempt = attemptIndexLock(dbPath);
  return attempt.outcome === "acquired" ? attempt.lock : null;
}

/**
 * Take the index lock, or refuse to continue without it.
 *
 * For the bulk CLI, which wants the index to itself.
 *
 * @throws IndexLockedError if a live process already owns it.
 */
export function acquireIndexLock(dbPath: string): IndexLock {
  const attempt = attemptIndexLock(dbPath);
  if (attempt.outcome === "held") throw new IndexLockedError(attempt.message);
  return attempt.lock;
}

/** For a process that did not take the lock and must not release anyone else's. */
export const NO_LOCK: IndexLock = { release: () => {} };
