import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { loadConfig } from "../config.js";
import { createContext, type AppContext } from "../context.js";
import { buildServer } from "../server.js";
import { indexCounts } from "../db/chunksRepo.js";
import { deleteDocument } from "../db/documentsRepo.js";
import { buildPdf, type PdfFixture } from "../testing/pdfFixture.js";

/**
 * End-to-end over the real MCP surface.
 *
 * The embedding model is ~130MB. It is cached in a stable temp directory so a
 * test run does not re-download it; DOCUMENT_INDEX_MODEL_CACHE overrides the location.
 */
const MODEL_CACHE =
  process.env["DOCUMENT_INDEX_MODEL_CACHE"] ??
  path.join(os.tmpdir(), "document-index-mcp-models");

const METHODS_MD = [
  "---",
  "title: Sampling and Measurement",
  "---",
  "",
  "# Part II — Methods",
  "",
  "Preamble sitting under the H1 and before any H2.",
  "",
  "## 3.1 Design",
  "",
  "The study used a repeated-measures design. Participants were tested twice,",
  "separated by a two-week washout period, to control for practice effects.",
  "",
  "## 3.2 Sampling",
  "",
  "The sampling frame was drawn from the population of enrolled students,",
  "stratified by year of study and field of concentration.",
  "",
  "| Stratum | Frame | Sampled |",
  "|---|---|---|",
  "| Year 1 | 1204 | 120 |",
  "| Year 2 | 1118 | 112 |",
  "",
  "Non-response was handled by replacement within stratum.",
  "",
  "# Part III — Results",
  "",
  "Results are reported in the order the hypotheses were registered.",
  "",
].join("\n");

/**
 * A second Markdown document whose heading skeleton mirrors METHODS_MD — one
 * H1 then two H2s, with the sampling passage under the second H2 — so its
 * chunks carry the SAME section-locator values (sec-N). Two sources, similar
 * passages, identical locator labels: the case where only document identity on
 * the hit itself can tell an agent which file a result came from.
 */
const FIELD_NOTES_MD = [
  "---",
  "title: Field Notes on Recruitment",
  "---",
  "",
  "# Week Two — Recruitment",
  "",
  "Notes taken while the recruitment drive was still running.",
  "",
  "## 2.1 Outreach",
  "",
  "Posters went up in both faculty buildings and the response rate doubled",
  "within a week of the mailing list announcement.",
  "",
  "## 2.2 Sampling",
  "",
  "The sampling frame here was assembled from the volunteer register,",
  "stratified by cohort and site before invitations went out.",
  "",
].join("\n");

/**
 * A PDF whose printed page numbers disagree with their physical index, so the
 * citation guarantee can be checked all the way through the stack rather than
 * only at the parser.
 */
const BOOK_PDF: PdfFixture = {
  romanFrontMatter: 2,
  outline: [{ title: "Part II - Methods", page: 2 }],
  pages: [
    { lines: [
      { text: "Preface", x: 72, y: 700, size: 20 },
      { text: "Front matter, numbered with roman numerals.", x: 72, y: 670, size: 11 },
    ] },
    { lines: [
      { text: "Acknowledgements", x: 72, y: 700, size: 20 },
      { text: "Thanks are due to the funding body.", x: 72, y: 670, size: 11 },
    ] },
    { lines: [
      { text: "Part II - Methods", x: 72, y: 700, size: 20 },
      { text: "3.2 Sampling", x: 72, y: 660, size: 15 },
      { text: "Respondents were drawn by stratified random selection from", x: 72, y: 630, size: 11 },
      { text: "the enrolment register held by the registrar.", x: 72, y: 616, size: 11 },
    ] },
  ],
};

