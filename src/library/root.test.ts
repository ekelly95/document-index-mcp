import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeDocument, getDocument, insertDocument } from "../db/documentsRepo.js";
import { getMeta, openDatabase, type Db } from "../db/sqlite.js";
import { checkLibraryRoot, rebaseLibrary } from "./root.js";

/** Telling a moved library from a different one, and moving an index between roots. */

const BGE = { embeddingModel: "fast-bge-small-en-v1.5", embeddingDim: 384 };

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-root-")));
  db = openDatabase(path.join(dir, "index.db"), BGE);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(rel: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "# x\n");
}

function doc(id: string, sourcePath: string): void {
  insertDocument(db, {
    id,
    title: id,
    sourcePath,
    format: "md",
    sha256: id.padEnd(64, "0"),
    engineUsed: "ts-fast",
    locatorScheme: "section",
    locatorCount: 1,
    embeddingModel: BGE.embeddingModel,
    ingestWarning: null,
  });
  finalizeDocument(db, id, { chunkCount: 1, locatorCount: 1, outlineJson: "[]" });
}

test("the first root is recorded, and the same root again is quiet", () => {
  const root = path.join(dir, "lib");
  assert.equal(checkLibraryRoot(db, root).status, "recorded");
  assert.equal(getMeta(db, "library_root"), root);
  assert.equal(checkLibraryRoot(db, root).status, "same");
});

test("a library moved whole is adopted; a different folder is flagged and left alone", () => {
  const before = path.join(dir, "old-lib");
  checkLibraryRoot(db, before);
  doc("01A", "NCSF/a.md");

  // The same tree now lives elsewhere: relative paths still resolve.
  file("new-lib/NCSF/a.md");
  const moved = path.join(dir, "new-lib");
  assert.equal(checkLibraryRoot(db, moved).status, "moved");
  assert.equal(getMeta(db, "library_root"), moved);

  // Pointed one level up instead: "NCSF/a.md" names nothing there.
  const parent = dir;
  const check = checkLibraryRoot(db, parent);
  assert.equal(check.status, "mismatch");
  assert.match(check.status === "mismatch" ? check.message : "", /pnpm rebase/);
  assert.equal(getMeta(db, "library_root"), moved, "a mismatch must not overwrite the recorded root");
});

test("rebase re-expresses every path against the new root", () => {
  const oldRoot = path.join(dir, "lib");
  doc("01A", "NCSF/a.md");
  doc("01B", "Papers/b.md");
  const result = rebaseLibrary(db, oldRoot, dir);
  assert.deepEqual(result, { rebased: 2, outside: [] });
  assert.equal(getDocument(db, "01A")!.source_path, "lib/NCSF/a.md");
  assert.equal(getMeta(db, "library_root"), dir);

  // And back down into a subfolder that holds everything.
  const back = rebaseLibrary(db, dir, oldRoot);
  assert.equal(back.rebased, 2);
  assert.equal(getDocument(db, "01B")!.source_path, "Papers/b.md");
});

test("rebase refuses, changing nothing, when any document falls outside the new root", () => {
  const oldRoot = path.join(dir, "lib");
  doc("01A", "NCSF/a.md");
  doc("01B", "Papers/b.md");
  const result = rebaseLibrary(db, oldRoot, path.join(oldRoot, "NCSF"));
  assert.deepEqual(result, { rebased: 0, outside: ["Papers/b.md"] });
  assert.equal(getDocument(db, "01A")!.source_path, "NCSF/a.md", "a refused rebase changed a path");
});
