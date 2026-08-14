import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
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
 * Where pdfjs finds its bundled Type1 fonts. Without them text metrics degrade
 * and every load logs a warning.
 *
 * It must be a file:// URL with a literal trailing "/" — pdfjs validates for
 * that character specifically, so a Windows path ending in a backslash is
 * rejected outright.
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
 * The pdfjs document for a source, built at most once.
 *
 * The probe, the metadata pass and the parse each need a PDFDocumentProxy, and
 * each used to build its own from its own fresh read of the file — three full
 * reads and three full parses per ingest, plus a re-import of pdfjs and a
 * re-resolution of the standard font directory every time. Memoising on the
 * source collapses that to one without any of the three having to know the
 * others exist.
 *
 * Disposal is registered with the memo, so `DocumentSource.close()` tears the
 * document down when the ingest ends, whether it succeeded or threw.
 */
export function loadPdf(src: DocumentSource): Promise<LoadedPdf> {
  return src.derive(
    "pdfjs",
    () => openPdf(src),
    (loaded) => loaded.close(),
  );
}

async function openPdf(src: DocumentSource): Promise<LoadedPdf> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    // A COPY, and it has to be. pdfjs takes ownership of whatever is passed
    // here and detaches the underlying ArrayBuffer, so handing it the source's
    // own bytes leaves every later reader of `src.bytes` holding a detached
    // view — "Cannot perform Construct on a detached ArrayBuffer" from
    // something as innocent as re-sniffing the format afterwards.
    //
    // The copy is not new cost: the previous implementation copied too
    // (`new Uint8Array(await fs.readFile(...))`), three times per ingest
    // instead of once.
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
 * Placeholder titles that authoring tools write into every file they produce.
 *
 * These are worse than no title at all, because the filename fallback would
 * have said something true. Measured on real documents: the 9/11 Commission
 * Report ships with `201-635.job` — the print shop's job name — and an
 * untouched deck ships with `PowerPoint Presentation`.
 *
 * The rule used to be one alternation of English strings, and a corpus of
 * downloaded decks showed why that is not enough: PowerPoint localises its
 * placeholder, so a Spanish deck ships `Presentación de PowerPoint` and a
 * Portuguese one `Apresentação do PowerPoint`. Two of six sample decks indexed
 * under a title that means "a PowerPoint file" in a language the pattern did
 * not cover.
 *
 * Enumerating every language's phrasing would also have to enumerate its word
 * ORDER — English puts the product first, Spanish last, German hyphenates.
 * So instead of matching the whole phrase, the parts are stripped and the
 * question becomes whether anything meaningful is left. "PowerPoint for
 * Beginners" keeps "forBeginners" and survives; "Presentación de PowerPoint"
 * reduces to nothing and does not.
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
 * Roman numerals, properly — not "any word spelled from i/v/x/l/c/d/m".
 *
 * The earlier pattern was `[ivxlcdm]+` under `/i`, which deleted any line
 * consisting of one such word: `civil`, `mild`, `mill`, `did`, `DVD`, `LCD`.
 * That is silent content loss, not a formatting nit — a paragraph reading only
 * "I" vanished from the index. This requires the real grammar and a single
 * case, since printed page numbers are never mixed-case.
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
  /** Present only on marked-content markers; keeps the union assignable. */
  type?: string;
}
type RealTextItem = { str: string; transform: number[]; width: number; height: number };

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
  x0: number;
  x1: number;
  size: number;
}

interface Row {
  parts: Part[];
  yBaseline: number;
  yTop: number;
  size: number;
}

/** A horizontal span in PDF user space. */
interface Extent {
  min: number;
  max: number;
}