/**
 * Markdown shaped exactly as YouTube Transcript Notes renders it: a title, an
 * italic provenance line naming the channel and caption trust, chapter H2s, and
 * every paragraph opening with a bolded timestamp linking back to the second it
 * came from.
 *
 * This fixture is the seam between the two projects, and the reason it is
 * pinned here is that the whole combined claim rests on it: capture faithful
 * evidence, retrieve it without losing where it came from. A chunker that
 * mangled the link, or a parser that "helpfully" rewrote the markup, would
 * break the chain silently — the passage would still look fine, and the
 * timestamp would point somewhere else or nowhere.
 *
 * The lecture is invented and the video ID is not a real one. Only the shape is
 * borrowed; substituting a real transcript would put someone else's licensed
 * words in this repository for no test benefit, since what is under test is the
 * markup surviving intact and not the sentences themselves.
 */
const TRANSCRIPT_MD = [
  "# Lecture 3: Tides and the Bay of Fundy",
  "",
  "*Northfield Open Lectures · 9 March 2021 · [watch](https://www.youtube.com/watch?v=aB3dE5fG7hJ) · human-written captions (en)*",
  "",
  "## Intro",
  "",
  "**[0:22](https://www.youtube.com/watch?v=aB3dE5fG7hJ&t=22)** **PROFESSOR:** Right,",
  "welcome back. The whole hour goes on one question, which is why some bays have",
  "enormous tides and the bay next door has almost none.",
  "",
  "## Resonant Basins",
  "",
  "**[14:35](https://www.youtube.com/watch?v=aB3dE5fG7hJ&t=875)** So a resonant basin",
  "is one whose natural sloshing period nearly matches the tidal forcing. The",
  "amplification that follows is the interesting part of the lecture, and the reason",
  "Fundy runs to sixteen metres.",
  "",
].join("\n");

/** The exact link that must survive ingestion unchanged. */
const TIMESTAMP_LINK = "[14:35](https://www.youtube.com/watch?v=aB3dE5fG7hJ&t=875)";
/** The exact sentence that must come back byte-identical. */
const TRANSCRIPT_SENTENCE =
  "So a resonant basin\nis one whose natural sloshing period nearly matches the tidal forcing.";

let library: string;
let ctx: AppContext;
let client: Client;
let documentId: string;
let transcriptDocumentId: string;
let notesDocumentId: string;
let pdfDocumentId: string;
let fieldnotesDocumentId: string;

function textOf(res: unknown): string {
  const r = res as { content?: { type: string; text?: string }[] };
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}
function dataOf<T = Record<string, unknown>>(res: unknown): T {
  return (res as { structuredContent: T }).structuredContent;
}
const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

before(async () => {
  library = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-e2e-"));
  await fs.writeFile(path.join(library, "methods.md"), METHODS_MD);
  await fs.writeFile(path.join(library, "fieldnotes.md"), FIELD_NOTES_MD);
  await fs.writeFile(path.join(library, "lecture-transcript.md"), TRANSCRIPT_MD);
  await fs.writeFile(
    path.join(library, "notes.txt"),
    ["READING NOTES", "", "1. Introduction", "", "The author rejects the standard framing.", ""].join("\n"),
  );

  ctx = createContext(
    loadConfig([`--library=${library}`, `--models=${MODEL_CACHE}`]),
  );
  const server = buildServer(ctx);

  client = new Client({ name: "document-index-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await fs.writeFile(path.join(library, "book.pdf"), buildPdf(BOOK_PDF));

  // Ingest is fire-and-forget, so wait for it the way a caller would.
  const started = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "methods.md" }),
  );
  documentId = started.document_id;
  notesDocumentId = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "notes.txt" }),
  ).document_id;
  pdfDocumentId = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "book.pdf" }),
  ).document_id;
  fieldnotesDocumentId = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "fieldnotes.md" }),
  ).document_id;
  transcriptDocumentId = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "lecture-transcript.md" }),
  ).document_id;

  // All of them, not just some: search covers only documents that finished
  // indexing, so a fixture still in flight would make results depend on
  // timing.
  await waitReady([documentId, notesDocumentId, pdfDocumentId, fieldnotesDocumentId, transcriptDocumentId]);
});

