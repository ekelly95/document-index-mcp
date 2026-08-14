import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeResolve, assertRealPathInside, PathTraversalError } from "./paths.js";

/**
 * Ported from obsidian-mcp/src/vault/paths.test.ts. The containment cases are
 * unchanged — they are the ones that matter and they were already right. Only
 * the extension cases differ, because a library takes seven formats rather
 * than just .md.
 */

const NUL = String.fromCharCode(0);

let tmp: string;
let library: string;
let sibling: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-paths-"));
  library = path.join(tmp, "library");
  // A sibling sharing the "library" prefix — the case that defeats a naive
  // resolved.startsWith(base) containment check.
  sibling = path.join(tmp, "library-secrets");
  await fs.mkdir(path.join(library, "sub"), { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(library, "ok.md"), "# ok\n");
  await fs.writeFile(path.join(sibling, "secret.md"), "# secret\n");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("accepts a document at the library root", () => {
  assert.equal(safeResolve(library, "ok.md"), path.join(library, "ok.md"));
});

test("accepts a nested document and normalises separators", () => {
  assert.equal(
    safeResolve(library, "sub/paper.pdf"),
    path.join(library, "sub", "paper.pdf"),
  );
});

test("accepts every supported extension", () => {
  for (const ext of [".pdf", ".docx", ".doc", ".md", ".markdown", ".html", ".htm", ".txt"]) {
    assert.doesNotThrow(() => safeResolve(library, `doc${ext}`), `rejected ${ext}`);
  }
});

test("the formats this build does not read are refused at the gate", () => {
  // .ppt sits with them: it was only ever admitted so the router could point at
  // a .pptx conversion, and there is no longer a slide format to convert to.
  for (const ext of [".epub", ".pptx", ".ppt"]) {
    assert.throws(() => safeResolve(library, `doc${ext}`), /Unsupported file type/, `accepted ${ext}`);
  }
});

test("accepts uppercase extensions (Windows is case-insensitive)", () => {
  assert.doesNotThrow(() => safeResolve(library, "Book.PDF"));
});

for (const [label, input] of [
  ["parent traversal", "../library-secrets/secret.md"],
  ["deep traversal", "sub/../../library-secrets/secret.md"],
  ["empty path", ""],
  ["the library root itself", "."],
  ["an unsupported extension", "notes.exe"],
  ["a dotfile with no extension", ".env"],
  ["no extension at all", "README"],
] as const) {
  test(`rejects ${label}`, () => {
    assert.throws(() => safeResolve(library, input), PathTraversalError);
  });
}

test("rejects a NUL byte", () => {
  assert.throws(() => safeResolve(library, `ok${NUL}.md`), PathTraversalError);
});

test("rejects an absolute path pointing at a prefix-sibling directory", () => {
  // <tmp>/library-secrets shares the "<tmp>/library" prefix. A startsWith-based
  // containment check would let this through; path.relative does not.
  assert.throws(
    () => safeResolve(library, path.join(sibling, "secret.md")),
    PathTraversalError,
  );
});

test("rejects an absolute path elsewhere on disk", () => {
  assert.throws(
    () => safeResolve(library, path.join(os.tmpdir(), "elsewhere.md")),
    PathTraversalError,
  );
});

test("assertRealPathInside allows a genuine in-library file", async () => {
  await assert.doesNotReject(
    assertRealPathInside(library, path.join(library, "ok.md")),
  );
});

test("assertRealPathInside rejects a symlink escaping the library", async (t) => {
  const link = path.join(library, "escape.md");
  try {
    await fs.symlink(path.join(sibling, "secret.md"), link, "file");
  } catch {
    // Symlink creation needs elevation or Developer Mode on Windows.
    t.skip("cannot create symlinks in this environment");
    return;
  }
  // The lexical check passes: the link itself sits inside the library.
  assert.doesNotThrow(() => safeResolve(library, "escape.md"));
  // The realpath check is what catches it.
  await assert.rejects(assertRealPathInside(library, link), PathTraversalError);
});
