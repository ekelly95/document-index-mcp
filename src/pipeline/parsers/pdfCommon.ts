import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentMetadata, DocumentSource } from "../ir.js";

/**
 * Shared pdfjs plumbing for the fast parser and the probe.
 *
 * The legacy build is used deliberately: it targets older JS environments and
 * avoids the DOM assumptions the modern build makes, which is what a Node
 * process needs.
 */

const require = createRequire(import.meta.url);

/**
 * Where pdfjs finds its bundled Type1 fonts. Must be a file:// URL ending in a
 * literal "/": pdfjs rejects a Windows path ending in a backslash.
 */
function standardFontDataUrl(): string {
  const pkg = require.resolve("pdfjs-dist/package.json");
  return `${pathToFileURL(path.join(path.dirname(pkg), "standard_fonts")).href}/`;
}

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  close: () => Promise<void>;
}

/**
 * The pdfjs document for a source, built once and shared by the probe, the
 * metadata pass and the parse; disposed when the source closes.
 */
export function loadPdf(src: DocumentSource): Promise<LoadedPdf> {
  return src.derive(
    "pdfjs",
    () => openPdf(src),
    (loaded) => loaded.close(),
  );
}

/**
 * Does this page paint an image? Asked only of pages with no usable text, so
 * the operator list (a full content-stream walk) is rarely paid for.
 */
export async function paintsImage(page: PDFPageProxy): Promise<boolean> {
  const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const ops = await page.getOperatorList();
  return ops.fnArray.some(
    (fn) =>
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat,
  );
}

async function openPdf(src: DocumentSource): Promise<LoadedPdf> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    // A copy: pdfjs takes ownership of the buffer and detaches it, which would
    // break every later reader of `src.bytes`.
    data: new Uint8Array(src.bytes),
    standardFontDataUrl: standardFontDataUrl(),
    // No worker fetch and no system font probing: this is a local batch
    // process with no network and no font stack to consult.
    useWorkerFetch: false,
    useSystemFonts: false,
    // pdfjs loads its bundled fonts through fetch()/XMLHttpRequest, neither of
    // which handles file:// under Node, and v6 exposes no factory override —
    // so it warns once per font per document no matter what is passed. The
    // consequence is limited (embedded fonts come from the PDF itself, and the
    // standard 14 have built-in metrics tables), but an MCP server writing a
    // warning per page to stderr is noise. Errors still surface.
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });

  const doc = await task.promise;
  return {
    doc,
    close: async () => {
      await task.destroy();
    },
  };
}

/**
 * Placeholder titles authoring tools write into every file, which are worse
 * than the filename ("PowerPoint Presentation", a print shop's "201-635.job").
 * Rather than enumerate every language's phrasing, product names, generic words
 * and connectives are stripped and the title is kept only if something is left:
 * "Presentación de PowerPoint" reduces to nothing, "PowerPoint for Beginners"
 * keeps "forBeginners".
 */
const TITLE_PRODUCT = /\b(?:microsoft\s+)?(?:powerpoint|word|excel|impress|keynote)\b/gi;
const TITLE_GENERIC =
  /\b(?:presentations?|présentations?|presentaci[óo]n|apresenta[çc][ãa]o|presentazione|pr[äa]sentation|prezentacja|presentatie|slides?|deck|documento?s?|dokumente?|untitled|no\s+title|sin\s+t[íi]tulo|sem\s+t[íi]tulo|ohne\s+titel|sans\s+titre)\d*\b/gi;
/** Connectives and bare numbers, which carry no meaning on their own. */
const TITLE_FILLER = /\b(?:de|del|do|da|du|di|van|der|the|a|an)\b|\d+/gi;

/**
 * A print driver's title, which is the SOURCE FILENAME with the application
 * bolted on. Rejecting it loses nothing: the filename fallback recovers the
 * same words without the prefix.
 */
const PRINT_DRIVER_TITLE = /^microsoft\s+(?:word|powerpoint|excel)\s*[-–]\s*/i;

