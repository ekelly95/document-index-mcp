import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStaleAtPath, insertDocument } from "./documentsRepo.js";
import { indexCounts, insertChunks } from "./chunksRepo.js";
import { openDatabase, type Db } from "./sqlite.js";

const BGE = { embeddingModel: "fast-bge-small-en-v1.5", embeddingDim: 384 };

function freshDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-repo-"));
  return openDatabase(path.join(dir, "index.db"), BGE);
}

function addDoc(db: Db, id: string, sourcePath: string, sha: string): void {
  insertDocument(db, {
    id,
    title: id,
    sourcePath,
    format: "md",
    sha256: sha,
    engineUsed: "ts-fast",
    locatorScheme: "section",
    locatorCount: 1,
    embeddingModel: BGE.embeddingModel,
    ingestWarning: null,
  });
}

test("a path differing only in case is the same file only where the filesystem says so", () => {
  const db = freshDb();
  try {
    addDoc(db, "01UPPER", "Notes.md", "a".repeat(64));
    const sensitive = findStaleAtPath(db, "notes.md", "b".repeat(64), false);
    assert.deepEqual(sensitive, [], "a different file was named stale on a case-sensitive filesystem");
    const insensitive = findStaleAtPath(db, "notes.md", "b".repeat(64), true);
    assert.deepEqual(insensitive.map((d) => d.id), ["01UPPER"]);
  } finally {
    db.close();
  }
});

test("indexCounts sees FTS rows that are missing, not the content table", () => {
  const db = freshDb();
  try {
    addDoc(db, "01DOC", "doc.md", "c".repeat(64));
    insertChunks(db, "01DOC", [
      {
        chunkId: "01CHUNK",
        seq: 0,
        kind: "text",
        locator: { type: "section", value: "sec-0", ordinal: 0 },
        pageNumber: null,
        sectionPath: [],
        bbox: null,
        text: "a passage about badgers",
        tokenCount: 6,
        embedding: new Array<number>(384).fill(0.01),
      },
    ]);
    assert.deepEqual(indexCounts(db), { chunks: 1, fts: 1, vectors: 1 });

    const row = db.prepare("SELECT id, text FROM document_chunks").get() as { id: number; text: string };
    db.prepare("INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', ?, ?)").run(row.id, row.text);
    assert.equal(indexCounts(db).fts, 0, "a lost FTS row went unnoticed");
  } finally {
    db.close();
  }
});
