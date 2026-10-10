import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { moveAside, readOldIndex } from "./oldIndex.js";

/** What `pnpm reindex` carries over from the index it replaces, and how it gets that index out of the way. */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-reindex-"));
  dbPath = path.join(dir, "document-index.db");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An index of some earlier version: only the columns reindex reads. */
function oldIndex(rows: { title: string; source_path: string; ingest_status: string }[], version = "4"): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
           CREATE TABLE documents (title TEXT, source_path TEXT, ingest_status TEXT);`);
  db.prepare("INSERT INTO meta VALUES ('schema_version', ?)").run(version);
  const insert = db.prepare("INSERT INTO documents VALUES (?, ?, ?)");
  for (const r of rows) insert.run(r.title, r.source_path, r.ingest_status);
  db.close();
}

test("titles are read once per path, preferring the finished version", () => {
  oldIndex([
    { title: "Draft in flight", source_path: "a.md", ingest_status: "processing" },
    { title: "Chosen title", source_path: "a.md", ingest_status: "ready" },
    { title: "Only attempt", source_path: "b.pdf", ingest_status: "failed" },
  ]);
  const old = readOldIndex(dbPath);
  assert.equal(old.version, "4");
  assert.deepEqual(old.documents, [
    { title: "Chosen title", source_path: "a.md" },
    { title: "Only attempt", source_path: "b.pdf" },
  ]);
});

test("an index without a recorded version still yields its titles", () => {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
           CREATE TABLE documents (title TEXT, source_path TEXT, ingest_status TEXT);
           INSERT INTO documents VALUES ('T', 'x.md', 'ready');`);
  db.close();
  assert.deepEqual(readOldIndex(dbPath), { version: "unknown", documents: [{ title: "T", source_path: "x.md" }] });
});

test("the old index moves aside with its -wal and -shm, never over an earlier backup", () => {
  for (const suffix of ["", "-wal", "-shm"]) fs.writeFileSync(dbPath + suffix, `first${suffix}`);
  const first = moveAside(dbPath, "4");
  assert.equal(first, `${dbPath}.v4.bak`);
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.ok(!fs.existsSync(dbPath + suffix), `${suffix || "db"} was left behind`);
    assert.equal(fs.readFileSync(first + suffix, "utf8"), `first${suffix}`);
  }

  fs.writeFileSync(dbPath, "second");
  const second = moveAside(dbPath, "4", 1234);
  assert.equal(second, `${dbPath}.v4.1234.bak`);
  assert.equal(fs.readFileSync(first, "utf8"), "first", "the earlier backup was overwritten");
  assert.equal(fs.readFileSync(second, "utf8"), "second");
});
