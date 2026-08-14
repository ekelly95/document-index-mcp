import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceFromBytes } from "../source.js";
import { headingLevel, TxtParser } from "./txt.js";
import type { DocBlock } from "../ir.js";

/**
 * The plain-text heuristics, which had no test of their own.
 *
 * Everything here is guesswork over prose that happens to be conventionally
 * formatted, and the parser's stated bias is that a **false positive is worse
 * than a flat outline**: a wrongly detected heading fragments a document into
 * sections that do not exist, and every locator after it is wrong. Most of
 * these tests are therefore about what is *not* a heading.
 */

const parser = new TxtParser();

async function parse(text: string, name = "/lib/notes.txt"): Promise<DocBlock[]> {
  const src = sourceFromBytes(name, new TextEncoder().encode(text));
  const blocks: DocBlock[] = [];
  for await (const b of parser.parse(src)) blocks.push(b);
  return blocks;
}

const meta = (text: string, name = "/lib/notes.txt") =>
  parser.metadata(sourceFromBytes(name, new TextEncoder().encode(text)));

test("setext underlines are headings, at the level the underline character sets", () => {
  assert.equal(headingLevel("Introduction", "===="), 1);
  assert.equal(headingLevel("Background", "----"), 2);
  // Two characters is not an underline; a real one is three or more.
  assert.equal(headingLevel("Background", "--"), null);
});

test("numbered sections take their level from the depth of the numbering", () => {
  // The single-level form needs the blank line to tell it from a list item.
  assert.equal(headingLevel("1. Introduction", ""), 1);
  assert.equal(headingLevel("1.2 Methods", undefined), 2);
  assert.equal(headingLevel("2.3.1 Sampling", undefined), 3);
});

test("a numbered sentence is prose, not a heading", () => {
  // The terminal full stop is the tell. Without this rule an enumerated
  // argument becomes a table of contents.
  assert.equal(headingLevel("1. The author rejects the standard framing.", undefined), null);
  assert.equal(headingLevel("2. This is a complete sentence!", undefined), null);
});

test("list items are never headings, however they are marked", () => {
  // Each followed by a sibling, which is what a list looks like.
  assert.equal(headingLevel("- one", "- two"), null);
  assert.equal(headingLevel("* two", "* three"), null);
  assert.equal(headingLevel("+ three", "+ four"), null);
  assert.equal(headingLevel("• four", "• five"), null);
  assert.equal(headingLevel("1) five", "2) six"), null);
  assert.equal(headingLevel("2. six", "3. seven"), null);
  // A bulleted item followed by a blank line is still a list item: only the
  // numbered form is ambiguous enough to reconsider.
  assert.equal(headingLevel("- one", ""), null);
});

test("named divisions are top-level headings", () => {
  for (const line of ["Chapter 4", "PART TWO", "Appendix B", "Section 3", "Book I"]) {
    assert.equal(headingLevel(line, undefined), 1, line);
  }
});

test("ALL-CAPS lines are headings, but only when they read like one", () => {
  assert.equal(headingLevel("READING NOTES", undefined), 2);
  // Needs a letter: a rule of dashes or a bare number is not a heading.
  assert.equal(headingLevel("--------", undefined), null);
  assert.equal(headingLevel("1234", undefined), null);
  // Shouting a whole sentence is still a sentence.
  assert.equal(headingLevel("THIS IS NOT A HEADING.", undefined), null);
});

test("an over-long line is body text whatever it looks like", () => {
  // 90 characters is the cutoff, and it is what stops a long capitalised
  // sentence from swallowing the document.
  const long = `CHAPTER ${"X".repeat(95)}`;
  assert.equal(headingLevel(long, undefined), null);
});

test("a blank line closes a paragraph, and consecutive lines join one", async () => {
  const blocks = await parse(["First line", "second line of the same paragraph.", "", "A separate one.", ""].join("\n"));
  const paras = blocks.filter((b) => b.kind === "paragraph");
  assert.equal(paras.length, 2);
  assert.equal(paras[0]?.text, "First line\nsecond line of the same paragraph.");
  assert.equal(paras[1]?.text, "A separate one.");
});

test("a setext underline is consumed rather than becoming body text", async () => {
  const blocks = await parse(["Introduction", "============", "", "Body.", ""].join("\n"));
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["Introduction", "Body."],
  );
});

test("a wrapped list item stays with its item instead of starting a paragraph", async () => {
  const blocks = await parse(
    ["- an item whose text", "  runs onto a second line", "- a second item", ""].join("\n"),
  );
  const lists = blocks.filter((b) => b.kind === "list");
  assert.equal(lists.length, 1, "the continuation split the list");
  assert.match(lists[0]!.text, /runs onto a second line/);
  assert.equal(blocks.filter((b) => b.kind === "paragraph").length, 0);
});

test("the locator advances at levels 1 and 2 only", async () => {
  const text = [
    "1. Introduction",
    "",
    "Body A.",
    "",
    "1.2 Methods",
    "",
    "Body B.",
    "",
    "1.2.3 Sampling",
    "",
    "Body C.",
    "",
  ].join("\n");

  const values = (await parse(text))
    .filter((b) => b.kind === "paragraph")
    .map((b) => b.locator.value);
  assert.deepEqual(values, ["sec-1", "sec-2", "sec-2"]);
});

test("the section trail nests and unwinds with heading level", async () => {
  const text = ["Chapter 1", "", "1.1 First", "", "Body.", ""].join("\n");
  const body = (await parse(text)).find((b) => b.kind === "paragraph");
  assert.deepEqual(body?.sectionPath, ["Chapter 1", "1.1 First"]);
});

test("the title is the first heading, else the filename", async () => {
  assert.equal((await meta("READING NOTES\n\nBody.\n")).title, "READING NOTES");
  assert.equal((await meta("Just prose.\n", "/lib/my-file.txt")).title, "my-file");
});

test("an unstructured file is flat, and that is a correct answer", async () => {
  const text = "A paragraph of ordinary prose.\n\nAnd another one.\n";
  assert.equal((await meta(text)).locatorCount, 1);
  assert.ok((await parse(text)).every((b) => b.kind === "paragraph"));
});

test("an empty file yields no blocks", async () => {
  assert.deepEqual(await parse(""), []);
  assert.deepEqual(await parse("\n\n\n"), []);
});
