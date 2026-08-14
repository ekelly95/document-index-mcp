import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPdf, type PdfFixture } from "../../testing/pdfFixture.js";
import { PdfFastParser } from "./pdfFast.js";
import { PdfOcrParser } from "./pdfOcr.js";
import { probePdf } from "./pdfProbe.js";
import { isPageNumberLine, loadPdf, samplePageNumbers, usableTitle } from "./pdfCommon.js";
import { routeDocument } from "../router.js";
import { chunkBlocks } from "../chunker.js";
import type { DocBlock, DocumentSource } from "../ir.js";
import { openSource } from "../source.js";

let tmp: string;
const opened: DocumentSource[] = [];

/**
 * Write a fixture and open it as a source.
 *
 * Parsers take an opened source rather than a path now, and one source builds
 * one pdfjs document — so a test that probes and then routes the same handle
 * is also exercising the memoisation that collapsed three loads into one.
 */
const write = async (name: string, fixture: PdfFixture): Promise<DocumentSource> => {
  const file = path.join(tmp, name);
  await fs.writeFile(file, buildPdf(fixture));
  const src = await openSource(file);
  opened.push(src);
  return src;
};

const collect = async (src: DocumentSource): Promise<DocBlock[]> => {
  const out: DocBlock[] = [];
  for await (const b of new PdfFastParser().parse(src)) out.push(b);
  return out;
};

/** A book whose printed page numbers disagree with their physical index. */
const BOOK: PdfFixture = {
  romanFrontMatter: 2,
  outline: [
    { title: "Part II - Methods", page: 2 },
    { title: "Part III - Results", page: 3 },
  ],
  pages: [
    { lines: [
      { text: "A Study of Sampling", x: 72, y: 750, size: 9 },
      { text: "Preface", x: 72, y: 700, size: 20 },
      { text: "Front matter prose on the first page.", x: 72, y: 670, size: 11 },
      { text: "i", x: 300, y: 40, size: 9 },
    ] },
    { lines: [
      { text: "A Study of Sampling", x: 72, y: 750, size: 9 },
      { text: "Acknowledgements", x: 72, y: 700, size: 20 },
      { text: "Front matter prose on the second page.", x: 72, y: 670, size: 11 },
      { text: "ii", x: 300, y: 40, size: 9 },
    ] },
    { lines: [
      { text: "A Study of Sampling", x: 72, y: 750, size: 9 },
      { text: "Part II - Methods", x: 72, y: 700, size: 20 },
      { text: "3.2 Sampling", x: 72, y: 660, size: 15 },
      { text: "The sampling frame was drawn from the population of enrol-", x: 72, y: 630, size: 11 },
      { text: "led students, stratified by year of study.", x: 72, y: 616, size: 11 },
      { text: "1", x: 300, y: 40, size: 9 },
    ] },
    { lines: [
      { text: "A Study of Sampling", x: 72, y: 750, size: 9 },
      { text: "Part III - Results", x: 72, y: 700, size: 20 },
      { text: "The primary outcome showed a reliable effect.", x: 72, y: 660, size: 11 },
      { text: "2", x: 300, y: 40, size: 9 },
    ] },
  ],
};

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-pdf-"));
});
after(async () => {
  // Each source holds a pdfjs document until it is closed.
  await Promise.all(opened.map((src) => src.close()));
  await fs.rm(tmp, { recursive: true, force: true });
});

test("printed_label is carried when it disagrees with the physical page", async () => {
  const blocks = await collect(await write("book.pdf", BOOK));

  // Physical page 3 is printed "1" — front matter used roman numerals. This is
  // the case the whole citation guarantee exists for: quoting "page 1" has to
  // mean the page the reader sees, not the third sheet of paper.
  const printedOne = blocks.filter((b) => b.locator.printedLabel === "1");
  assert.ok(printedOne.length > 0, "no block carried printed label 1");
  for (const block of printedOne) {
    assert.equal(block.locator.value, "3");
    assert.equal(block.locator.ordinal, 2);
  }

  const romans = blocks.filter((b) => b.locator.value === "1");
  assert.ok(romans.length > 0);
  assert.equal(romans[0]!.locator.printedLabel, "i");
});