/**
 * Assemble pdfjs text items into lines, in reading order.
 *
 * Items are grouped by baseline rather than by the `hasEOL` flag: pdfjs emits
 * zero-width items purely as line-break markers, and real documents interleave
 * runs (a bold word mid-sentence) that share a baseline but arrive as separate
 * items. Baseline proximity is the signal that survives both.
 *
 * COLUMNS, which is why this is more than a sort.
 *
 * Grouping by baseline alone is right for one column and wrong for two. On a
 * two-column paper the first line of the left column and the first line of the
 * right column share a baseline, so they merged into a single row and were then
 * concatenated left to right, interleaving the columns line by line down the
 * whole page. Everything downstream inherited the scrambled text with no signal
 * that anything had happened — and because locators stayed page-true, the
 * citation pointed confidently at the right page of nonsense. Two-column papers
 * are most of what a scholarly library holds.
 *
 * So the page is split into bands: at full-width rows (titles, abstracts,
 * spanning figures), because whatever columns exist above one are not the
 * columns below it, and at large vertical gaps, which is also what keeps a
 * centred page number out of the gutter it would otherwise hide. Within a band
 * a gutter is a vertical strip no text run crosses, found from individual runs
 * rather than row extents — precisely because a row that already merged both
 * columns spans the gutter, and only the gap BETWEEN its runs reveals it.
 * Bands with a gutter are emitted column by column; bands without one behave
 * exactly as before.
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
 * Is this run set on a horizontal baseline?
 *
 * The text matrix is `[a b c d e f]`, where `a` carries `fontSize·cos θ` and
 * `b` carries `fontSize·sin θ`, so `|b| > |a|` means the run is turned more
 * than 45° off horizontal.
 *
 * Sideways runs are margin furniture — arXiv's submission stamp is the case
 * that forced this — and letting one into the line stream does two kinds of
 * damage. Its size is read from `transform[0]`, which is ≈0 when rotated, so
 * the `|| item.height` fallback hands back the glyph box's WIDTH instead:
 * measured at 20pt on a paper whose real title is 14.5pt, which made the stamp
 * the largest "heading" in the document and re-based the whole section trail
 * under it. And `x1 = x0 + width` treats its 300pt vertical extent as
 * horizontal, inflating the page's text extent and erasing the gutter that
 * two-column detection depends on.
 */
function isUpright(item: RealTextItem): boolean {
  return Math.abs(item.transform[1] ?? 0) <= Math.abs(item.transform[0] ?? 0);
}

/** Runs sharing a baseline, grouped into rows and ordered down the page. */
function groupByBaseline(items: readonly TextItemLike[], tolerance: number): Row[] {
  const real = items.filter(
    (i): i is RealTextItem =>
      isTextItem(i) && i.str.trim().length > 0 && isUpright(i),
  );

  const rows: Row[] = [];
  for (const item of real) {
    const size = Math.abs(item.transform[0] ?? item.height) || item.height;
    const x0 = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const part: Part = { str: item.str, x0, x1: x0 + item.width, size };

    const row = rows.find((r) => Math.abs(r.yBaseline - y) <= tolerance);
    if (row) {
      row.parts.push(part);
      row.size = Math.max(row.size, size);
      row.yTop = Math.max(row.yTop, y + size);
    } else {
      rows.push({ parts: [part], yBaseline: y, yTop: y + size, size });
    }
  }

  // Down the page. Order WITHIN a row is decided per band, below.
  rows.sort((a, b) => b.yBaseline - a.yBaseline);
  return rows;
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
 * Break the page where a column layout cannot continue across.
 *
 * A row spanning most of the text extent is a title, an abstract or a wide
 * figure, and the columns above it are not the columns below it. A large
 * vertical gap does the same job for a running footer, which would otherwise
 * land in the gutter and hide it.
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
    // Re-insert the space that a positioning operator implied rather than wrote.
    if (previousX1 !== null && part.x0 - previousX1 > size * 0.2 && !text.endsWith(" ")) {
      text += " ";
    }
    text += part.str;
    previousX1 = part.x1;
  }

  return {
    text: text.replace(/\s+/g, " ").trim(),
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
