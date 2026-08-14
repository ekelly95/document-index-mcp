import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, MAX_TOKENS, type DraftChunk } from "./chunker.js";
import type { BlockKind, DocBlock, LocatorType } from "./ir.js";
import { estimateTokens } from "../util/tokens.js";

/**
 * The invariants this file asserts are the ones the whole design sells. If the
 * boundary law breaks, every citation the server produces becomes untrustworthy
 * in a way no downstream test would notice.
 */

function block(
  kind: BlockKind,
  text: string,
  page: number,
  sectionPath: string[] = [],
  level?: number,
): DocBlock {
  return {
    kind,
    ...(level === undefined ? {} : { level }),
    text,
    locator: { type: "page", value: String(page), ordinal: page - 1 },
    sectionPath,
    bbox: null,
  };
}

/** Prose carrying a per-locator marker, so leakage across a boundary is visible. */
function prose(marker: string, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, i) => `${marker} sentence ${i} with enough words in it to consume a real share of the token budget.`,
  ).join(" ");
}

async function* stream(blocks: DocBlock[]): AsyncIterable<DocBlock> {
  for (const b of blocks) yield b;
}

async function collect(
  blocks: DocBlock[],
  scheme: LocatorType = "page",
): Promise<DraftChunk[]> {
  const out: DraftChunk[] = [];
  for await (const c of chunkBlocks(stream(blocks), { scheme })) out.push(c);
  return out;
}

test("boundary law: no chunk ever mixes text from two locators", async () => {
  // Each page's prose is tagged, so any leak shows up as two markers in one chunk.
  const blocks = [
    ...[1, 2, 3].flatMap((p) => [
      block("paragraph", prose(`PAGE${p}A`, 12), p),
      block("paragraph", prose(`PAGE${p}B`, 12), p),
      block("paragraph", prose(`PAGE${p}C`, 12), p),
    ]),
  ];

  const chunks = await collect(blocks);
  assert.ok(chunks.length > 3, "expected several chunks per page");

  for (const chunk of chunks) {
    const markers = [1, 2, 3].filter((p) => chunk.text.includes(`PAGE${p}`));
    assert.equal(
      markers.length,
      1,
      `chunk on page ${chunk.locator.value} contains markers from pages ${markers.join(", ")}`,
    );
    assert.equal(markers[0], Number(chunk.locator.value));
  }
});

test("overlap never crosses a locator boundary", async () => {
  const blocks = [1, 2].flatMap((p) => [
    block("paragraph", prose(`PAGE${p}A`, 14), p, ["Methods"]),
    block("paragraph", prose(`PAGE${p}B`, 14), p, ["Methods"]),
    block("paragraph", prose(`PAGE${p}C`, 14), p, ["Methods"]),
  ]);

  const chunks = await collect(blocks);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (chunk.overlapPrefix === null) continue;

    const previous = chunks[i - 1];
    assert.ok(previous, "an overlap prefix implies a preceding chunk");
    assert.equal(
      previous.locator.value,
      chunk.locator.value,
      "overlap was carried across a locator boundary",
    );
    // And the borrowed text really did come from this same locator.
    assert.ok(
      chunk.overlapPrefix.includes(`PAGE${chunk.locator.value}`),
      "overlap text originated on a different page",
    );
  }

  // The specific case the source spec got wrong: same section path, new page.
  const firstOfPage2 = chunks.find((c) => c.locator.value === "2");
  assert.ok(firstOfPage2);
  assert.equal(
    firstOfPage2.overlapPrefix,
    null,
    "the first chunk of a new page must not overlap the previous page",
  );
});

test("overlap is applied within a locator when the section path matches", async () => {
  const blocks = [
    block("paragraph", prose("A", 14), 1, ["Methods"]),
    block("paragraph", prose("B", 14), 1, ["Methods"]),
    block("paragraph", prose("C", 14), 1, ["Methods"]),
  ];
  const chunks = await collect(blocks);
  assert.ok(chunks.length > 1, "expected the page to split into several chunks");
  assert.ok(
    chunks.slice(1).some((c) => c.overlapPrefix !== null),
    "expected at least one intra-page chunk to carry overlap",
  );
});

