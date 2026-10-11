import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { moveAside, readOldCitations, readOldIndex, tombstonesAfterRebuild } from "./oldIndex.js";

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

test("a rebuild keeps reused chunk ids live and tombstones the rest", () => {
  const at = "2026-10-11T00:00:00.000Z";
  const citations = {
    chunks: [
      { chunk_id: "c-kept", document_id: "d1", seq: 0, locator_type: "section", locator_value: "sec-1", page_number: null, printed_label: null, text_hash: "h" },
      { chunk_id: "c-changed", document_id: "d1", seq: 1, locator_type: "section", locator_value: "sec-2", page_number: null, printed_label: null, text_hash: "h" },
      { chunk_id: "c-lost", document_id: "d2", seq: 0, locator_type: "page", locator_value: "1", page_number: 1, printed_label: null, text_hash: "h" },
    ],
    supersededDocuments: [
      { id: "d0", title: "Older", source_path: "a.md", replaced_by: "d1", reason: "edited" as const, superseded_at: at },
    ],
    supersededChunks: [
      { chunk_id: "c-ancient", document_id: "d0", seq: 0, locator_type: "section" as const, locator_value: "sec-1", page_number: null, printed_label: null, replaced_by: "d1", reason: "edited" as const, superseded_at: at },
    ],
  };
  const documents = [
    { id: "d1", title: "A", source_path: "a.md" },
    { id: "d2", title: "B", source_path: "b.pdf" },
  ];
  const out = tombstonesAfterRebuild(
    citations,
    documents,
    new Map([["d1", "d1"], ["d2", null]]),
    new Set(["c-kept"]),
    at,
  );

  assert.deepEqual(out.chunks.map((c) => [c.chunk_id, c.replaced_by, c.reason]), [
    ["c-ancient", "d1", "edited"],
    ["c-changed", "d1", "reindexed"],
    ["c-lost", null, "reindexed"],
  ]);
  // d1 kept its id and is live, so only the failed d2 needs explaining.
  assert.deepEqual(out.documents.map((d) => [d.id, d.replaced_by, d.reason]), [
    ["d0", "d1", "edited"],
    ["d2", null, "reindexed"],
  ]);
});

test("an index too old to hold chunk ids yields no citations", () => {
  oldIndex([{ title: "T", source_path: "x.md", ingest_status: "ready" }]);
  assert.deepEqual(readOldCitations(dbPath), { chunks: [], supersededDocuments: [], supersededChunks: [] });
});