/** Is an embedded document title worth preferring over the filename? */
export function usableTitle(raw: string | null | undefined): string | null {
  const title = raw?.trim() ?? "";
  if (title.length === 0) return null;
  if (PRINT_DRIVER_TITLE.test(title)) return null;
  // A title that is a filename tells the reader nothing the path did not.
  if (/\.[a-z0-9]{2,4}$/i.test(title)) return null;

  const residue = title
    .replace(TITLE_PRODUCT, " ")
    .replace(TITLE_GENERIC, " ")
    .replace(TITLE_FILLER, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (residue.length === 0) return null;

  return title;
}

/**
 * Document metadata common to every PDF route: the embedded Title when one
 * exists and says something, the filename otherwise, and the physical page
 * count.
 */
export async function pdfMetadata(src: DocumentSource): Promise<DocumentMetadata> {
  const { doc } = await loadPdf(src);
  const info = await doc.getMetadata().catch(() => null);
  const title = usableTitle((info?.info as { Title?: string } | undefined)?.Title);
  return {
    title: title ?? path.basename(src.absPath, path.extname(src.absPath)),
    locatorScheme: "page",
    locatorCount: doc.numPages,
  };
}

/**
 * Roman numerals by their real grammar and in one case: the old `[ivxlcdm]+`
 * deleted lines like "civil", "mild" and "did" as page numbers.
 */
const ROMAN = "m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})";
const PAGE_NUMBER_LINE = new RegExp(
  `^\\s*(?:${ROMAN}|${ROMAN.toUpperCase()}|\\d{1,4}|[Pp]age\\s+\\d{1,4})[\\s.]*$`,
);

/**
 * A page number printed alone in a margin, which carries no content.
 *
 * A bare uppercase "I" is deliberately NOT treated as one. It is a valid roman
 * numeral, but front matter is numbered in lowercase by convention, whereas a
 * line containing only "I" is ordinary English.
 */
export function isPageNumberLine(text: string): boolean {
  if (/^\s*I[\s.]*$/.test(text)) return false;
  return text.trim().length > 0 && PAGE_NUMBER_LINE.test(text);
}

/** One rendered text line, assembled from pdfjs text items. */
export interface PdfLine {
  text: string;
  /** PDF user space (origin bottom-left). */
  x0: number;
  x1: number;
  yBaseline: number;
  yTop: number;
  /** Font size in points, from the text matrix scale. */
  size: number;
  /** pdfjs font id of the line's largest run; a heading style is a size AND a face. */
  font: string;
}

/**
 * getTextContent() yields a union of real text items and marked-content
 * markers. Only the former carry a transform, so the discrimination is done
 * here rather than at every call site.
 */
interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  /** Present only on marked-content markers; keeps the union assignable. */
  type?: string;
}
type RealTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
};

function isTextItem(item: TextItemLike): item is RealTextItem {
  return (
    typeof item.str === "string" &&
    Array.isArray(item.transform) &&
    typeof item.width === "number" &&
    typeof item.height === "number"
  );
}

/** A row this fraction of the text extent wide counts as spanning the page. */
const FULL_WIDTH_RATIO = 0.8;
/** A vertical gap this many times the line height starts a new band. */
const BAND_GAP_RATIO = 2.5;
/** A gutter must be at least this many times the band's font size... */
const MIN_GUTTER_RATIO = 1.2;
/** ...and at least this fraction of the text extent, for very small type. */
const MIN_GUTTER_FRACTION = 0.03;
/** Below this many rows, an internal gap is likelier a table than a column. */
const MIN_BAND_ROWS_FOR_COLUMNS = 3;
/** Resolution of the x-occupancy histogram used to find gutters. */
const OCCUPANCY_BUCKETS = 240;

interface Part {
  str: string;
  font: string;
  x0: number;
  x1: number;
  size: number;
}