async function waitReady(ids: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (const id of ids) {
    for (;;) {
      const status = dataOf<{ ingest_status: string; error_message?: string | null }>(
        await call("get_document_outline", { document_id: id }),
      );
      if (status.ingest_status === "ready") break;
      assert.notEqual(status.ingest_status, "failed", `ingest failed: ${status.error_message}`);
      assert.ok(Date.now() < deadline, "ingest did not finish in time");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

after(async () => {
  await client?.close();
  ctx?.db.close();
  ctx?.lock.release();
  await fs.rm(library, { recursive: true, force: true });
});

test("exposes exactly five tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "delete_document",
      "get_chunk_context",
      "get_document_outline",
      "ingest_document",
      "search_document",
    ],
  );
});

test("the startup probes for resources and prompts answer instead of erroring", async () => {
  // Codex asks every server these three at startup and reads a -32601 refusal
  // as the server failing to start — that is what put it on the host's
  // "not initialized" banner.
  assert.deepEqual((await client.listResources()).resources, []);
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
  assert.deepEqual((await client.listPrompts()).prompts, []);
});

test("the three indexes agree after ingest", () => {
  const counts = indexCounts(ctx.db);
  assert.ok(counts.chunks > 0);
  assert.equal(counts.fts, counts.chunks, "FTS index out of step with chunks");
  assert.equal(counts.vectors, counts.chunks, "vector index out of step with chunks");
});

test("progressive disclosure: search returns snippets, never body text", async () => {
  const data = dataOf<{ hits: Record<string, unknown>[] }>(
    await call("search_document", { query: "how were participants sampled", k: 5 }),
  );
  assert.ok(data.hits.length > 0);
  for (const hit of data.hits) {
    assert.ok(!("text" in hit), "a search hit carried full chunk text");
    assert.ok(typeof hit["snippet"] === "string");
    assert.ok((hit["snippet"] as string).length <= 400);
  }
});

test("progressive disclosure: the outline carries no body text", async () => {
  const raw = JSON.stringify(
    dataOf(await call("get_document_outline", { document_id: documentId, max_depth: 6 })),
  );
  assert.ok(
    !raw.includes("sampling frame was drawn"),
    "the outline leaked body text",
  );
});

test("outline spans point at the right chunks", async () => {
  const data = dataOf<{ entries: { title: string; children: { title: string; chunk_seq_start: number }[] }[] }>(
    await call("get_document_outline", { document_id: documentId, max_depth: 3 }),
  );

  const methods = data.entries.find((e) => e.title.includes("Methods"));
  assert.ok(methods, "expected a 'Part II — Methods' root");
  const sampling = methods.children.find((c) => c.title.includes("3.2 Sampling"));
  assert.ok(sampling, "expected a '3.2 Sampling' child");

  // Jumping to the span must land inside that section.
  const ctxData = dataOf<{ chunks: { section_path: string[] }[] }>(
    await call("get_chunk_context", {
      document_id: documentId,
      seq: sampling.chunk_seq_start,
      before: 0,
      after: 0,
    }),
  );
  assert.deepEqual(ctxData.chunks[0]!.section_path, ["Part II — Methods", "3.2 Sampling"]);
});

test("max_depth prunes the tree", async () => {
  const shallow = dataOf<{ entries: { children: unknown[] }[] }>(
    await call("get_document_outline", { document_id: documentId, max_depth: 1 }),
  );
  for (const entry of shallow.entries) assert.deepEqual(entry.children, []);
});

test("get_chunk_context returns a contiguous window with honest flags", async () => {
  const data = dataOf<{
    chunks: { seq: number }[];
    has_more_before: boolean;
    has_more_after: boolean;
  }>(
    await call("get_chunk_context", {
      document_id: documentId,
      seq: 2,
      before: 2,
      after: 2,
    }),
  );

  const seqs = data.chunks.map((c) => c.seq);
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(seqs[i], seqs[i - 1]! + 1, `window is not contiguous: ${seqs.join(",")}`);
  }
  assert.ok(seqs.includes(2), "the anchor chunk must be in the window");
  assert.equal(data.has_more_before, seqs[0]! > 0);
});

