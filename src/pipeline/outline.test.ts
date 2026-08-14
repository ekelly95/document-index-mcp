import { test } from "node:test";
import assert from "node:assert/strict";
import type { Locator } from "./ir.js";
import { OutlineBuilder, pruneOutline, type OutlineNode } from "./outline.js";

/**
 * Section identity in the outline.
 *
 * There was no test file here at all, and the one end-to-end check in
 * tools.test.ts uses a fixture whose headings are all distinct — which is
 * exactly the case the old title-keyed builder got right.
 */

const at = (ordinal: number): Locator => ({
  type: "section",
  value: `sec-${ordinal}`,
  ordinal,
});

const page = (ordinal: number): Locator => ({
  type: "page",
  value: String(ordinal + 1),
  ordinal,
  printedLabel: `p${ordinal + 1}`,
});

/** Build an outline from (sectionPath, locator) pairs, one chunk each. */
function outlineOf(rows: readonly (readonly string[])[]): OutlineNode[] {
  const builder = new OutlineBuilder();
  rows.forEach((sectionPath, seq) => builder.add(seq, sectionPath, at(seq)));
  return builder.build();
}

/** Compact "Title[start-end]{children}" rendering, so a whole tree is one assertion. */
const spans = (nodes: readonly OutlineNode[]): string =>
  nodes
    .map(
      (n) =>
        `${n.title}[${n.chunk_seq_start}-${n.chunk_seq_end}]` +
        (n.children.length > 0 ? `{${spans(n.children)}}` : ""),
    )
    .join(",");

test("a repeated heading is two sections, not one span swallowing the middle", () => {
  // The shape that broke it: a working notebook with a recurring heading.
  const tree = outlineOf([["Notes"], ["Log"], ["Notes"]]);

  assert.equal(tree.length, 3, "repeated headings collapsed into one node");
  assert.deepEqual(
    tree.map((n) => [n.title, n.chunk_seq_start, n.chunk_seq_end]),
    [
      ["Notes", 0, 0],
      ["Log", 1, 1],
      ["Notes", 2, 2],
    ],
  );
});

test("a merged node used to reach across everything between occurrences", () => {
  const tree = outlineOf([["Intro"], ["Body"], ["Body"], ["Body"], ["Intro"]]);
  const intros = tree.filter((n) => n.title === "Intro");

  assert.equal(intros.length, 2);
  // The old builder produced a single Intro spanning 0-4, so jumping to it
  // landed on the first occurrence and claimed the whole document.
  assert.deepEqual(intros.map((n) => [n.chunk_seq_start, n.chunk_seq_end]), [
    [0, 0],
    [4, 4],
  ]);
});

test("each occurrence cites the locator it actually starts at", () => {
  const builder = new OutlineBuilder();
  builder.add(0, ["Summary"], page(2));
  builder.add(1, ["Discussion"], page(40));
  builder.add(2, ["Summary"], page(209));

  const [first, , second] = builder.build();
  assert.equal(first!.locator.value, "3");
  assert.equal(first!.locator.printed_label, "p3");
  // Frozen-at-first-sighting meant the second Summary reported page 3.
  assert.equal(second!.locator.value, "210");
  assert.equal(second!.locator.printed_label, "p210");
});

test("the same title under different parents stays distinct, as it always did", () => {
  const tree = outlineOf([
    ["Ch 1", "Notes"],
    ["Ch 2", "Notes"],
  ]);
  assert.equal(spans(tree), "Ch 1[0-0]{Notes[0-0]},Ch 2[1-1]{Notes[1-1]}");
});

test("the same title under one parent, re-entered, is two sections", () => {
  const tree = outlineOf([
    ["Ch 1", "Notes"],
    ["Ch 1", "Method"],
    ["Ch 1", "Notes"],
  ]);
  assert.equal(
    spans(tree),
    "Ch 1[0-2]{Notes[0-0],Method[1-1],Notes[2-2]}",
    "a re-entered subsection was merged with its earlier occurrence",
  );
});

test("a parent spans all of its children, contiguously", () => {
  const tree = outlineOf([
    ["Part I"],
    ["Part I", "A"],
    ["Part I", "B"],
    ["Part II"],
  ]);
  assert.equal(spans(tree), "Part I[0-2]{A[1-1],B[2-2]},Part II[3-3]");
});

test("a run of chunks in one section extends that section", () => {
  const tree = outlineOf([["Method"], ["Method"], ["Method"]]);
  assert.equal(spans(tree), "Method[0-2]");
});

test("chunks before the first heading create no node", () => {
  const tree = outlineOf([[], [], ["Intro"]]);
  assert.equal(spans(tree), "Intro[2-2]");
});

test("a document with no headings yields an empty outline, not a fabricated root", () => {
  assert.deepEqual(outlineOf([[], [], []]), []);
});

test("returning to a shallower level closes the deeper ones", () => {
  const tree = outlineOf([
    ["Ch 1", "A", "i"],
    ["Ch 1"],
    ["Ch 1", "A", "i"],
  ]);
  assert.equal(
    spans(tree),
    "Ch 1[0-2]{A[0-0]{i[0-0]},A[2-2]{i[2-2]}}",
    "a subsection resumed after its parent had moved on",
  );
});

test("pruneOutline still trims to depth without touching spans", () => {
  const tree = outlineOf([
    ["Ch 1", "A", "i"],
    ["Ch 1", "A", "ii"],
  ]);
  assert.equal(spans(pruneOutline(tree, 2)), "Ch 1[0-1]{A[0-1]}");
  assert.equal(pruneOutline(tree, 0).length, 0);
});