test("printed_label is omitted when it matches the physical page", async () => {
  const blocks = await collect(
    await write("plain.pdf", {
      pages: [{ lines: [{ text: "Only page, no relabelling.", x: 72, y: 700, size: 11 }] }],
    }),
  );
  assert.ok(blocks.length > 0);
  assert.equal(blocks[0]!.locator.printedLabel, undefined);
});

test("running headers and bare page numbers are stripped", async () => {
  const blocks = await collect(await write("book2.pdf", BOOK));
  const all = blocks.map((b) => b.text).join("\n");
  assert.ok(!all.includes("A Study of Sampling"), "running header survived into content");
  for (const block of blocks) {
    assert.ok(!/^\s*(?:[ivx]+|\d{1,4})\s*$/i.test(block.text), `bare page number kept: ${block.text}`);
  }
});

test("font-size tiers become heading levels", async () => {
  const blocks = await collect(await write("book3.pdf", BOOK));
  const headings = blocks.filter((b) => b.kind === "heading");

  const partII = headings.find((h) => h.text === "Part II - Methods");
  const sampling = headings.find((h) => h.text === "3.2 Sampling");
  assert.ok(partII && sampling);
  assert.equal(partII.level, 1, "the largest tier should be level 1");
  assert.equal(sampling.level, 2, "the middle tier should be level 2");
});

test("bookmarks re-base the trail and detected headings extend it", async () => {
  const blocks = await collect(await write("book4.pdf", BOOK));

  const body = blocks.find((b) => b.text.includes("sampling frame"));
  assert.ok(body);
  assert.deepEqual(
    body.sectionPath,
    ["Part II - Methods", "3.2 Sampling"],
    "a bookmarked section must not swallow the subsection beneath it",
  );

  // Front matter sits before the first bookmark and must still be filed.
  const preface = blocks.find((b) => b.text.includes("first page"));
  assert.ok(preface);
  assert.deepEqual(preface.sectionPath, ["Preface"]);

  // A heading carries its ancestors, never itself.
  const heading = blocks.find((b) => b.kind === "heading" && b.text === "Part II - Methods");
  assert.deepEqual(heading!.sectionPath, []);
});

test("lines broken for layout are rejoined, and hyphenation is healed", async () => {
  const blocks = await collect(await write("book5.pdf", BOOK));
  const body = blocks.find((b) => b.text.includes("sampling frame"));
  assert.ok(body);
  assert.match(body.text, /enrolled students/, "a soft hyphen was not healed");
  assert.ok(!body.text.includes("enrol-"), "the hyphen survived the join");
});

test("bbox is normalised 0..1 with a top-left origin", async () => {
  const blocks = await collect(await write("book6.pdf", BOOK));
  const heading = blocks.find((b) => b.kind === "heading");
  assert.ok(heading?.bbox);

  const [x, y, w, h] = heading.bbox;
  for (const v of [x, y, w, h]) {
    assert.ok(v >= 0 && v <= 1, `bbox component out of range: ${v}`);
  }
  assert.ok(x + w <= 1.001 && y + h <= 1.001, "bbox extends past the page");
  // The heading sits near the top of the page, so with a top-left origin its
  // y must be small. Bottom-left origin would put it near 1.
  assert.ok(y < 0.3, `expected a top-left origin, got y=${y}`);
});

test("a rotated margin stamp is furniture, not the document's largest heading", async () => {
  // arXiv prints this down the left edge of page 1 of every preprint. A 90°
  // run's transform[0] is ~0, so the size fell back to the glyph box's WIDTH —
  // measured at 20pt on a paper whose real title is 14.5pt, which made the
  // stamp the top tier and filed the whole paper underneath it.
  const blocks = await collect(
    await write("stamped.pdf", {
      pages: [
        {
          lines: [
            { text: "arXiv:1512.03385v1 [cs.CV] 10 Dec 2015", x: 30, y: 250, size: 10, rotate: 90 },
            { text: "Deep Residual Learning", x: 72, y: 700, size: 18 },
            { text: "We present a residual learning framework.", x: 72, y: 660, size: 11 },
            { text: "1. Introduction", x: 72, y: 620, size: 14 },
            { text: "Deeper networks are harder to train in practice.", x: 72, y: 590, size: 11 },
          ],
        },
      ],
    }),
  );

  const all = blocks.map((b) => b.text).join("\n");
  assert.ok(!all.includes("arXiv:"), "the sideways stamp was read as content");

  const body = blocks.find((b) => b.text.includes("harder to train"));
  assert.deepEqual(body!.sectionPath, ["Deep Residual Learning", "1. Introduction"]);
});