interface Row {
  parts: Part[];
  yBaseline: number;
  yTop: number;
  size: number;
  /** x positions of whitespace-only items, which are explicit word breaks. */
  spaces: number[];
}

/** A horizontal span in PDF user space. */
interface Extent {
  min: number;
  max: number;
}

/**
 * Assemble pdfjs text items into lines, in reading order.
 *
 * Items are grouped by baseline rather than `hasEOL`, which pdfjs uses
 * inconsistently. On a two-column page the columns share baselines, so the page
 * is split into bands (at full-width rows and large vertical gaps) and each band
 * is searched for a gutter: a vertical strip no individual run crosses. Bands
 * with a gutter are emitted column by column; without this, two-column papers
 * read line-interleaved while still citing the right page.
 */
export function assembleLines(
  items: readonly TextItemLike[],
  tolerance = 2,
): PdfLine[] {
  const rows = groupByBaseline(items, tolerance);
  if (rows.length === 0) return [];

  const extent = textExtent(rows);
  return splitIntoBands(rows, extent).flatMap((band) => orderBand(band, extent));
}

/**
 * Is this run set on a horizontal baseline (`|b| <= |a|` in its text matrix)?
 * Sideways margin text such as arXiv's stamp is furniture: its size reads as its
 * width, making it the largest "heading", and its height is taken as width,
 * erasing the gutter column detection needs.
 */
function isUpright(item: RealTextItem): boolean {
  return Math.abs(item.transform[1] ?? 0) <= Math.abs(item.transform[0] ?? 0);
}

/** Runs sharing a baseline, grouped into rows and ordered down the page. */
function groupByBaseline(items: readonly TextItemLike[], tolerance: number): Row[] {
  const upright = items.filter((i): i is RealTextItem => isTextItem(i) && isUpright(i));

  const rows: Row[] = [];
  for (const item of upright) {
    if (item.str.trim().length === 0) continue;
    const size = Math.abs(item.transform[0] ?? item.height) || item.height;
    const x0 = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const part: Part = { str: item.str, font: item.fontName ?? "", x0, x1: x0 + item.width, size };

    const row = rows.find((r) => Math.abs(r.yBaseline - y) <= tolerance);
    if (row) {
      row.parts.push(part);
      row.size = Math.max(row.size, size);
      row.yTop = Math.max(row.yTop, y + size);
    } else {
      rows.push({ parts: [part], yBaseline: y, yTop: y + size, size, spaces: [] });
    }
  }

  // A whitespace-only item is the PDF saying "word break here". Dropping it and
  // inferring spaces from geometry alone lost them wherever the space glyph is
  // narrow: "Adequate Intakes for" + " " + "Chromium" became "forChromium".
  for (const item of upright) {
    if (item.str.length === 0 || item.str.trim().length > 0) continue;
    const y = item.transform[5] ?? 0;
    rows.find((r) => Math.abs(r.yBaseline - y) <= tolerance)?.spaces.push(item.transform[4] ?? 0);
  }

  // Down the page. Order WITHIN a row is decided per band, below.
  return rows.flatMap(splitMixedRow).sort((a, b) => b.yBaseline - a.yBaseline);
}

/**
 * Split a row where runs of clearly different sizes sit far apart.
 *
 * A sidebar's body line and a heading in the next column can share a
 * baseline; merged, the row took the heading's size and the whole thing — "body
 * caused by free radicals. Vitamins" — became a heading. Adjacent runs of
 * different sizes (a large word inside a title) stay together.
 */
function splitMixedRow(row: Row): Row[] {
  const ordered = [...row.parts].sort((a, b) => a.x0 - b.x0);
  const segments: Part[][] = [];
  for (const part of ordered) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    const apart =
      previous !== undefined &&
      part.x0 - previous.x1 > 1.5 * Math.max(part.size, previous.size) &&
      Math.max(part.size, previous.size) / Math.min(part.size, previous.size) > 1.15;
    if (!current || apart) segments.push([part]);
    else current.push(part);
  }
  if (segments.length === 1) return [row];
  return segments.map((parts) => {
    const size = Math.max(...parts.map((p) => p.size));
    return { parts, yBaseline: row.yBaseline, yTop: row.yBaseline + size, size, spaces: row.spaces };
  });
}

