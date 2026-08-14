import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { buildPdf, type PdfFixture } from "./pdfFixture.js";
import { renderScanJpeg } from "./scanImage.js";
import { loadPdf } from "../pipeline/parsers/pdfCommon.js";
import { probePdf } from "../pipeline/parsers/pdfProbe.js";
import { openSource } from "../pipeline/source.js";
import type { DocumentSource } from "../pipeline/ir.js";

/**
 * The scan-image fixture is only useful if the imagery it embeds actually
 * survives the trip through pdfjs — a fixture whose JPEG fails to decode
 * would make every OCR test fail for reasons that have nothing to do with
 * OCR. So the render path is proven here, on the fixture itself.
 */

let tmp: string;
const opened: DocumentSource[] = [];

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-scanfix-"));
});

after(async () => {
  for (const src of opened) await src.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const write = async (name: string, fixture: PdfFixture): Promise<DocumentSource> => {
  const file = path.join(tmp, name);
  await fs.writeFile(file, buildPdf(fixture));
  const src = await openSource(file);
  opened.push(src);
  return src;
};

test("a scan-image page reads as a scan: real imagery, no text layer", async () => {
  const scan = renderScanJpeg(["The quick brown fox", "jumps over the lazy dog"]);
  const src = await write("scan.pdf", { pages: [{ lines: [], scanImage: scan }] });

  const probe = await probePdf(src);
  assert.equal(probe.imageOnly, true, "a page of imagery was not flagged image-only");

  const { doc } = await loadPdf(src);
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  assert.equal(text.items.length, 0, "a scan page leaked a text layer");
});

test("the embedded JPEG decodes and paints through pdfjs", async () => {
  const scan = renderScanJpeg(["Ink on the page"]);
  const src = await write("painted.pdf", { pages: [{ lines: [], scanImage: scan }] });

  const { doc } = await loadPdf(src);
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // pdfjs v6 wants a DOM canvas; the supported escape hatch for a foreign
  // context (ours is @napi-rs/canvas) is canvas: null plus canvasContext.
  await page.render({ canvas: null, canvasContext: ctx as never, viewport }).promise;

  // If the JPEG stream were malformed, pdfjs would paint nothing and every
  // pixel would still be the white we filled. Text ink means it decoded.
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < 128) dark++;
  }
  assert.ok(dark > 50, `expected drawn text to leave dark pixels, found ${dark}`);
});

test("a page can mix a text layer with imagery", async () => {
  const scan = renderScanJpeg(["Figure 1: a scanned plate"]);
  const src = await write("mixed.pdf", {
    pages: [
      { lines: [{ text: "A digitally born caption.", x: 72, y: 40, size: 11 }], scanImage: scan },
    ],
  });

  const { doc } = await loadPdf(src);
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  const joined = text.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");
  assert.match(joined, /digitally born caption/);
});
