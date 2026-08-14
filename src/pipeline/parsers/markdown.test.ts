import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceFromBytes } from "../source.js";
import { MarkdownParser } from "./markdown.js";
import type { DocBlock } from "../ir.js";

/**
 * The Markdown parser had no test of its own for a long time, which was the
 * wrong gap to leave open: Markdown is the format this server sees most, and
 * everything an intake pipeline produces — lecture transcripts, paper notes —
 * arrives as Markdown. It was covered only incidentally, through the
 * end-to-end suite, where a failure would surface as "search found nothing"
 * rather than as a parser defect.
 *
 * The guarantee worth pinning above all others is that block text is *sliced
 * from the source*, never re-serialised from the AST. remark-stringify escapes
 * `[`, so a round-tripped link, wikilink or timestamp would come back subtly
 * altered — and a quotation that does not match the file is worse than no
 * quotation at all.
 */

const parser = new MarkdownParser();

async function parse(md: string, name = "C:\\lib\\note.md"): Promise<DocBlock[]> {
  const src = sourceFromBytes(name, new TextEncoder().encode(md));
  const blocks: DocBlock[] = [];
  for await (const b of parser.parse(src)) blocks.push(b);
  return blocks;
}

const meta = (md: string, name = "C:\\lib\\note.md") =>
  parser.metadata(sourceFromBytes(name, new TextEncoder().encode(md)));

test("block text is sliced from the source, not re-serialised", async () => {
  // The exact shape a transcript arrives in. Every one of these would be
  // mangled by a stringifier: the brackets escaped, the emphasis normalised,
  // the query string's `&` entity-encoded.
  const md = [
    "# Notes",
    "",
    "**[14:35](https://example.com/watch?v=abc&t=875)** A claim worth quoting.",
    "",
    "A [wikilink]] and a literal \\[bracket\\] and *emphasis* with `code`.",
    "",
  ].join("\n");

  const blocks = await parse(md);
  const paragraphs = blocks.filter((b) => b.kind === "paragraph");

  assert.equal(
    paragraphs[0]?.text,
    "**[14:35](https://example.com/watch?v=abc&t=875)** A claim worth quoting.",
  );
  assert.equal(
    paragraphs[1]?.text,
    "A [wikilink]] and a literal \\[bracket\\] and *emphasis* with `code`.",
  );
});

test("the section locator advances at H1 and H2 but not deeper", async () => {
  const md = [
    "# One",
    "",
    "Body under one.",
    "",
    "## Two",
    "",
    "Body under two.",
    "",
    "### Three",
    "",
    "Body under three.",
    "",
    "## Four",
    "",
    "Body under four.",
    "",
  ].join("\n");

  const values = (await parse(md))
    .filter((b) => b.kind === "paragraph")
    .map((b) => b.locator.value);

  // H3 does not open a new locator, so its body stays in the H2's section.
  assert.deepEqual(values, ["sec-1", "sec-2", "sec-2", "sec-3"]);
});

test("a heading carries its ancestors but not itself, and body blocks carry the full trail", async () => {
  const md = ["# Part II", "", "## 3.2 Sampling", "", "The frame was drawn from the register.", ""].join("\n");
  const blocks = await parse(md);

  const h1 = blocks.find((b) => b.kind === "heading" && b.level === 1);
  const h2 = blocks.find((b) => b.kind === "heading" && b.level === 2);
  const body = blocks.find((b) => b.kind === "paragraph");

  assert.deepEqual(h1?.sectionPath, []);
  assert.deepEqual(h2?.sectionPath, ["Part II"]);
  assert.deepEqual(body?.sectionPath, ["Part II", "3.2 Sampling"]);
});

test("a deeper heading does not inherit a sibling it never sat under", async () => {
  // trail.slice(0, depth - 1) is what keeps this honest: after an H3 closes,
  // the next H2 must not carry the H3 as an ancestor.
  const md = ["# A", "", "## B", "", "### C", "", "## D", "", "Body.", ""].join("\n");
  const blocks = await parse(md);

  const d = blocks.find((b) => b.kind === "heading" && b.text === "## D");
  assert.deepEqual(d?.sectionPath, ["A"]);
  assert.deepEqual(blocks.find((b) => b.kind === "paragraph")?.sectionPath, ["A", "D"]);
});

test("tables, lists, code and quotes each keep their own kind", async () => {
  const md = [
    "# K",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "- one",
    "- two",
    "",
    "```python",
    "print('hi')",
    "```",
    "",
    "> quoted",
    "",
  ].join("\n");

  const kinds = (await parse(md)).map((b) => b.kind);
  assert.deepEqual(kinds, ["heading", "table", "list", "code", "quote"]);
});

test("a fenced block records its language, and a list whether it is ordered", async () => {
  const blocks = await parse(["```sql", "SELECT 1;", "```", "", "1. first", "2. second", ""].join("\n"));
  assert.equal(blocks.find((b) => b.kind === "code")?.attrs?.language, "sql");
  assert.equal(blocks.find((b) => b.kind === "list")?.attrs?.ordered, true);
});

test("frontmatter is skipped as content but read for the title", async () => {
  const md = ["---", "title: Sampling and Measurement", "---", "", "# Ignored H1", "", "Body.", ""].join("\n");

  assert.equal((await meta(md)).title, "Sampling and Measurement");
  // The yaml node has no IR kind, so it never becomes a block.
  assert.ok(!(await parse(md)).some((b) => b.text.includes("title:")));
});

test("the title falls back to the first H1, then to the filename", async () => {
  assert.equal((await meta("# The Real Title\n\nBody.\n")).title, "The Real Title");
  assert.equal((await meta("Just prose, no heading.\n", "C:\\lib\\my-note.md")).title, "my-note");

  // An empty frontmatter title and a bare `# ` are both absent, not empty.
  assert.equal((await meta('---\ntitle: ""\n---\n\n# Fallback\n')).title, "Fallback");
  assert.equal((await meta("# \n\nBody.\n", "C:\\lib\\bare.md")).title, "bare");
});

test("a hash inside a fenced block is not counted as a heading", async () => {
  // locatorCount is the progress denominator, so a shell comment in a code
  // fence inflating it would make ingest look permanently unfinished.
  const md = ["# Real", "", "```bash", "# not a heading", "## also not", "```", "", "## Also real", ""].join("\n");
  assert.equal((await meta(md)).locatorCount, 2);
});

test("locatorCount is never zero, so progress has a denominator", async () => {
  assert.equal((await meta("Prose with no headings at all.\n")).locatorCount, 1);
});

test("an empty document yields no blocks", async () => {
  // The runner turns this into a failed ingest rather than an empty 'ready'
  // document; the parser's job is only to produce nothing.
  assert.deepEqual(await parse("\n"), []);
  assert.deepEqual(await parse(""), []);
});

test("windows line endings do not corrupt the sliced text", async () => {
  const blocks = await parse("# Title\r\n\r\nA paragraph that spans\r\none source line break.\r\n");
  assert.equal(blocks.find((b) => b.kind === "paragraph")?.text, "A paragraph that spans\r\none source line break.");
});