/** The horizontal span of everything on the page. */
function textExtent(rows: readonly Row[]): Extent {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.x0 < min) min = part.x0;
      if (part.x1 > max) max = part.x1;
    }
  }
  return { min, max };
}

const rowStart = (row: Row): number => Math.min(...row.parts.map((p) => p.x0));
const rowEnd = (row: Row): number => Math.max(...row.parts.map((p) => p.x1));

/** How wide a blank strip has to be before it reads as a gutter, not a space. */
const minGutterFor = (size: number, width: number): number =>
  Math.max(size * MIN_GUTTER_RATIO, width * MIN_GUTTER_FRACTION);

/** The widest blank strip between consecutive runs on one baseline. */
function largestInternalGap(row: Row): number {
  const ordered = [...row.parts].sort((a, b) => a.x0 - b.x0);
  let largest = 0;
  for (let i = 1; i < ordered.length; i++) {
    largest = Math.max(largest, ordered[i]!.x0 - ordered[i - 1]!.x1);
  }
  return largest;
}

/**
 * Break the page where a column layout cannot continue across: at a row that
 * spans the page without a gap (a title, abstract or wide figure) and at a
 * large vertical gap, which keeps a footer out of the gutter.
 */
function splitIntoBands(rows: readonly Row[], extent: Extent): Row[][] {
  const width = extent.max - extent.min;
  const bands: Row[][] = [];
  let current: Row[] = [];
  let previous: Row | null = null;

  for (const row of rows) {
    // Wide AND unbroken. Checking only the extent was wrong in the one case
    // this whole function exists for: a row that has already merged the left
    // and right columns reaches from margin to margin, so every body row of a
    // two-column page looked like a full-width title and was banded off on its
    // own — which left no band with enough rows to find a gutter in. A title
    // is one continuous run; two columns on one baseline have the gutter
    // sitting in the middle of them.
    const spansPage =
      width > 0 &&
      rowEnd(row) - rowStart(row) >= width * FULL_WIDTH_RATIO &&
      largestInternalGap(row) < minGutterFor(row.size, width);
    const farBelow =
      previous !== null &&
      previous.yBaseline - row.yBaseline > Math.max(previous.size, row.size) * BAND_GAP_RATIO;

    if (spansPage || farBelow) {
      if (current.length > 0) bands.push(current);
      current = [];
    }
    current.push(row);

    // A full-width row closes its own band as well as opening it.
    if (spansPage) {
      bands.push(current);
      current = [];
      previous = null;
      continue;
    }
    previous = row;
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

/** Emit one band, column by column where it has columns. */
function orderBand(band: readonly Row[], extent: Extent): PdfLine[] {
  const columns = findColumns(band, extent);
  if (columns === null) return band.map((row) => lineFrom(row.parts, row));

  const out: PdfLine[] = [];
  for (const column of columns) {
    for (const row of band) {
      const parts = row.parts.filter((p) => inColumn(p, column));
      if (parts.length > 0) out.push(lineFrom(parts, row));
    }
  }
  return out;
}

const midpoint = (part: Part): number => (part.x0 + part.x1) / 2;
const inColumn = (part: Part, column: Extent): boolean =>
  midpoint(part) >= column.min && midpoint(part) < column.max;

/**
 * The column ranges in a band, or null if it is a single column.
 *
 * Occupancy is built from individual runs rather than row extents: a row that
 * already merged the two columns spans the gutter, and only the gap between its
 * runs shows where that gutter is.
 */
function findColumns(band: readonly Row[], extent: Extent): Extent[] | null {
  const width = extent.max - extent.min;
  if (band.length < MIN_BAND_ROWS_FOR_COLUMNS || width <= 0) return null;

  const bucket = width / OCCUPANCY_BUCKETS;
  const occupied = new Array<boolean>(OCCUPANCY_BUCKETS).fill(false);
  for (const row of band) {
    for (const part of row.parts) {
      const from = Math.max(0, Math.floor((part.x0 - extent.min) / bucket));
      const to = Math.min(OCCUPANCY_BUCKETS, Math.ceil((part.x1 - extent.min) / bucket));
      for (let i = from; i < to; i++) occupied[i] = true;
    }
  }

  const sizes = band.map((r) => r.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const minGutter = minGutterFor(median, width);

  // Maximal unoccupied runs that touch neither edge: a margin is not a gutter.
  const gutters: Extent[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < OCCUPANCY_BUCKETS; i++) {
    if (!occupied[i]) {
      runStart ??= i;
      continue;
    }
    if (runStart !== null && runStart > 0) {
      const gutter = { min: extent.min + runStart * bucket, max: extent.min + i * bucket };
      if (gutter.max - gutter.min >= minGutter) gutters.push(gutter);
    }
    runStart = null;
  }
  if (gutters.length === 0) return null;

  const columns: Extent[] = [];
  let left = extent.min;
  for (const gutter of gutters) {
    columns.push({ min: left, max: gutter.min });
    left = gutter.max;
  }
  // +1 so the rightmost run, whose midpoint can equal extent.max, still lands.
  columns.push({ min: left, max: extent.max + 1 });

  // Every column has to look like one. A single indented run beside a block of
  // text is not a two-column layout, and reordering on that basis would
  // scramble a page that was fine.
  const rowsIn = (column: Extent): number =>
    band.filter((row) => row.parts.some((p) => inColumn(p, column))).length;
  return columns.every((column) => rowsIn(column) >= 2) ? columns : null;
}

/** Render one set of runs sharing a baseline into a line. */
function lineFrom(parts: readonly Part[], row: Row): PdfLine {
  const ordered = [...parts].sort((a, b) => a.x0 - b.x0);
  const size = Math.max(...ordered.map((p) => p.size));

  let text = "";
  let previousX1: number | null = null;
  for (const part of ordered) {
    // A space the PDF wrote as its own item, or one a positioning operator
    // implied by leaving a gap.
    const explicit =
      previousX1 !== null &&
      row.spaces.some((x) => x >= previousX1! - 1 && x <= part.x0 + 1);
    const implied = previousX1 !== null && part.x0 - previousX1 > size * 0.2;
    if ((explicit || implied) && text.length > 0 && !text.endsWith(" ")) {
      text += " ";
    }
    text += part.str;
    previousX1 = part.x1;
  }

  const largest = ordered.reduce((a, b) => (b.size > a.size ? b : a));
  return {
    text: text.replace(/\s+/g, " ").trim(),
    font: largest.font,
    x0: Math.min(...ordered.map((p) => p.x0)),
    x1: Math.max(...ordered.map((p) => p.x1)),
    yBaseline: row.yBaseline,
    yTop: row.yBaseline + size,
    size,
  };
}

/** Evenly spaced sample page numbers (1-based), for probing a large document cheaply. */
export function samplePageNumbers(pageCount: number, max = 8): number[] {
  const count = Math.min(max, Math.max(1, Math.min(pageCount, Math.ceil(pageCount / 40) || 1)));
  const target = Math.max(count, Math.min(pageCount, 3));
  const step = pageCount / target;
  const pages = new Set<number>();
  for (let i = 0; i < target; i++) {
    pages.add(Math.min(pageCount, Math.floor(i * step) + 1));
  }
  // The last page, always. `floor(i * step) + 1` for i < target lands on the
  // START of each slice, so the final page of a document was never sampled —
  // and the end is where a scanned appendix, a photographed set of plates or an
  // index set in an unmapped font is most likely to be hiding.
  pages.add(pageCount);
  return [...pages].sort((a, b) => a - b);
}
