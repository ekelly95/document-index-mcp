import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { insertDocument } from "./documentsRepo.js";
import { IncompatibleIndexError, openDatabase, setMeta } from "./sqlite.js";

/**
 * The guard the `meta` table's comment has always promised: an index built by
 * a different embedding model must be detectable rather than silently mixed.
 * Two 384-dimension models produce vectors of the same shape that mean
 * different things, so the only symptom of mixing them is worse answers.
 */

const BGE = { embeddingModel: "fast-bge-small-en-v1.5", embeddingDim: 384 };
const OTHER = { embeddingModel: "some-other-384d-model", embeddingDim: 384 };

function tempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-db-"));
  return path.join(dir, `${name}.db`);
}

test("a fresh index records the model it was built with", () => {
  const db = openDatabase(tempDbPath("fresh"), BGE);
  try {
    assert.equal(
      (db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get() as
        | { value: string }
        | undefined)?.value,
      BGE.embeddingModel,
    );
  } finally {
    db.close();
  }
});

test("reopening with the same model is fine", () => {
  const dbPath = tempDbPath("same");
  openDatabase(dbPath, BGE).close();
  const again = openDatabase(dbPath, BGE);
  again.close();
});

test("reopening with a different embedding model is refused", () => {
  const dbPath = tempDbPath("swapped");
  openDatabase(dbPath, BGE).close();

  assert.throws(
    () => openDatabase(dbPath, OTHER),
    (err: unknown) =>
      err instanceof IncompatibleIndexError &&
      err.message.includes(dbPath) &&
      err.message.includes(BGE.embeddingModel),
  );

  // The refusal must not leave the file locked: the user has just been told to
  // delete it, and an open WAL handle would stop them.
  fs.rmSync(dbPath);
});

test("a mismatched schema version is refused", () => {
  const dbPath = tempDbPath("version");
  const db = openDatabase(dbPath, BGE);
  setMeta(db, "schema_version", "99");
  db.close();

  assert.throws(
    () => openDatabase(dbPath, BGE),
    (err: unknown) => err instanceof IncompatibleIndexError && err.message.includes("99"),
  );
});

test("a document indexed by the OCR engine is accepted", () => {
  const db = openDatabase(tempDbPath("ocr-engine"), BGE);
  try {
    insertDocument(db, {
      id: "01TSOCR",
      title: "A scanned book",
      sourcePath: "scan.pdf",
      format: "pdf",
      sha256: "b".repeat(64),
      engineUsed: "ts-ocr",
      locatorScheme: "page",
      locatorCount: 12,
      embeddingModel: BGE.embeddingModel,
      ingestWarning: null,
    });
    assert.equal(
      (db.prepare("SELECT engine_used FROM documents WHERE id = '01TSOCR'").get() as {
        engine_used: string;
      }).engine_used,
      "ts-ocr",
    );
  } finally {
    db.close();
  }
});

test("an index predating the check adopts the model its documents record", () => {
  const dbPath = tempDbPath("legacy");
  const db = openDatabase(dbPath, BGE);
  insertDocument(db, {
    id: "01LEGACY",
    title: "Indexed before meta was written",
    sourcePath: "legacy.md",
    format: "md",
    sha256: "a".repeat(64),
    engineUsed: "ts-fast",
    locatorScheme: "section",
    locatorCount: 1,
    embeddingModel: OTHER.embeddingModel,
    ingestWarning: null,
  });
  // Simulate the old openDatabase, which stamped only the schema version.
  db.prepare("DELETE FROM meta WHERE key IN ('embedding_model', 'embedding_dim')").run();
  db.close();

  // The vectors in that file came from OTHER, so opening as BGE must refuse
  // rather than assume the current model is what built them.
  assert.throws(
    () => openDatabase(dbPath, BGE),
    (err: unknown) =>
      err instanceof IncompatibleIndexError && err.message.includes(OTHER.embeddingModel),
  );

  const reopened = openDatabase(dbPath, OTHER);
  reopened.close();
});