test("equal-sized headings are siblings, not a staircase", async () => {
  // Every numbered section of a paper is one size. Level came from the tier
  // index and `trail.slice(0, level - 1)` could not pad, so each section was
  // appended UNDER the last: 1 Introduction > 2 Background > 3 Model.
  const section = (n: number, y: number) => [
    { text: `${n} Section ${n}`, x: 72, y, size: 14 },
    { text: `Body of section ${n} runs here.`, x: 72, y: y - 25, size: 11 },
  ];
  const blocks = await collect(
    await write("siblings.pdf", {
      pages: [
        {
          lines: [
            { text: "A Paper With Sections", x: 72, y: 720, size: 20 },
            ...section(1, 680),
            ...section(2, 620),
            ...section(3, 560),
          ],
        },
      ],
    }),
  );

  for (const n of [1, 2, 3]) {
    const body = blocks.find((b) => b.text.includes(`Body of section ${n}`));
    assert.deepEqual(
      body!.sectionPath,
      ["A Paper With Sections", `${n} Section ${n}`],
      `section ${n} nested inside its siblings`,
    );
  }
});

test("a heading wrapped across lines is one heading, not one per line", async () => {
  // Centred display type on a report cover, and a justified journal title.
  const blocks = await collect(
    await write("wrapped.pdf", {
      pages: [
        {
          lines: [
            { text: "THE 9/11", x: 260, y: 700, size: 20 },
            { text: "COMMISSION", x: 240, y: 670, size: 20 },
            { text: "REPORT", x: 265, y: 640, size: 20 },
            { text: "Body text under the cover title.", x: 72, y: 560, size: 11 },
          ],
        },
      ],
    }),
  );

  const heading = blocks.find((b) => b.kind === "heading");
  assert.equal(heading!.text, "THE 9/11 COMMISSION REPORT");
  assert.equal(
    blocks.filter((b) => b.kind === "heading").length,
    1,
    "the cover title became more than one heading",
  );
});

test("two short headings in a row stay two headings", async () => {
  // The counterweight to the test above: a section heading directly over its
  // first subheading looks identical by size and spacing. Shape separates
  // them — neither ran to the measure, and they do not share a centre.
  const blocks = await collect(
    await write("adjacent.pdf", {
      pages: [
        {
          lines: [
            { text: "Materials and methods", x: 72, y: 700, size: 14 },
            { text: "Ethics statement", x: 72, y: 675, size: 14 },
            { text: "Participants gave written consent before enrolment.", x: 72, y: 640, size: 11 },
            { text: "A much longer line that reaches the right margin here.", x: 72, y: 610, size: 11 },
          ],
        },
      ],
    }),
  );

  const texts = blocks.filter((b) => b.kind === "heading").map((b) => b.text);
  assert.deepEqual(texts, ["Materials and methods", "Ethics statement"]);
});

test("font sizes that read as OCR noise are discarded, not obeyed", async () => {
  // A scan carrying an OCR text layer takes the FAST route, because its text
  // layer decodes fine. OCR font sizes are a near-continuum, so almost every
  // line cleared the body ratio: measured on a real 408-page scan, 2,824
  // headings, a 2,476-node outline of fragments, and — the damage that matters
  // — 2,766 chunks averaging 65 tokens against a 350 target, because every
  // spurious heading is a chunk boundary.
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push({
      text: `Recognised line number ${i} of this photographed page.`,
      x: 72,
      y: 740 - i * 17,
      // Ten distinct sizes, all above a 9pt body — the shape OCR produces.
      size: i % 4 === 0 ? 9 : 10.5 + (i % 10) * 0.5,
    });
  }
  const blocks = await collect(
    await write("ocr-noise.pdf", { pages: [{ lines }, { lines }, { lines }] }),
  );

  assert.equal(
    blocks.filter((b) => b.kind === "heading").length,
    0,
    "noisy font sizes were still trusted as structure",
  );
  for (const block of blocks) {
    assert.deepEqual(block.sectionPath, [], "a fabricated section trail survived");
  }
});

