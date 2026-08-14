import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No source file may carry a raw control character.
 *
 * Several separators in this codebase are control characters on purpose,
 * because a heading or a path can never contain one and so two different trails
 * can never collide into the same key. Written as escapes they are invisible
 * and harmless. Written as a raw byte, a single NUL makes every binary-sniffing
 * tool treat the whole file as binary: git stops diffing it, ripgrep skips it,
 * and repomix drops it from a pack without saying so.
 *
 * docs/gotchas.md has prescribed this check for a while and nobody wrote it,
 * which is exactly why it regressed twice — first chunker.ts, outline.ts and
 * pdfFast.ts, then ocrPool.ts on its own. A rule nothing enforces is a rule
 * that comes back.
 */

// This test runs compiled, out of dist/, which tsc keeps as an exact mirror of
// src/ because tsconfig sets rootDir. So the repository root is one level up
// from the directory holding this file — true of dist/ at runtime and of src/
// in an editor, which is what makes the path safe to hard-code.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// Prose is excluded on purpose. "Write it as an escape instead" is always
// available in TypeScript and JavaScript; in Markdown it is not, so widening
// this to docs/ would invite a failure with no legal fix.
const TREES = [
  { dir: "src", extensions: [".ts"] },
  { dir: "scripts", extensions: [".mjs"] },
];

const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function walk(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

function violations(file: string): string[] {
  // A Buffer, never a decoded string: decoding is what hides the byte being
  // hunted, and reading these files as text is how the last one survived
  // review.
  const bytes = fs.readFileSync(file);
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  const found: string[] = [];
  let line = 1;
  let column = 1;

  for (const byte of bytes) {
    if (byte === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }
    if (byte < 0x20 && !ALLOWED.has(byte)) {
      const hex = byte.toString(16).padStart(2, "0");
      found.push(`${relative}:${line}:${column} (0x${hex})`);
    }
    column += 1;
  }

  return found;
}

test("no source file carries a raw control character", () => {
  const files = TREES.flatMap(({ dir, extensions }) => {
    const root = path.join(repoRoot, dir);
    assert.ok(
      fs.existsSync(root),
      `source tree not found at ${root}. The dist layout changed and this test is scanning nothing.`,
    );
    return walk(root, extensions);
  });

  // A scan of the wrong directory finds nothing and passes, which is the one
  // way this test could lie. Assert the walk arrived somewhere real before
  // trusting a clean result.
  assert.ok(
    files.length > 40,
    `only ${files.length} files scanned; the walk is not reaching the source tree`,
  );

  const found = files.flatMap(violations);
  assert.deepEqual(
    found,
    [],
    [
      "raw control characters found in source. Write them as escapes instead —",
      "the escape compiles to an identical string. See docs/gotchas.md.",
      ...found.map((v) => `  ${v}`),
    ].join("\n"),
  );
});
