import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failDocument, finalizeDocument, insertDocument } from "../db/documentsRepo.js";
import { openDatabase, type Db } from "../db/sqlite.js";
import { planSync } from "./syncPlan.js";

/** What `pnpm sync` decides to do, from stats alone, before any model or lock. */

const BGE = { embeddingModel: "fast-bge-small-en-v1.5", embeddingDim: 384 };

let root: string;
let db: Db;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-sync-"));
  db = openDatabase(path.join(root, ".document-index", "index.db"), BGE);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A document for a file as it is on disk now, in the given state. */
function indexed(rel: string, status: "ready" | "failed" | "processing"): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${rel}\n`);
  const st = fs.statSync(abs);
  const id = `01${rel.replace(/\W/g, "").toUpperCase().padEnd(24, "0")}`;
  insertDocument(db, {
    id,
    title: rel,
    sourcePath: rel,
    format: "md",
    sha256: id.padEnd(64, "0"),
    engineUsed: "ts-fast",
    locatorScheme: "section",
    locatorCount: 1,
    embeddingModel: BGE.embeddingModel,
    ingestWarning: null,
    sourceStat: { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) },
  });
  if (status === "ready") finalizeDocument(db, id, { chunkCount: 1, locatorCount: 1, outlineJson: "[]" });
  if (status === "failed") failDocument(db, id, "parser refused it");
  return id;
}

test("only changed, retryable, new and missing files are planned", () => {
  indexed("same.md", "ready");
  indexed("edited.md", "ready");
  indexed("gone.md", "ready");
  indexed("broken-unchanged.md", "failed");
  indexed("broken-fixed.md", "failed");
  indexed("busy.md", "processing");

  fs.appendFileSync(path.join(root, "edited.md"), "more\n");
  fs.appendFileSync(path.join(root, "broken-fixed.md"), "fixed\n");
  fs.appendFileSync(path.join(root, "busy.md"), "mid-edit\n");
  fs.rmSync(path.join(root, "gone.md"));
  fs.writeFileSync(path.join(root, "fresh.md"), "# new\n");

  const plan = planSync(db, root, [path.join(root, "same.md"), path.join(root, "fresh.md")]);
  assert.deepEqual(plan.changed.map((d) => d.source_path), ["edited.md"]);
  assert.deepEqual(plan.retry.map((d) => d.source_path), ["broken-fixed.md"]);
  assert.deepEqual(plan.missing.map((d) => d.source_path), ["gone.md"]);
  assert.deepEqual(plan.untracked, ["fresh.md"]);
});

test("a held path differing only in case is not new where the filesystem folds case", () => {
  indexed("Notes/Week1.md", "ready");
  const file = path.join(root, "notes", "week1.md");
  assert.deepEqual(planSync(db, root, [file], true).untracked, []);
  assert.deepEqual(planSync(db, root, [file], false).untracked, ["notes/week1.md"]);
});
