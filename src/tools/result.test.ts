import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { describeFsError, fail, redactPathsInReplies } from "./result.js";

/**
 * The library root is given a name a reply would obviously be wrong to carry,
 * so a failure reads as a leak rather than as a string mismatch.
 */
const root = path.resolve("/tmp/library-of-edmunds-private-notes");
const dbPath = path.join(root, ".document-index", "document-index.db");

function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  assert.ok(first && first.type === "text", "a failure result should carry text");
  return first.text;
}

test("an unmapped fs error cannot carry the library path out", () => {
  redactPathsInReplies([
    { path: root, as: "<library>" },
    { path: dbPath, as: "<index>" },
  ]);

  // ELOOP is the reachable one: a symlink loop inside the library makes
  // assertRealPathInside swallow its realpath failure and hand back the path
  // unchanged, and openSource's readFile then throws this. It is not in
  // describeFsError's table, so before `fail` scrubbed, this went out whole.
  const err = Object.assign(
    new Error(`ELOOP: too many symbolic links, open '${path.join(root, "diary", "loop.md")}'`),
    { code: "ELOOP" },
  );

  const text = textOf(fail(`ingest_document failed: ${describeFsError(err, "diary/loop.md")}`));
  assert.ok(!text.includes(root), `the library root leaked: ${text}`);
  assert.match(text, /<library>/);
  // The diagnosis has to survive: scrubbing must not turn a usable error into
  // a mystery, which is the failure mode that makes people remove the scrub.
  assert.match(text, /ELOOP/);
});

test("the more specific path wins when one contains the other", () => {
  redactPathsInReplies([
    { path: root, as: "<library>" },
    { path: dbPath, as: "<index>" },
  ]);

  const text = textOf(fail(`database is locked: ${dbPath}`));
  assert.match(text, /<index>/);
  assert.ok(!text.includes("<library>"), `the shorter path was substituted first: ${text}`);
});

test("a mapped error still echoes only what the caller passed", () => {
  redactPathsInReplies([{ path: root, as: "<library>" }]);
  const err = Object.assign(
    new Error(`ENOENT: no such file or directory, open '${path.join(root, "nope.pdf")}'`),
    { code: "ENOENT" },
  );
  assert.equal(describeFsError(err, "nope.pdf"), "Not found in the library: nope.pdf");
});

test(
  "casing does not defeat the scrub",
  { skip: process.platform === "win32" ? false : "Windows-only: paths are case-sensitive elsewhere" },
  () => {
    // config.libraryRoot is path.resolve'd and keeps what the host config
    // typed; the path inside an fs error comes from realpath and carries the
    // on-disk casing. The same directory, spelled two ways.
    redactPathsInReplies([{ path: root, as: "<library>" }]);
    const text = textOf(fail(`open '${root.toUpperCase()}\\Diary\\A.md'`));
    assert.ok(
      !text.toLowerCase().includes(root.toLowerCase()),
      `a differently-cased spelling of the root leaked: ${text}`,
    );
  },
);