test("get_chunk_context at seq 0 reports nothing before it", async () => {
  const data = dataOf<{ has_more_before: boolean; chunks: { seq: number }[] }>(
    await call("get_chunk_context", { document_id: documentId, seq: 0, before: 3, after: 0 }),
  );
  assert.equal(data.chunks[0]!.seq, 0);
  assert.equal(data.has_more_before, false);
});

test("a body read never exceeds the hard cap", async () => {
  const data = dataOf<{ chunks: { text: string }[] }>(
    await call("get_chunk_context", { document_id: documentId, seq: 3, before: 5, after: 5 }),
  );
  const total = data.chunks.reduce((s, c) => s + c.text.length, 0);
  assert.ok(total <= 24_000, `returned ${total} chars, over the 24k cap`);
});

test("search is deterministic for a fixed query and corpus", async () => {
  const run = async () =>
    dataOf<{ hits: { chunk_id: string }[] }>(
      await call("search_document", { query: "stratified sampling frame", k: 5 }),
    ).hits.map((h) => h.chunk_id);
  assert.deepEqual(await run(), await run());
});

test("the kind filter finds the table", async () => {
  const data = dataOf<{ hits: { kind: string }[] }>(
    await call("search_document", {
      query: "stratum frame sampled",
      k: 5,
      filter: { kind: "table" },
    }),
  );
  assert.ok(data.hits.length > 0, "no table matched");
  for (const hit of data.hits) assert.equal(hit.kind, "table");
});

test("document_id scopes the search", async () => {
  const data = dataOf<{ hits: { document_id: string }[] }>(
    await call("search_document", { query: "the", k: 10, document_id: documentId }),
  );
  for (const hit of data.hits) assert.equal(hit.document_id, documentId);
});

test("every hit names its source, even when locator labels collide", async () => {
  // methods.md and fieldnotes.md both keep their sampling passage under the
  // second H2 of the first H1, so their hits carry identical sec-N locator
  // values. Only document identity on the hit can tell them apart.
  const res = await call("search_document", { query: "stratified sampling frame", k: 10 });
  const data = dataOf<{
    hits: {
      document_id: string;
      document_title: string;
      source_path: string;
      locator: { value: string };
    }[];
  }>(res);

  const methodsHits = data.hits.filter((h) => h.document_id === documentId);
  const fieldHits = data.hits.filter((h) => h.document_id === fieldnotesDocumentId);
  assert.ok(methodsHits.length > 0, "no hit from methods.md");
  assert.ok(fieldHits.length > 0, "no hit from fieldnotes.md");

  for (const h of methodsHits) assert.equal(h.document_title, "Sampling and Measurement");
  for (const h of fieldHits) assert.equal(h.document_title, "Field Notes on Recruitment");
  assert.equal(methodsHits[0]!.source_path, "methods.md");
  assert.equal(fieldHits[0]!.source_path, "fieldnotes.md");
  for (const h of data.hits) {
    assert.ok(
      !path.isAbsolute(h.source_path) && !/^[A-Za-z]:/.test(h.source_path),
      `source_path leaked an absolute path: ${h.source_path}`,
    );
  }

  // The collision this test exists for: same locator label, different source.
  const methodsValues = new Set(methodsHits.map((h) => h.locator.value));
  assert.ok(
    fieldHits.some((h) => methodsValues.has(h.locator.value)),
    "expected at least one locator value shared across the two documents",
  );

  // The human-readable rendering must carry the names too.
  const text = textOf(res);
  assert.ok(text.includes("Sampling and Measurement"), "text lines missing methods title");
  assert.ok(text.includes("Field Notes on Recruitment"), "text lines missing fieldnotes title");
});

test("get_chunk_context names the document it is reading from", async () => {
  const res = await call("get_chunk_context", { document_id: documentId, seq: 0 });
  const data = dataOf<{ document_title: string; source_path: string }>(res);
  assert.equal(data.document_title, "Sampling and Measurement");
  assert.equal(data.source_path, "methods.md");
  assert.ok(textOf(res).includes("Sampling and Measurement (methods.md)"));
});

