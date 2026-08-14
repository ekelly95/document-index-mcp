import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPdf, type PdfFixture } from "../../testing/pdfFixture.js";
import { renderScanJpeg } from "../../testing/scanImage.js";
import { testLangPath } from "../../testing/tessdata.js";
import { PdfOcrParser, type PdfOcrOptions } from "./pdfOcr.js";
import { disposeOcrPool } from "./ocrPool.js";
import { openSource } from "../source.js";
import type { DocBlock, DocumentSource } from "../ir.js";

/**
 * The OCR parser over real fixtures: pages that are images of words, pages
 * that kept a text layer, and books that mix the two. Everything runs
 * offline against the bundled traineddata, and one pool serves the file.
 */

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-pdfocr-"));

const OPTS: PdfOcrOptions = {
  lang: "eng",
  workers: 2,
  cacheDir,
  langPath: testLangPath(),
};

let tmp: string;
const opened: DocumentSource[] = [];

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-ocrfix-"));
});

after(async () => {
  await disposeOcrPool();
  for (const src of opened) await src.close();
  await fs.rm(tmp, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

const write = async (name: string, fixture: PdfFixture): Promise<DocumentSource> => {
  const file = path.join(tmp, name);
  await fs.writeFile(file, buildPdf(fixture));
  const src = await openSource(file);
  opened.push(src);
  return src;
};

const collect = async (src: DocumentSource, opts: PdfOcrOptions = OPTS): Promise<DocBlock[]> => {
  const out: DocBlock[] = [];
  for await (const b of new PdfOcrParser(opts).parse(src)) out.push(b);
  return out;
};

const textOf = (blocks: DocBlock[]): string => blocks.map((b) => b.text).join("\n");

test("a scanned page is recognised into paragraph blocks", async () => {
  const src = await write("scan.pdf", {
    pages: [
      {
        lines: [],
        scanImage: renderScanJpeg([
          "The migration of storks follows",
          "thermal columns across the strait.",
        ]),
      },
    ],
  });

  const blocks = await collect(src);
  assert.ok(blocks.length > 0, "a scanned page produced no blocks");
  // OCR is fuzzy: assert on distinctive words, never exact strings.
  const text = textOf(blocks);
  assert.match(text, /migration/i);
  assert.match(text, /thermal/i);
  for (const block of blocks) {
    assert.equal(block.kind, "paragraph");
    assert.equal(block.locator.type, "page");
    assert.equal(block.locator.ordinal, 0);
  }
});

test("recognised bboxes are normalised, top-left origin", async () => {
  const src = await write("bbox.pdf", {
    pages: [{ lines: [], scanImage: renderScanJpeg(["Ink near the top of the page"]) }],
  });

  const blocks = await collect(src);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    const [x, y, w, h] = block.bbox!;
    for (const v of [x, y, w, h]) {
      assert.ok(v >= 0 && v <= 1, `bbox component ${v} escaped 0..1`);
    }
    // The fixture anchors the scan to the top of the page, so top-left
    // origin means a small y; a bottom-left origin would put it near 1.
    assert.ok(y < 0.5, `top-of-page text landed at y=${y} — origin is flipped`);
  }
});

test("a mixed book keeps real text layers and recognises the rest", async () => {
  const layerText = "This preface was born digital and reads verbatim from the layer.";
  const src = await write("mixed.pdf", {
    pages: [
      {
        lines: [
          { text: layerText, x: 72, y: 700, size: 11 },
          { text: "It has enough characters to count as a usable layer.", x: 72, y: 680, size: 11 },
        ],
      },
      { lines: [], scanImage: renderScanJpeg(["The photographed body speaks of falconry."]) },
    ],
  });

  const blocks = await collect(src);
  const pageOne = blocks.filter((b) => b.locator.ordinal === 0);
  const pageTwo = blocks.filter((b) => b.locator.ordinal === 1);

  // The text layer passes through exactly — no OCR fuzz on digital pages.
  assert.ok(textOf(pageOne).includes(layerText), "the digital page lost its text layer");
  assert.match(textOf(pageTwo), /falconry/i);
  // Reading order survives the concurrent window.
  const ordinals = blocks.map((b) => b.locator.ordinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
});

test("bookmarks give scanned pages their section trail", async () => {
  const src = await write("trail.pdf", {
    outline: [{ title: "Chapter One", page: 0 }],
    pages: [{ lines: [], scanImage: renderScanJpeg(["Words within the first chapter."]) }],
  });

  const blocks = await collect(src);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.deepEqual(block.sectionPath, ["Chapter One"]);
  }
});

test("a hyphen broken across recognised lines is healed", async () => {
  const src = await write("hyphen.pdf", {
    pages: [
      {
        lines: [],
        scanImage: renderScanJpeg([
          "Every autumn the newly enrol-",
          "led students assemble outside.",
        ]),
      },
    ],
  });

  const text = textOf(await collect(src));
  assert.match(text, /enrolled/i);
  assert.doesNotMatch(text, /enrol-\s/i);
});

test("forceOcr recognises imagery even under a plausible text layer", async () => {
  const layer = "A perfectly printable sentence that is nonetheless the wrong words entirely.";
  const src = await write("forced.pdf", {
    pages: [
      {
        lines: [{ text: layer, x: 72, y: 400, size: 11 }],
        scanImage: renderScanJpeg(["The genuine page speaks of lighthouses."]),
      },
    ],
  });

  const trusted = textOf(await collect(src));
  assert.ok(trusted.includes(layer), "without forceOcr a usable layer should win");

  const forced = textOf(await collect(src, { ...OPTS, forceOcr: true }));
  assert.match(forced, /lighthouse/i);
  assert.ok(!forced.includes(layer), "forceOcr still returned the text layer");
});

test("metadata reports the page scheme and true page count", async () => {
  const src = await write("meta.pdf", {
    pages: [
      { lines: [], scanImage: renderScanJpeg(["One"]) },
      { lines: [], imageOnly: true },
      { lines: [], scanImage: renderScanJpeg(["Three"]) },
    ],
  });

  const meta = await new PdfOcrParser(OPTS).metadata(src);
  assert.equal(meta.locatorScheme, "page");
  assert.equal(meta.locatorCount, 3);
});
