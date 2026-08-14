/**
 * Render real raster imagery of text — for tests only.
 *
 * The pdfFixture's `imageOnly` page carries a 1×1 grey pixel, which is enough
 * to trip the probe but useless for exercising OCR: there is nothing on it to
 * recognise. This draws actual black-on-white text with @napi-rs/canvas, so a
 * fixture PDF can contain a page that LOOKS like a scan — an image of words
 * with no text layer behind it.
 */

import { createCanvas } from "@napi-rs/canvas";

export interface ScanImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface ScanImageOptions {
  width?: number;
  fontSize?: number;
  /**
   * Line height as a multiple of font size. The default is typeset-body
   * tight; airier spacing makes tesseract read each line as its own
   * paragraph, which is right for it to do — so tests that need lines to
   * stay in one paragraph should keep this under ~1.5.
   */
  lineSpacing?: number;
}

/**
 * Draw each string on its own line, black on white, and encode as JPEG.
 *
 * JPEG rather than PNG because the fixture embeds the bytes verbatim as a
 * /DCTDecode stream — PDF viewers and pdfjs decode JPEG natively, so the
 * fixture needs no zlib and no predictor arithmetic.
 */
export function renderScanJpeg(lines: string[], opts: ScanImageOptions = {}): ScanImage {
  const width = opts.width ?? 800;
  const fontSize = opts.fontSize ?? 32;
  const lineHeight = Math.round(fontSize * (opts.lineSpacing ?? 1.35));
  const margin = Math.round(fontSize * 1.5);
  const height = margin * 2 + lineHeight * lines.length;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, margin, margin + i * lineHeight);
  });

  const jpeg = canvas.encodeSync("jpeg", 92);
  return { jpeg: Buffer.from(jpeg), width, height };
}