test("the page-number filter deletes page numbers, not words spelled from roman letters", () => {
  for (const number of ["1", "42", "1996", "i", "ii", "xiv", "IV", "XI", "page 7", "12."]) {
    assert.ok(isPageNumberLine(number), `${number} should read as a page number`);
  }
  // `[ivxlcdm]+` under /i matched any word built from those letters, so a line
  // of real prose was deleted from the index without a trace.
  for (const word of ["civil", "mild", "mill", "did", "DVD", "LCD", "I", "Mix", "livid"]) {
    assert.ok(!isPageNumberLine(word), `${word} was deleted as a page number`);
  }
});

test("a placeholder document title loses to the filename", async () => {
  // The 9/11 Commission Report ships with Title "201-635.job" — the print
  // shop's job name — which is worse than saying nothing.
  const src = await write("real-name.pdf", {
    docTitle: "201-635.job",
    pages: [{ lines: [{ text: "Body.", x: 72, y: 700, size: 11 }] }],
  });
  assert.equal((await new PdfFastParser().metadata(src)).title, "real-name");
});

test("the boundary law holds for PDFs: no chunk spans two pages", async () => {
  const file = await write("book7.pdf", BOOK);
  const parser = new PdfFastParser();
  const chunks = [];
  for await (const c of chunkBlocks(parser.parse(file), { scheme: "page" })) chunks.push(c);

  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    // Text unique to each page must never co-occur in one chunk.
    const markers = ["first page", "second page", "sampling frame", "primary outcome"].filter(
      (m) => chunk.text.includes(m),
    );
    assert.ok(markers.length <= 1, `chunk mixes pages: ${markers.join(" + ")}`);
  }
});

/**
 * A two-column paper: full-width title, two columns of body, a centred page
 * number below both. The column lines share baselines, which is exactly what
 * used to merge them into one interleaved line.
 */
const TWO_COLUMN: PdfFixture = {
  pages: [
    {
      lines: [
        { text: "Stratified Sampling in Practice", x: 72, y: 720, size: 18 },
        // y descends together: left and right share every baseline.
        { text: "The sampling frame was drawn", x: 72, y: 660, size: 11 },
        { text: "from the enrolment register", x: 72, y: 646, size: 11 },
        { text: "held by the registrar, which", x: 72, y: 632, size: 11 },
        { text: "lists every enrolled student.", x: 72, y: 618, size: 11 },
        { text: "Response rates varied across", x: 330, y: 660, size: 11 },
        { text: "strata, and non-response was", x: 330, y: 646, size: 11 },
        { text: "handled by replacement from", x: 330, y: 632, size: 11 },
        { text: "the same stratum throughout.", x: 330, y: 618, size: 11 },
        { text: "1", x: 300, y: 60, size: 9 },
      ],
    },
  ],
};

test("a two-column page reads down each column, not across both", async () => {
  const blocks = await collect(await write("twocol.pdf", TWO_COLUMN));
  const body = blocks.map((b) => b.text).join(" ");

  // The left column is one continuous sentence, and so is the right. Before
  // this, baseline grouping concatenated them line by line and produced
  // "The sampling frame was drawn Response rates varied across ...".
  assert.match(body, /from the enrolment register held by the registrar/);
  assert.match(body, /strata, and non-response was handled by replacement/);
  assert.ok(
    !/drawn Response/.test(body) && !/register strata/.test(body),
    `columns were interleaved:\n${body}`,
  );
});

test("the title leads, then the left column, then the right", async () => {
  const blocks = await collect(await write("twocol2.pdf", TWO_COLUMN));
  // Compared by position in the emitted stream rather than by block index:
  // how the lines group into paragraphs is the parser's business, and reading
  // order is what this is about.
  const stream = blocks.map((b) => b.text).join("\n");

  const title = stream.indexOf("Stratified Sampling in Practice");
  const left = stream.indexOf("sampling frame");
  const right = stream.indexOf("Response rates");

  assert.ok(title >= 0 && left >= 0 && right >= 0, `missing content:\n${stream}`);
  assert.ok(title < left, "the title came after the body");
  assert.ok(left < right, "the right column came before the left");
});