test("tables are isolated, kept whole, and typed as tables", async () => {
  const table = [
    "| Stratum | Frame | Sampled |",
    "|---|---|---|",
    "| Year 1 | 1204 | 120 |",
    "| Year 2 | 1118 | 112 |",
  ].join("\n");

  const chunks = await collect([
    block("paragraph", "Lead-in prose before the table.", 1),
    block("table", table, 1),
    block("paragraph", "Follow-on prose after the table.", 1),
  ]);

  const tableChunks = chunks.filter((c) => c.kind === "table");
  assert.equal(tableChunks.length, 1);
  assert.ok(tableChunks[0]!.text.includes("| Year 2 |"));
  assert.ok(
    !tableChunks[0]!.text.includes("Lead-in prose"),
    "a table chunk must not absorb neighbouring prose",
  );
});

test("an oversized table splits by row group, repeating the header", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| Row ${i} | ${i * 7} | ${i * 11} |`);
  const table = ["| Label | A | B |", "|---|---|---|", ...rows].join("\n");

  const chunks = await collect([block("table", table, 1)]);
  assert.ok(chunks.length > 1, "expected the table to split");

  for (const chunk of chunks) {
    assert.ok(
      chunk.text.startsWith("| Label | A | B |"),
      "every table fragment must repeat the header row",
    );
    assert.ok(chunk.text.includes("|---|---|---|"));
  }
  // No row may be lost or duplicated across the split.
  const seen = chunks.flatMap((c) => c.text.match(/\| Row \d+ \|/g) ?? []);
  assert.equal(new Set(seen).size, 300);
});

test("a fenced code block splits at line boundaries and keeps its fence", async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `    value_${i} = compute(${i})`);
  const code = ["```python", ...lines, "```"].join("\n");

  const chunks = await collect([block("code", code, 1)]);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.startsWith("```python"), "language tag must be repeated");
    assert.ok(chunk.text.endsWith("```"), "fence must be closed");
    assert.equal(chunk.kind, "code");
  }
});

test("a heading is never stranded as the last block of a chunk", async () => {
  const blocks = [
    block("heading", "# Part II", 1, [], 1),
    block("paragraph", prose("BODY", 20), 1, ["Part II"]),
    block("heading", "## 3.1 Design", 1, ["Part II"], 2),
    block("paragraph", prose("DESIGN", 20), 1, ["Part II", "3.1 Design"]),
    block("heading", "## 3.2 Sampling", 1, ["Part II"], 2),
    block("paragraph", prose("SAMPLING", 20), 1, ["Part II", "3.2 Sampling"]),
  ];

  const chunks = await collect(blocks);
  for (const chunk of chunks) {
    const trimmed = chunk.text.trimEnd();
    const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
    assert.ok(
      !/^#{1,6}\s/.test(lastLine) || chunk.text.trim() === lastLine,
      `chunk ends on a heading, orphaning it: ${JSON.stringify(lastLine)}`,
    );
  }
});

test("a heading stays glued to the body it introduces", async () => {
  const chunks = await collect([
    block("heading", "## 3.2 Sampling", 1, ["Part II"], 2),
    block("paragraph", "The sampling frame was drawn from enrolled students.", 1, [
      "Part II",
      "3.2 Sampling",
    ]),
  ]);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.text.includes("## 3.2 Sampling"));
  assert.ok(chunks[0]!.text.includes("sampling frame"));
  assert.deepEqual(chunks[0]!.sectionPath, ["Part II", "3.2 Sampling"]);
});

test("prose chunks stay within the token cap", async () => {
  const blocks = [1, 2].map((p) => block("paragraph", prose(`P${p}`, 120), p));
  const chunks = await collect(blocks);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(
      chunk.tokenCount <= MAX_TOKENS,
      `chunk of ${chunk.tokenCount} tokens exceeds the ${MAX_TOKENS} cap`,
    );
    assert.equal(chunk.tokenCount, estimateTokens(chunk.text));
  }
});

test("an empty stream produces no chunks", async () => {
  assert.deepEqual(await collect([]), []);
});
