import type { DocumentSource } from "../ir.js";
import { loadPdf, samplePageNumbers } from "./pdfCommon.js";

/**
 * Cheap content probe over a handful of evenly spaced pages.
 *
 * In the source spec this routed between the fast path and a Docling sidecar.
 * There is no sidecar in this build, so the probe's job is narrower but more
 * important: refuse a document the fast path would silently turn into garbage.
 * A scanned book ingested with no OCR produces a document with zero or
 * nonsense text that still reports success — which is far worse than an error,
 * because a search that finds nothing looks identical to a topic not covered.
 *
 * Only the two detectors that gate correctness are implemented. multiColumn
 * and tableDense exist in the spec purely to select a Docling route, so they
 * would be dead code here.
 */

export interface PdfProbe {
  imageOnly: boolean;
  mojibake: boolean;
  sampledPages: number[];
  /** Populated when a detector fires, for the error message. */
  detail: string | null;
}

/** Ratio of characters that are printable rather than control/replacement noise. */
function printableRatio(text: string): number {
  if (text.length === 0) return 1;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
  }
  return printable / text.length;
}

function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  const hits = text.match(/�/g)?.length ?? 0;
  return hits / text.length;
}

/**
 * Un-mapped CID glyphs leak out of a broken encoding as literal escapes like
 * `/g123` or `/uni0041`. A page made mostly of these has a text layer that
 * exists but decodes to nothing meaningful.
 */
function cidEscapeRatio(text: string): number {
  if (text.length === 0) return 0;
  const matched = text.match(/\/(?:g|uni|c|cid|i)\d+/gi) ?? [];
  const covered = matched.reduce((s, m) => s + m.length, 0);
  return covered / text.length;
}

/**
 * The probe's quality gates applied to one page's text: does this layer
 * decode to something worth keeping? The OCR parser asks the same question
 * per page that the probe asks per document — a scanned book's digitally
 * generated title page keeps its real text layer while the photographed body
 * is recognised from imagery.
 */
export function usableTextLayer(text: string): boolean {
  return (
    cidEscapeRatio(text) <= 0.1 &&
    printableRatio(text) >= 0.6 &&
    replacementRatio(text) <= 0.02
  );
}

/**
 * At most this fraction of sampled pages may carry text for a document still
 * to count as a scan. Front matter is often digitally generated even when the
 * body was photographed, so the test cannot be "no text anywhere".
 */
const IMAGE_ONLY_TEXT_RATIO = 0.25;

export async function probePdf(src: DocumentSource): Promise<PdfProbe> {
  // Shares the source's one pdfjs document with the parser that follows it,
  // and does not dispose it: the source owns that.
  const { doc } = await loadPdf(src);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const sampledPages = samplePageNumbers(doc.numPages);

  let pagesWithText = 0;
  let pagesWithImagery = 0;
  const mojibakePages: number[] = [];

  for (const pageNumber of sampledPages) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((i) => ("str" in i ? i.str : ""))
      .join("")
      .trim();

    if (text.length >= 20) {
      pagesWithText++;
      if (!usableTextLayer(text)) {
        mojibakePages.push(pageNumber);
      }
    } else {
      const ops = await page.getOperatorList();
      if (ops.fnArray.includes(pdfjs.OPS.paintImageXObject)) pagesWithImagery++;
    }
  }

  // Scans: essentially no extractable text, but ink on the page.
  //
  // A RATIO, not `pagesWithText === 0`. Requiring every sampled page to be
  // textless meant one digitally-generated page among the samples — a title
  // page, a copyright page, a publisher's colophon, which scanned books
  // routinely carry — flipped this to false and let the scan through. It then
  // ingested as a document containing almost nothing, which is exactly the
  // outcome this check exists to prevent, and a later search finding nothing
  // is indistinguishable from a topic the book does not cover.
  const withText = pagesWithText / sampledPages.length;
  const imageOnly = pagesWithImagery > 0 && withText <= IMAGE_ONLY_TEXT_RATIO;
  // A text layer that decodes to noise on most of what was sampled.
  const mojibake = pagesWithText > 0 && mojibakePages.length / pagesWithText >= 0.5;

  let detail: string | null = null;
  if (imageOnly) {
    detail =
      `only ${pagesWithText} of ${sampledPages.length} sampled page(s) carry extractable ` +
      `text, and image content is present — this looks like a scan`;
  } else if (mojibake) {
    detail =
      `the text layer decodes to noise on ${mojibakePages.length} of ` +
      `${pagesWithText} sampled page(s) (pages ${mojibakePages.join(", ")})`;
  }

  return { imageOnly, mojibake, sampledPages, detail };
}