test("re-ingesting an identical file is a no-op", async () => {
  const data = dataOf<{ reused: boolean; document_id: string }>(
    await call("ingest_document", { path: "methods.md" }),
  );
  assert.equal(data.reused, true);
  assert.equal(data.document_id, documentId);
});

test("tool errors come back as results the model can act on, not protocol failures", async () => {
  for (const args of [
    { chunk_id: "does-not-exist" },
    {}, // neither addressing form
    { document_id: documentId, seq: 99_999 },
  ]) {
    const res = await call("get_chunk_context", args);
    assert.equal((res as { isError?: boolean }).isError, true);
    assert.ok(textOf(res).length > 0, "an error result must explain itself");
  }
});

test("path traversal is refused", async () => {
  for (const bad of ["../outside.md", "..\\outside.md", "/etc/passwd"]) {
    const res = await call("ingest_document", { path: bad });
    assert.equal((res as { isError?: boolean }).isError, true, `${bad} was not refused`);
  }
});

test("an unsupported format is refused with a useful message", async () => {
  await fs.writeFile(path.join(library, "page.html"), "<html><body>hi</body></html>");
  const res = await call("ingest_document", { path: "page.html" });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(textOf(res), /html|deferred|support/i);
});

test("a legacy binary Office file is refused with the conversion route named", async () => {
  const cfb = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512),
  ]);
  await fs.writeFile(path.join(library, "old-report.doc"), cfb);
  const res = await call("ingest_document", { path: "old-report.doc" });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(textOf(res), /legacy|convert/i);
});

test("EPUB and PowerPoint are refused at the gate, by extension", async () => {
  // Both had working parsers and were removed rather than finished: an EPUB
  // locator named a spine file but called it a chapter, and a chart-led deck
  // indexed its titles and none of its data. The refusal is the feature —
  // asserted here so a later session cannot quietly re-add either without also
  // deciding, deliberately, to delete this test.
  for (const name of ["book.epub", "deck.pptx"]) {
    await fs.writeFile(path.join(library, name), Buffer.from("PK"));
    const res = await call("ingest_document", { path: name });
    assert.equal((res as { isError?: boolean }).isError, true, `${name} was not refused`);
    assert.match(textOf(res), /unsupported file type/i);
  }
});

test("a PDF search hit cites the printed page, not the physical sheet", async () => {
  const data = dataOf<{
    hits: { locator: { value: string; ordinal: number; page_number: number | null; printed_label: string | null } }[];
  }>(
    await call("search_document", {
      query: "stratified random selection from the enrolment register",
      k: 3,
      document_id: pdfDocumentId,
    }),
  );

  assert.ok(data.hits.length > 0, "the PDF body text was not retrievable");
  const hit = data.hits[0]!;

  // The passage lives on the third sheet of paper, which the book prints as
  // page 1 because two pages of front matter are numbered i and ii. A citation
  // that said "page 3" would send the reader to the wrong place.
  assert.equal(hit.locator.value, "3");
  assert.equal(hit.locator.ordinal, 2);
  assert.equal(hit.locator.printed_label, "1");
  assert.equal(hit.locator.page_number, 3);
});

test("a PDF hit carries a bbox and its full section path", async () => {
  const data = dataOf<{ hits: { bbox: number[] | null; section_path: string[] }[] }>(
    await call("search_document", {
      query: "enrolment register held by the registrar",
      k: 1,
      document_id: pdfDocumentId,
    }),
  );
  const hit = data.hits[0]!;
  assert.ok(hit.bbox, "a PDF chunk should carry a bounding box");
  assert.equal(hit.bbox.length, 4);
  for (const v of hit.bbox) assert.ok(v >= 0 && v <= 1);
  assert.deepEqual(hit.section_path, ["Part II - Methods", "3.2 Sampling"]);
});

test("the page_range filter uses physical pages", async () => {
  const data = dataOf<{ hits: { locator: { value: string } }[] }>(
    await call("search_document", {
      query: "front matter roman numerals",
      k: 10,
      document_id: pdfDocumentId,
      filter: { page_range: [1, 2] },
    }),
  );
  for (const hit of data.hits) {
    assert.ok(["1", "2"].includes(hit.locator.value), `page ${hit.locator.value} is outside the range`);
  }
});

