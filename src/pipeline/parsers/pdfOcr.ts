import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  BBox,
  DocBlock,
  DocumentMetadata,
  DocumentParser,
  DocumentSource,
} from "../ir.js";
import {
  assembleLines,
  isPageNumberLine,
  loadPdf,
  pdfMetadata,
  type PdfLine,
} from "./pdfCommon.js";
import { bookmarkTrails, joinWrapped } from "./pdfFast.js";
import { usableTextLayer } from "./pdfProbe.js";
import {
  acquireOcrScheduler,
  OCR_RENDER_DPI,
  type OcrScheduler,
} from "./ocrPool.js";

/**
 * Scanned or garbled PDF -> IR, by rasterising pages and recognising them.
 *
 * This is the route the probe used to refuse. It decides per page rather than
 * per document: a scanned book's digitally generated front matter keeps its
 * real text layer, and only pages without a usable layer pay for OCR. The
 * text-layer half deliberately skips pdfFast's document-wide font analysis —
 * heading tiers learned from a handful of digital pages say nothing about a
 * photographed body, so structure comes from embedded bookmarks alone.
 */

/** Cap on the rasterised long side; an A4/letter page at 300 DPI fits under it. */
const OCR_MAX_DIM = 4096;
/** Tesseract line confidence (0..100) below which a line is dropped as noise. */
const OCR_MIN_LINE_CONFIDENCE = 40;
/** A page whose text layer is shorter than this is treated as having none. */
const TEXT_LAYER_MIN_CHARS = 50;
/** Vertical gap, as a multiple of font size, that ends a text-layer paragraph. */
const PARAGRAPH_GAP_RATIO = 1.6;

export interface PdfOcrOptions {
  lang: string;
  workers: number;
  cacheDir: string;
  /** Local traineddata directory; tests use it to stay offline. */
  langPath?: string;
  /**
   * Recognise every page from imagery, even where a text layer looks usable.
   * Set by the router when the probe's verdict was mojibake without imagery:
   * wrong-encoding text can be printable enough to pass the per-page gates,
   * and a garbage layer must not win the per-page vote.
   */
  forceOcr?: boolean;
}

/** What one page contributes, before section trails are applied in order. */
type PageBlock = Omit<DocBlock, "sectionPath">;

export class PdfOcrParser implements DocumentParser {
  constructor(private readonly opts: PdfOcrOptions) {}

  metadata(src: DocumentSource): Promise<DocumentMetadata> {
    return pdfMetadata(src);
  }

  async *parse(src: DocumentSource): AsyncIterable<DocBlock> {
    const loaded = await loadPdf(src);
    const { doc } = loaded;
    const labels = await doc.getPageLabels();

    // OCR emits no headings, so the section trail is a pure function of page
    // index — the most recent bookmark at or before it — and can be computed
    // up front instead of sequencing the pipeline.
    const byPage = await bookmarkTrails(loaded);
    const trails: string[][] = [];
    let trail: string[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      trail = byPage.get(i) ?? trail;
      trails.push(trail);
    }

    const scheduler = await acquireOcrScheduler({
      lang: this.opts.lang,
      workers: this.opts.workers,
      cacheDir: this.opts.cacheDir,
      ...(this.opts.langPath ? { langPath: this.opts.langPath } : {}),
    });

    // Keep up to `workers` pages in flight — rasterisation on this thread,
    // recognition on the pool's worker threads — but yield strictly in page
    // order. This window is what makes --ocr-workers a throughput lever while
    // ingest concurrency stays at one document.
    const window: Promise<PageBlock[]>[] = [];
    let nextToStart = 1;
    const start = () => {
      if (nextToStart <= doc.numPages) {
        window.push(this.processPage(doc, nextToStart++, labels, scheduler));
      }
    };
    for (let i = 0; i < Math.max(1, this.opts.workers); i++) start();

    let pageIndex = 0;
    while (window.length > 0) {
      const blocks = await window.shift()!;
      start();
      for (const block of blocks) {
        yield { ...block, sectionPath: trails[pageIndex] ?? [] };
      }
      pageIndex++;
    }
  }

