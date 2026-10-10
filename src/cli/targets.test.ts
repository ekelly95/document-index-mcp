import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTargets, walk } from "./targets.js";

/** What `pnpm ingest` decides to look at, before any model or lock is involved. */

let root: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-targets-"));
  const files: Record<string, string> = {
    "a.md": "# A",
    "notes.txt": "n",
    "image.png": "not a document",
    ".hidden.md": "# hidden file",
    ".obsidian/workspace.md": "# editor state",
    "sub/b.pdf": "%PDF",
    "sub/deeper/c.docx": "PK",
  };
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const rel = (files: readonly string[]) =>
  files.map((f) => path.relative(root, f).split(path.sep).join("/")).sort();

test("a recursive walk finds supported files and skips dot-entries", async () => {
  const { files, resolved } = await resolveTargets(root, ["."], true, () => {});
  assert.equal(resolved, 1);
  assert.deepEqual(rel(files), ["a.md", "notes.txt", "sub/b.pdf", "sub/deeper/c.docx"]);
});

test("without --recursive only the folder's own files are taken", async () => {
  const { files } = await resolveTargets(root, ["."], false, () => {});
  assert.deepEqual(rel(files), ["a.md", "notes.txt"]);
});

test("a named file is taken as given, and a missing target is reported", async () => {
  const warnings: string[] = [];
  const { files, resolved } = await resolveTargets(root, ["sub/b.pdf", "nope.md"], false, (m) =>
    warnings.push(m),
  );
  assert.equal(resolved, 1);
  assert.deepEqual(rel(files), ["sub/b.pdf"]);
  assert.deepEqual(warnings, ["skip (not found): nope.md"]);
});

test("when no target exists, nothing resolves", async () => {
  // The CLI exits 2 on this rather than reporting "0 file(s)" as success.
  const { files, resolved } = await resolveTargets(root, ["typo", "also-typo"], true, () => {});
  assert.equal(resolved, 0);
  assert.deepEqual(files, []);
});

test("a folder that cannot be read is reported, not silently skipped", async () => {
  const warnings: string[] = [];
  // A file where a folder is expected fails readdir on every platform.
  const found: string[] = [];
  for await (const f of walk(path.join(root, "a.md"), true, (m) => warnings.push(m))) found.push(f);
  assert.deepEqual(found, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^skip \(unreadable\): .*a\.md — E[A-Z]+$/);
});