test("section_prefix does not leak into a sibling part", async () => {
  const data = dataOf<{ hits: { section_path: string[] }[] }>(
    await call("search_document", {
      query: "results reported in the order the hypotheses were registered",
      k: 10,
      document_id: documentId,
      filter: { section_prefix: "Part II" },
    }),
  );
  // "Part III — Results" starts with the characters "Part II", which is what
  // the old joined-string startsWith filter matched on.
  for (const hit of data.hits) {
    assert.ok(
      hit.section_path[0]?.startsWith("Part II —"),
      `filter on "Part II" returned ${JSON.stringify(hit.section_path)}`,
    );
  }
});

test("a reversed page_range is refused, not silently empty", async () => {
  for (const range of [[5, 2], [0, 3]]) {
    const res = await call("search_document", {
      query: "sampling",
      k: 5,
      filter: { page_range: range },
    });
    assert.equal((res as { isError?: boolean }).isError, true, `${JSON.stringify(range)} was accepted`);
    assert.match(textOf(res), /page_range/);
  }
});

test("concurrent ingests of one file cannot destroy each other's index", async () => {
  // The finding this whole restructure exists for. Both calls used to run the
  // check-then-write preamble unlocked: the second would see the first mid
  // ingest, delete its chunks, re-index from seq 0, collide on
  // UNIQUE(document_id, seq), and its error handler would then wipe the
  // first's finished index and mark the document failed.
  //
  // Long enough that indexing outlives the second call's preamble, so the
  // second really does arrive while the first holds the document. A two-line
  // file would finish first and the test would pass without ever racing.
  const sections = Array.from({ length: 30 }, (_, i) =>
    [
      `## Section ${i + 1}`,
      "",
      `A passage that exactly one ingest should ever write, numbered ${i + 1}.`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(library, "race.md"), `# Contested\n\n${sections.join("\n")}`);

  const [a, b] = await Promise.all([
    call("ingest_document", { path: "race.md" }),
    call("ingest_document", { path: "race.md" }),
  ]);

  const idA = dataOf<{ document_id: string }>(a).document_id;
  const idB = dataOf<{ document_id: string }>(b).document_id;
  assert.equal(idA, idB, "the two calls claimed different documents for one file");

  // Exactly one caller may own the document. The other must report that it
  // attached to an existing ingest rather than starting a second one.
  const texts = [textOf(a), textOf(b)];
  assert.equal(
    texts.filter((t) => t.startsWith("Indexing")).length,
    1,
    `both calls claimed to be indexing:\n${texts.join("\n---\n")}`,
  );
  assert.equal(
    texts.filter((t) => /already (being )?indexed/.test(t)).length,
    1,
    `neither call reported joining:\n${texts.join("\n---\n")}`,
  );

  await waitReady([idA]);

  const doc = ctx.db
    .prepare("SELECT ingest_status, chunk_count FROM documents WHERE id = ?")
    .get(idA) as { ingest_status: string; chunk_count: number };
  assert.equal(doc.ingest_status, "ready", "the completed index was destroyed by the loser");
  assert.ok(doc.chunk_count > 0, "the document finished with no chunks");

  const rows = ctx.db
    .prepare("SELECT count(*) AS c FROM documents WHERE source_path = 'race.md'")
    .get() as { c: number };
  assert.equal(rows.c, 1, "one file produced more than one document");

  const counts = indexCounts(ctx.db);
  assert.equal(counts.fts, counts.chunks, "FTS out of step after the race");
  assert.equal(counts.vectors, counts.chunks, "vector index out of step after the race");
});

test("re-ingesting an edited file replaces it instead of duplicating it", async () => {
  const file = path.join(library, "draft.md");
  await fs.writeFile(
    file,
    ["# Draft", "", "The earlier claim was that badgers navigate by starlight.", ""].join("\n"),
  );
  const first = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "draft.md" }),
  ).document_id;
  await waitReady([first]);

  await fs.writeFile(
    file,
    ["# Draft", "", "The revised claim is that badgers navigate by scent gradients.", ""].join("\n"),
  );
  const second = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "draft.md" }),
  ).document_id;
  assert.notEqual(second, first, "an edited file should be a new document, not the old row");
  await waitReady([second]);

  // Identity is sha256, so before this fix the old version stayed indexed at
  // the same path and kept answering searches with text no longer in the file.
  const stale = dataOf<{ hits: { document_id: string }[] }>(
    await call("search_document", { query: "badgers navigate by starlight", k: 10 }),
  );
  for (const hit of stale.hits) {
    assert.notEqual(hit.document_id, first, "the superseded version is still answering searches");
  }
  assert.equal(
    (ctx.db
      .prepare("SELECT count(*) AS c FROM documents WHERE source_path = 'draft.md'")
      .get() as { c: number }).c,
    1,
    "the library path holds more than one document",
  );

  const counts = indexCounts(ctx.db);
  assert.equal(counts.fts, counts.chunks, "superseding left FTS orphans");
  assert.equal(counts.vectors, counts.chunks, "superseding left vector orphans");
});

