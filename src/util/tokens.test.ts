import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  splitCode,
  splitList,
  splitProse,
  splitTable,
  takeLastTokens,
} from "./tokens.js";

/**
 * The splitters, which were reachable only through the chunker.
 *
 * They matter more than their size suggests: they run exactly when a block is
 * already over budget, which is the case a test corpus of tidy fixtures rarely
 * produces and a real 800-page book produces constantly. Each one has a
 * structural promise — a table fragment stays a valid table, a code fragment
 * stays fenced, a list never splits mid-bullet — and those promises are what a
 * reader sees when `get_chunk_context` hands back a fragment.
 */

const MAX = 40;
const over = (parts: readonly string[], max = MAX) =>
  parts.filter((p) => estimateTokens(p) > max);

test("token estimation counts CJK glyphs individually and Latin by length", () => {
  // chars/4 underestimates CJK by roughly 4x, which would let a chunk of
  // Japanese sail past the model's real limit.
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("日本語"), 3);
  assert.equal(estimateTokens(""), 0);
  // Mixed: four Latin characters plus three CJK.
  assert.equal(estimateTokens("abcd日本語"), 4);
});

test("takeLastTokens never begins mid-word", () => {
  const text = "The quick brown fox jumps over the lazy dog and keeps on running for a while.";
  const tail = takeLastTokens(text, 5);
  assert.ok(text.endsWith(tail));
  assert.ok(tail.length < text.length);
  // The whole point: the fragment must start at a boundary, not inside a word.
  assert.ok(/^[A-Za-z]/.test(tail));
  assert.ok(text.includes(` ${tail}`) || text.includes(`. ${tail}`), tail);
});

test("takeLastTokens returns short text untouched", () => {
  assert.equal(takeLastTokens("Short.", 100), "Short.");
});

test("prose splits at sentence boundaries and every part fits", () => {
  const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} says something.`).join(" ");
  const parts = splitProse(text, MAX);

  assert.ok(parts.length > 1, "nothing was split");
  assert.deepEqual(over(parts), [], "a part exceeded the budget");
  // Nothing lost: every sentence survives somewhere.
  const joined = parts.join(" ");
  for (let i = 0; i < 20; i++) assert.ok(joined.includes(`Sentence number ${i}`), `lost sentence ${i}`);
});

test("a single sentence over budget falls back to word boundaries", () => {
  // No terminal punctuation anywhere — common in tables rendered as prose, and
  // the case where a sentence splitter alone would return one oversized part.
  const text = "word ".repeat(200).trim();
  const parts = splitProse(text, MAX);

  assert.ok(parts.length > 1);
  assert.deepEqual(over(parts), []);
  assert.ok(parts.every((p) => !p.startsWith(" ") && !p.endsWith(" ")));
});

test("prose that already fits is returned as one part, unchanged", () => {
  assert.deepEqual(splitProse("Short enough.", MAX), ["Short enough."]);
});

test("a list splits between items, never inside one", () => {
  const text = Array.from({ length: 30 }, (_, i) => `- item ${i} with some words in it`).join("\n");
  const parts = splitList(text, MAX);

  assert.ok(parts.length > 1);
  assert.deepEqual(over(parts), []);
  // Every part begins at an item marker, which is what "never mid-item" means.
  for (const part of parts) assert.match(part, /^- item/);
});

test("a wrapped continuation line travels with its own item", () => {
  const text = [
    "- first item",
    "  continuation of the first item that runs on for a while and adds length",
    "- second item",
    "  continuation of the second item that also runs on for a good long while",
    "- third item",
    "  continuation of the third item, likewise padded out to force a split",
  ].join("\n");

  // A budget that fits one item-plus-continuation but not two, which is the
  // case the item-boundary rule exists for.
  const parts = splitList(text, 30);
  assert.ok(parts.length > 1, "nothing was split");
  // A continuation must never open a part; that would strand half a bullet.
  for (const part of parts) assert.match(part, /^- /);
  // Each continuation stayed with the item it belongs to.
  for (const part of parts) {
    const items = part.split("\n- ").length;
    const continuations = (part.match(/^ {2}continuation/gm) ?? []).length;
    assert.equal(continuations, items, `an item lost its continuation:\n${part}`);
  }
});

test("a single bullet larger than the whole budget is split as prose, and says so", () => {
  // The documented fallback. There is nothing better to do than split its
  // prose, so the marker stays on the first fragment and the rest are bare —
  // an honest fragment rather than a fake bullet. This is asserted so the
  // behaviour is a decision on the record, not an accident nobody noticed.
  const text = `- ${"a long bullet with plenty of words in it ".repeat(12).trim()}`;
  const parts = splitList(text, 30);

  assert.ok(parts.length > 1);
  assert.ok(parts[0]!.startsWith("- "), "the marker did not stay on the first fragment");
  assert.ok(!parts[1]!.startsWith("- "), "a continuation fragment was dressed up as a new bullet");
  assert.deepEqual(over(parts, 30), []);
});

test("code fragments each stay fenced, and keep the language", () => {
  const text = ["```python", ...Array.from({ length: 40 }, (_, i) => `print("line ${i}")`), "```"].join("\n");
  const parts = splitCode(text, MAX);

  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.startsWith("```python"), `fragment lost its fence: ${part.slice(0, 20)}`);
    assert.ok(part.endsWith("```"));
    // Opened and closed exactly once.
    assert.equal(part.split("```").length - 1, 2);
  }
});

test("unfenced code still comes back fenced", () => {
  const parts = splitCode(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), MAX);
  for (const part of parts) assert.ok(part.startsWith("```") && part.endsWith("```"));
});

test("every table fragment repeats the header, so each one reads on its own", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| r${i} | value ${i} |`);
  const text = ["| Key | Value |", "|---|---|", ...rows].join("\n");

  const parts = splitTable(text, MAX);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.startsWith("| Key | Value |\n|---|---|"), `fragment lost its header:\n${part}`);
  }
  // And no row is lost between fragments.
  const joined = parts.join("\n");
  for (let i = 0; i < 30; i++) assert.ok(joined.includes(`| r${i} |`), `lost row ${i}`);
});

test("something that is not a pipe table falls back to prose splitting", () => {
  // No alignment row, so there is no header to repeat and repeating line one
  // would corrupt the content rather than help.
  const text = Array.from({ length: 30 }, (_, i) => `just a line ${i} of text`).join("\n");
  const parts = splitTable(text, MAX);
  assert.ok(parts.length > 1);
  assert.ok(!parts[1]?.startsWith("just a line 0"), "a non-header line was repeated");
});

test("no splitter ever returns nothing", () => {
  // A part list that came back empty would silently drop a block from the
  // index, which is the one failure mode none of these may have.
  for (const split of [splitProse, splitList, splitCode, splitTable]) {
    assert.ok(split("x", 1).length > 0, split.name);
    assert.ok(split("   ", 1).length > 0, split.name);
  }
});
