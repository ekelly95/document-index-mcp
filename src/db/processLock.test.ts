import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireIndexLock, IndexLockedError, tryAcquireIndexLock } from "./processLock.js";

/**
 * The lock that keeps `pnpm ingest` out while a server is running, and picks
 * which server process runs startup recovery.
 *
 * Both entry points are covered here because they answer the same question
 * differently on purpose: the CLI throws without the lock, the server carries on
 * without it as a peer.
 *
 * No database is involved: the lock guards a path, and deliberately does not
 * require the file it names to exist yet.
 */

let dir: string;
let dbPath: string;
let lockPath: string;

/** A pid that is definitely not running: spawn a process and let it exit. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid, "could not spawn a process to harvest a dead pid");
  return child.pid;
}

const writeLock = (contents: string): void => fs.writeFileSync(lockPath, contents);

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-lock-"));
  dbPath = path.join(dir, "document-index.db");
  lockPath = `${dbPath}.lock`;
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test("acquiring records this process and creates the lock file", () => {
  const lock = acquireIndexLock(dbPath);
  const held = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
  assert.equal(held.pid, process.pid);
  lock.release();
});

test("a second acquire is refused while the first is held", () => {
  const lock = acquireIndexLock(dbPath);
  assert.throws(
    () => acquireIndexLock(dbPath),
    (err: unknown) => err instanceof IndexLockedError && /already open in process/.test(String(err)),
  );
  lock.release();
});

test("the error names the owning process so it can be found and quit", () => {
  const lock = acquireIndexLock(dbPath);
  try {
    acquireIndexLock(dbPath);
    assert.fail("expected the second acquire to be refused");
  } catch (err) {
    assert.match(String(err), new RegExp(`process ${process.pid}\\b`));
    assert.match(String(err), /delete .*\.lock/);
  }
  lock.release();
});

test("releasing frees the index for the next process", () => {
  acquireIndexLock(dbPath).release();
  assert.equal(fs.existsSync(lockPath), false, "release left the lock file behind");
  acquireIndexLock(dbPath).release();
});

test("release is idempotent", () => {
  const lock = acquireIndexLock(dbPath);
  lock.release();
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("a lock abandoned by a crashed process is reclaimed", () => {
  writeLock(JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
  const lock = acquireIndexLock(dbPath);
  const held = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
  assert.equal(held.pid, process.pid, "the abandoned lock was not taken over");
  lock.release();
});

test("an unreadable lock file is treated as abandoned, not as a wedge", () => {
  // A half-written lock from a crash mid-write. Refusing to start because a
  // file cannot be parsed would make the server unrecoverable without manual
  // cleanup, for a file that carries no information worth honouring.
  for (const junk of ["", "{", "not json at all", "{}", '{"pid":"nonsense"}']) {
    writeLock(junk);
    const lock = acquireIndexLock(dbPath);
    lock.release();
  }
});

test("a lock its owner has released is reclaimed even though that owner is alive", () => {
  // The outage this exists for: a server drained, closed its database,
  // released and logged "stopped" — then failed to actually exit, because a
  // native addon's teardown deadlocked. Its release could not delete the file,
  // so the lock kept naming a pid that answered "alive" forever and every
  // restart after it was refused, recoverable only by deleting the file by
  // hand. process.pid is used here precisely because it is certainly running.
  writeLock(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), released: true }),
  );

  const lock = acquireIndexLock(dbPath);
  const held = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number; released?: boolean };
  assert.equal(held.pid, process.pid);
  assert.notEqual(held.released, true, "the fresh lock inherited the released flag");
  lock.release();
});

test("a live owner that has NOT released is still honoured", () => {
  // The other direction, so the flag cannot become a way to trample a running
  // server: same pid, same file, no flag.
  writeLock(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.throws(
    () => acquireIndexLock(dbPath),
    (err: unknown) => err instanceof IndexLockedError,
  );
});

test("release clears a lock whose contents have become unreadable", () => {
  // Same reasoning as the acquire side: a lock nobody can parse carries no
  // information worth honouring, and leaving it behind wedges the next start.
  const lock = acquireIndexLock(dbPath);
  writeLock("{ truncated mid-write");
  lock.release();
  assert.equal(fs.existsSync(lockPath), false, "an unreadable lock survived its owner's release");
});

test("releasing does not unlock an index that now belongs to someone else", () => {
  const lock = acquireIndexLock(dbPath);
  // Simulate this process having crashed, the lock having been reclaimed, and
  // a late release arriving afterwards. It must not evict the new owner.
  const other = { pid: process.pid + 100000, startedAt: new Date().toISOString() };
  writeLock(JSON.stringify(other));

  lock.release();

  const stillThere = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
  assert.equal(stillThere.pid, other.pid, "a stale release unlocked another owner's index");
});

test("the same held lock refuses the CLI and merely declines a peer", () => {
  // The divergence the server depends on. Claude Desktop starts two processes
  // per MCP server, so the second one asking must get an answer it can live
  // with, while `pnpm ingest` asking must still be stopped.
  const lock = acquireIndexLock(dbPath);
  assert.throws(() => acquireIndexLock(dbPath), IndexLockedError);
  assert.equal(tryAcquireIndexLock(dbPath), null);
  lock.release();
});

test("a peer takes the lock when it is going", () => {
  const lock = tryAcquireIndexLock(dbPath);
  assert.ok(lock, "the lock was free and should have been taken");
  const held = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
  assert.equal(held.pid, process.pid);
  lock.release();
});

test("a peer reclaims a lock nobody is using", () => {
  // Both abandonment signals the throwing path honours, so declining to throw
  // cannot quietly become declining to reclaim: whoever starts first should end
  // up holding a lock left behind by a crash or by a failed delete.
  for (const abandoned of [
    { pid: deadPid(), startedAt: new Date().toISOString() },
    { pid: process.pid, startedAt: new Date().toISOString(), released: true },
  ]) {
    writeLock(JSON.stringify(abandoned));
    const lock = tryAcquireIndexLock(dbPath);
    assert.ok(lock, "an abandoned lock was not reclaimed");
    const held = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
    assert.equal(held.pid, process.pid);
    lock.release();
  }
});