test("one library path never holds two documents, even via the reuse path", async () => {
  // The awkward case: a file is overwritten with the exact contents of another
  // file that is ALREADY indexed. The sha is known, so this takes the reuse
  // branch rather than the supersede branch — and if superseding only happened
  // on the way to a fresh index, the reused document would be moved onto this
  // path without evicting the document already sitting there.
  const body = ["# Twin", "", "Both files ended up holding exactly these words.", ""].join("\n");
  await fs.writeFile(path.join(library, "twin-a.md"), body);
  await fs.writeFile(
    path.join(library, "twin-b.md"),
    ["# Other", "", "Something completely different lived here first.", ""].join("\n"),
  );

  const a = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "twin-a.md" }),
  ).document_id;
  const b = dataOf<{ document_id: string }>(
    await call("ingest_document", { path: "twin-b.md" }),
  ).document_id;
  await waitReady([a, b]);

  await fs.writeFile(path.join(library, "twin-b.md"), body);
  await call("ingest_document", { path: "twin-b.md" });

  assert.equal(
    (ctx.db
      .prepare("SELECT count(*) AS c FROM documents WHERE source_path = 'twin-b.md'")
      .get() as { c: number }).c,
    1,
    "two documents claim twin-b.md",
  );
  const counts = indexCounts(ctx.db);
  assert.equal(counts.fts, counts.chunks, "FTS orphans left behind");
  assert.equal(counts.vectors, counts.chunks, "vector orphans left behind");
});

test("delete_document removes a document and keeps the indexes in agreement", async () => {
  const before = indexCounts(ctx.db);
  const res = await call("delete_document", { document_id: notesDocumentId });
  const payload = dataOf<{ document_id: string; chunks_removed: number }>(res);

  assert.equal(payload.document_id, notesDocumentId);
  assert.ok(payload.chunks_removed > 0);

  const after = indexCounts(ctx.db);
  assert.ok(after.chunks < before.chunks, "nothing was deleted");
  assert.equal(after.fts, after.chunks, "FTS left orphans behind");
  // The case that needs an explicit delete: vec0 is a virtual table and no
  // foreign key cascade reaches it.
  assert.equal(after.vectors, after.chunks, "vector index left orphans behind");

  // The source file is the user's, not the index's.
  await fs.access(path.join(library, "notes.txt"));

  const gone = await call("get_document_outline", { document_id: notesDocumentId });
  assert.equal((gone as { isError?: boolean }).isError, true);
});

test("delete_document refuses an unknown id as a result, not a protocol failure", async () => {
  const res = await call("delete_document", { document_id: "01NOTATHING" });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(textOf(res), /Unknown document_id/);
});