  private async processPage(
    doc: Awaited<ReturnType<typeof loadPdf>>["doc"],
    pageNumber: number,
    labels: string[] | null,
    scheduler: OcrScheduler,
  ): Promise<PageBlock[]> {
    const page = await doc.getPage(pageNumber);
    const printed = labels?.[pageNumber - 1];
    const locator = {
      type: "page" as const,
      value: String(pageNumber),
      ordinal: pageNumber - 1,
      ...(printed && printed !== String(pageNumber) ? { printedLabel: printed } : {}),
    };

    const content = await page.getTextContent();
    const lines = assembleLines(content.items).filter(
      (line) => line.text.length > 0 && !isPageNumberLine(line.text),
    );
    const layerText = lines.map((l) => l.text).join(" ").trim();

    if (
      !this.opts.forceOcr &&
      layerText.length >= TEXT_LAYER_MIN_CHARS &&
      usableTextLayer(layerText)
    ) {
      return textLayerBlocks(page, lines, locator);
    }
    return ocrBlocks(page, scheduler, locator);
  }
}

/** The locator shape both paths share. */
type PageLocator = DocBlock["locator"];

/**
 * Paragraphs from a page that kept its real text layer, using pdfFast's gap
 * heuristic but none of its font analysis: everything is a paragraph here.
 */
function textLayerBlocks(
  page: PDFPageProxy,
  lines: PdfLine[],
  locator: PageLocator,
): PageBlock[] {
  const viewport = page.getViewport({ scale: 1 });
  const toBBox = (group: PdfLine[]): BBox => {
    const x0 = Math.min(...group.map((l) => l.x0));
    const x1 = Math.max(...group.map((l) => l.x1));
    const top = Math.max(...group.map((l) => l.yTop));
    const bottom = Math.min(...group.map((l) => l.yBaseline));
    return [
      x0 / viewport.width,
      (viewport.height - top) / viewport.height,
      (x1 - x0) / viewport.width,
      (top - bottom) / viewport.height,
    ];
  };

  const blocks: PageBlock[] = [];
  let paragraph: PdfLine[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      kind: "paragraph",
      text: joinWrapped(paragraph),
      locator,
      bbox: toBBox(paragraph),
    });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const previous = lines[i - 1];
    const gap = previous ? previous.yBaseline - line.yBaseline : 0;
    const broke =
      previous !== undefined &&
      (gap > line.size * PARAGRAPH_GAP_RATIO ||
        Math.abs(previous.size - line.size) > 0.6 ||
        gap < 0);
    if (broke) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Paragraphs recognised from the page's imagery. */
async function ocrBlocks(
  page: PDFPageProxy,
  scheduler: OcrScheduler,
  locator: PageLocator,
): Promise<PageBlock[]> {
  const { png, width, height } = await renderPageToPng(page);
  const result = await scheduler.addJob("recognize", png, {}, { text: true, blocks: true });

  const blocks: PageBlock[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs) {
      const kept = para.lines
        .map((line) => ({ ...line, text: line.text.trim() }))
        .filter((line) => line.text.length > 0 && line.confidence >= OCR_MIN_LINE_CONFIDENCE);
      if (kept.length === 0) continue;
      const text = joinWrapped(kept);
      if (text.trim().length === 0 || isPageNumberLine(text)) continue;
      blocks.push({
        kind: "paragraph",
        text,
        locator,
        // Tesseract's coordinates are already top-left pixels — the IR's
        // convention — so normalising is all that is needed, no flip.
        bbox: [
          para.bbox.x0 / width,
          para.bbox.y0 / height,
          (para.bbox.x1 - para.bbox.x0) / width,
          (para.bbox.y1 - para.bbox.y0) / height,
        ],
      });
    }
  }
  return blocks;
}

/**
 * Rasterise a page for recognition.
 *
 * PNG rather than raw pixels because the tesseract worker's input is a file
 * for Leptonica to decode; PNG is lossless and @napi-rs/canvas encodes it
 * natively. The white fill matters: pages are transparent where nothing
 * paints, and undefined pixels are noise to a binariser.
 */
async function renderPageToPng(
  page: PDFPageProxy,
): Promise<{ png: Buffer; width: number; height: number }> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    OCR_RENDER_DPI / 72,
    OCR_MAX_DIM / Math.max(base.width, base.height),
  );
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // pdfjs v6 wants a DOM canvas; the supported escape hatch for a foreign
  // context is canvas: null plus canvasContext.
  await page.render({ canvas: null, canvasContext: ctx as never, viewport }).promise;
  return { png: canvas.encodeSync("png"), width, height };
}