test("moving to the next column starts a new paragraph", async () => {
  const blocks = await collect(await write("twocol3.pdf", TWO_COLUMN));
  const welded = blocks.find(
    (b) => b.text.includes("enrolled student") && b.text.includes("Response rates"),
  );
  assert.equal(
    welded,
    undefined,
    "the end of one column was welded to the start of the next",
  );
});

test("a single-column page is unaffected by column detection", async () => {
  // The regression that matters: the fixtures every other test relies on must
  // read exactly as they did before bands and gutters existed.
  const blocks = await collect(await write("single.pdf", BOOK));
  const body = blocks.find((b) => b.text.includes("sampling frame"));
  assert.ok(body);
  assert.match(body.text, /enrolled students, stratified by year of study/);
});

test("the probe accepts a clean text layer", async () => {
  const probe = await probePdf(await write("book8.pdf", BOOK));
  assert.equal(probe.imageOnly, false);
  assert.equal(probe.mojibake, false);
  assert.equal(probe.detail, null);
});

test("a scan is detected and refused rather than silently ingested empty", async () => {
  const file = await write("scan.pdf", {
    pages: [{ imageOnly: true, lines: [] }, { imageOnly: true, lines: [] }],
  });

  const probe = await probePdf(file);
  assert.equal(probe.imageOnly, true);

  // The important half: refusing. A scan ingested with no OCR yields a
  // document containing nothing, and a later search finding nothing is
  // indistinguishable from a topic the book does not cover. Routing without
  // options means OCR off, so these assertions pin the --ocr=off behaviour.
  await assert.rejects(routeDocument(file), /OCR is disabled/);
});

test("a scan is still caught when its front matter has a text layer", async () => {
  // The escape hatch that used to let scans through: `pagesWithText === 0`
  // required EVERY sampled page to be textless, so one digitally-generated
  // title page — which scanned books routinely carry — was enough to pass the
  // probe. The book then ingested as a document containing almost nothing.
  const src = await write("scan-with-title.pdf", {
    pages: [
      { lines: [{ text: "A Photographed Monograph", x: 72, y: 700, size: 18 }] },
      ...Array.from({ length: 7 }, () => ({ imageOnly: true, lines: [] })),
    ],
  });

  const probe = await probePdf(src);
  assert.equal(probe.imageOnly, true, "a scan with a text title page slipped through");
  await assert.rejects(routeDocument(src), /OCR is disabled/);
});

test("sampling reaches the last page, where scanned plates tend to hide", () => {
  for (const pageCount of [1, 2, 4, 17, 400]) {
    const sampled = samplePageNumbers(pageCount);
    assert.equal(sampled.at(-1), pageCount, `page ${pageCount} was never sampled`);
    assert.equal(sampled[0], 1, "sampling did not start at the first page");
    assert.deepEqual([...sampled].sort((a, b) => a - b), sampled, "not in order");
  }
});

test("a mojibake text layer is detected and refused", async () => {
  const junk = "/g3/g72/g81/g3/g44/g3/g92/g81/g3/g70/g3/g81/g87/g3/g72/g3/g81/g87";
  const file = await write("moji.pdf", {
    pages: [1, 2, 3].map(() => ({ lines: [{ text: junk, x: 72, y: 700, size: 11 }] })),
  });

  const probe = await probePdf(file);
  assert.equal(probe.mojibake, true);
  await assert.rejects(routeDocument(file), /decodes to noise/);
});

test("a clean PDF routes to the fast path", async () => {
  const route = await routeDocument(await write("book9.pdf", BOOK));
  assert.equal(route.format, "pdf");
  assert.equal(route.engine, "ts-fast");
});

/** OCR routing options as the server would thread them from config. */
const OCR_AUTO = {
  ocr: { mode: "auto" as const, lang: "eng", workers: 1, cacheDir: os.tmpdir() },
};