test("the YouTube seam: a transcript is findable and its timestamps survive intact", async () => {
  // The combined promise of YouTube Transcript Notes and this server, end to
  // end. Capture produces timestamped Markdown; retrieval has to find it
  // without being told where to look, name the source, and hand back the
  // original wording with its link to the second of video it came from. If any
  // link in that chain rewrites the text, a citation stops being checkable and
  // nothing about the result looks wrong.

  // 1-2. Search the library, deliberately WITHOUT a document_id. Words chosen
  //      to appear nowhere else in the fixture library.
  const found = dataOf<{
    hits: { chunk_id: string; document_id: string; document_title: string; source_path: string }[];
  }>(await call("search_document", { query: "resonant basin sloshing period", k: 5 }));

  assert.ok(found.hits.length > 0, "library-wide search found no transcript");

  // 3. The hit names its source, rather than handing back an opaque id.
  const hit = found.hits.find((h) => h.document_id === transcriptDocumentId);
  assert.ok(hit, `no hit from the transcript; got ${JSON.stringify(found.hits.map((h) => h.source_path))}`);
  assert.equal(hit.document_title, "Lecture 3: Tides and the Bay of Fundy");
  assert.equal(hit.source_path, "lecture-transcript.md");

  // 4-5. Read the passage around it.
  const context = dataOf<{ chunks: { text: string }[] }>(
    await call("get_chunk_context", { chunk_id: hit.chunk_id, before: 1, after: 1 }),
  );
  const body = context.chunks.map((c) => c.text).join("\n");

  // 6. Byte-identical, both the prose and the clickable link. Not "contains
  //    something like" — the point is that a quotation can be checked.
  assert.ok(
    body.includes(TRANSCRIPT_SENTENCE),
    `the transcript sentence was altered in transit:\n${body}`,
  );
  assert.ok(
    body.includes(TIMESTAMP_LINK),
    `the timestamp link did not survive ingestion:\n${body}`,
  );

  // And the locator points at the right part of the document, so the citation
  // is answerable in the source file too.
  const outline = textOf(await call("get_document_outline", { document_id: transcriptDocumentId }));
  assert.match(outline, /Resonant Basins/);
});

test("a file that produces no chunks fails instead of going ready and empty", async () => {
  // Found in a real library: a one-byte Markdown file sat in the index as
  // 'ready' with chunk_count 0. Searching it returns nothing, which is
  // indistinguishable from a topic the library does not cover — the same
  // confusion the PDF probe refuses to create. Every other format already
  // refuses emptiness out loud; Markdown and text had no such gate.
  await fs.writeFile(path.join(library, "empty.md"), "\n");

  const started = dataOf<{ document_id: string; status: string }>(
    await call("ingest_document", { path: "empty.md" }),
  );

  const deadline = Date.now() + 30_000;
  let status = dataOf<{ ingest_status: string; error_message?: string | null }>(
    await call("get_document_outline", { document_id: started.document_id }),
  );
  while (status.ingest_status === "processing" && Date.now() < deadline) {
    status = dataOf<{ ingest_status: string; error_message?: string | null }>(
      await call("get_document_outline", { document_id: started.document_id }),
    );
  }

  assert.equal(status.ingest_status, "failed", "an empty file was published as ready");
  assert.match(String(status.error_message), /no indexable content/);

  // And it must not answer searches, which is the whole point.
  const hits = dataOf<{ hits: { document_id: string }[] }>(
    await call("search_document", { query: "empty", k: 10 }),
  );
  assert.ok(
    !hits.hits.some((h) => h.document_id === started.document_id),
    "a failed document reached the search results",
  );
});

test("deleteDocument leaves all three indexes in agreement", async () => {
  // Same invariant as above, exercised through the repository directly, since
  // that is what the supersede path in beginIngest calls.
  const before = indexCounts(ctx.db);
  const draft = ctx.db
    .prepare("SELECT id FROM documents WHERE source_path = 'draft.md'")
    .get() as { id: string };

  deleteDocument(ctx.db, draft.id);

  const after = indexCounts(ctx.db);
  assert.ok(after.chunks < before.chunks, "nothing was deleted");
  assert.equal(after.fts, after.chunks, "FTS left orphans behind");
  assert.equal(after.vectors, after.chunks, "vector index left orphans behind");
});