test("with OCR auto, a scan routes to the OCR engine instead of refusing", async () => {
  const src = await write("scan-routed.pdf", {
    pages: [{ imageOnly: true, lines: [] }, { imageOnly: true, lines: [] }],
  });

  const route = await routeDocument(src, OCR_AUTO);
  assert.equal(route.format, "pdf");
  assert.equal(route.engine, "ts-ocr");
  assert.ok(route.parser instanceof PdfOcrParser);
});

test("with OCR auto, mojibake routes to the OCR engine with forceOcr", async () => {
  const junk = "/g3/g72/g81/g3/g44/g3/g92/g81/g3/g70/g3/g81/g87/g3/g72/g3/g81/g87";
  const src = await write("moji-routed.pdf", {
    pages: [1, 2, 3].map(() => ({ lines: [{ text: junk, x: 72, y: 700, size: 11 }] })),
  });

  const route = await routeDocument(src, OCR_AUTO);
  assert.equal(route.engine, "ts-ocr");
  // A mojibake layer looks plausible page by page, so the parser must be told
  // not to trust the per-page vote. White-box on purpose: this flag is the
  // router's whole contribution to the mojibake case.
  assert.equal((route.parser as PdfOcrParser)["opts"].forceOcr, true);
});

test("with OCR auto, a clean PDF still routes to the fast path", async () => {
  const route = await routeDocument(await write("book11.pdf", BOOK), OCR_AUTO);
  assert.equal(route.engine, "ts-fast");
});

test("probe, metadata and parse share one pdfjs document", async () => {
  // Ingesting a PDF used to read the file and build a pdfjs document three
  // separate times — once per stage. Each stage now asks the source, and the
  // source builds it once.
  const src = await write("shared.pdf", BOOK);

  await probePdf(src);
  await new PdfFastParser().metadata(src);
  await collect(src);

  const a = await loadPdf(src);
  const b = await loadPdf(src);
  assert.equal(a, b, "loadPdf built a second document for the same source");
  assert.equal(a.doc.numPages, 4, "the shared document is not the right one");
});

test("metadata reports the page count as the locator count", async () => {
  const meta = await new PdfFastParser().metadata(await write("book10.pdf", BOOK));
  assert.equal(meta.locatorScheme, "page");
  assert.equal(meta.locatorCount, 4);
});

test("an authoring tool's placeholder title is rejected in any language", () => {
  // Found by a corpus of downloaded decks: PowerPoint localises the title it
  // stamps into every unnamed file, so an English-only pattern let two of six
  // sample decks index as "a PowerPoint file" in Spanish and Portuguese.
  for (const placeholder of [
    "PowerPoint Presentation",
    "Presentación de PowerPoint",
    "Apresentação do PowerPoint",
    "PowerPoint-Präsentation",
    "Présentation PowerPoint",
    "Presentatie",
    "Untitled",
    "Document1",
    "Slide 12",
    "No Title",
    "Sin título",
    "Microsoft Word - Chapter 3",
    "201-635.job",
  ]) {
    assert.equal(usableTitle(placeholder), null, `accepted the placeholder "${placeholder}"`);
  }
});

test("a real title that merely mentions the authoring tool survives", () => {
  // The stripping rule must not swallow a title just because the product name
  // appears in it — these are the titles a filename fallback would be worse than.
  for (const real of [
    "PowerPoint for Beginners",
    "Advanced PowerPoint Techniques",
    "Características do processo",
    "The Word of God",
    "Presentation of Results",
    "DoBIH User Survey 2018",
  ]) {
    assert.equal(usableTitle(real), real, `rejected the real title "${real}"`);
  }
});

test("a bookmark's internal whitespace is collapsed, not carried into the trail", async () => {
  // A slide title centred with padding exports as a bookmark holding the run
  // verbatim. Left alone it lands inside section_path, where section_prefix
  // matches segment by segment and no caller would ever reproduce it.
  const padded = await write("padded.pdf", {
    outline: [{ title: "Slide 3:            Sapphires", page: 0 }],
    pages: [{ lines: [{ text: "Sapphires are usually blue.", x: 72, y: 700, size: 11 }] }],
  });
  const blocks = await collect(padded);
  const trail = blocks.find((b) => b.sectionPath.length > 0)?.sectionPath ?? [];
  assert.deepEqual(trail, ["Slide 3: Sapphires"], `trail was ${JSON.stringify(trail)}`);
});
