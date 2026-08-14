import type {
  BBox,
  DocBlock,
  DocumentMetadata,
  DocumentParser,
  DocumentSource,
} from "../ir.js";
import { log } from "../../log.js";
import {
  assembleLines,
  isPageNumberLine,
  loadPdf,
  pdfMetadata,
  samplePageNumbers,
  type LoadedPdf,
  type PdfLine,
} from "./pdfCommon.js";

/**
 * PDF with a usable text layer -> IR.
 *
 * pdfjs-dist rather than the spec's MuPDF.js: mupdf is AGPL-3.0-or-later,
 * which would be viral over this entire server. pdfjs-dist is Apache-2.0 and
 * supplies everything the design needs — per-item text matrices for bbox and
 * font size, getPageLabels() for printed page numbers, getOutline() for
 * embedded bookmarks.
 */

/** A line larger than body text by this factor reads as a heading. */
const HEADING_SIZE_RATIO = 1.15;
/** Vertical gap, as a multiple of font size, that ends a paragraph. */
const PARAGRAPH_GAP_RATIO = 1.6;
/** Pages sampled to learn body font size and running headers. */
const ANALYSIS_SAMPLE = 20;
/** A wrapped heading's continuation may sit this many line heights below it. */
const HEADING_WRAP_GAP_RATIO = 2;
/** Lines a single heading may span, and the characters it may run to. */
const HEADING_WRAP_MAX_LINES = 4;
const HEADING_WRAP_MAX_CHARS = 200;

/**
 * Above BOTH of these, the font-size signal is noise and is discarded.
 *
 * Measured across the stress corpus. A clean document has two to five heading
 * tiers and produces at most ~1.5 heading lines per page; a 408-page scan
 * carrying an OCR text layer produced TWELVE tiers and 6.9 heading lines per
 * page, because OCR font sizes are a near-continuum rather than a few chosen
 * values. Nearly every line cleared the body-size ratio, so 2,824 lines became
 * headings, the outline grew to 2,476 nodes of fragments, and — the damage
 * that matters — every spurious heading became a chunk boundary, shattering
 * the book into 2,766 chunks averaging 65 tokens against a 350 target.
 *
 * Both conditions are required, because either alone has a legitimate
 * counter-example: a glossary is all headings at ONE size, and a title page
 * can carry several sizes across very few lines.
 */
const MAX_TRUSTED_TIERS = 6;
const MAX_TRUSTED_HEADINGS_PER_PAGE = 3;

interface PageAnalysis {
  bodySize: number;
  /** Sizes above body size, largest first. Only ranks a heading; never gates one. */
  headingSizes: number[];
  /** False when the sizes read as OCR noise. See MAX_TRUSTED_* above. */
  trustSizes: boolean;
  /** Normalised text of lines that repeat across pages as headers/footers. */
  runningText: Set<string>;
}

/** One open section, and the font size that opened it. */
interface TrailEntry {
  text: string;
  size: number;
}

const centreOf = (line: PdfLine): number => (line.x0 + line.x1) / 2;

const normalise = (s: string) =>
  s
    .toLowerCase()
    // Dashes and quotes vary between a bookmark and the printed heading it
    // names, and a mismatch there used to nest a section inside itself.
    .replace(/[‐-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/**
 * Does this heading name the section the trail already sits in?
 *
 * A bookmarked section title is usually also printed as a visible heading on
 * its opening page, and extending the trail with it again nests the section
 * inside itself. Equality is not enough: a heading printed across two lines
 * arrives as its own TAIL once the first line has been consumed elsewhere, so
 * `AND TABLES` has to be recognised as part of `List of Illustrations and
 * Tables`. Suffix, not substring — a tail is always a suffix, whereas
 * substring would fold `Introduction` and `Introduction to Statistics`
 * together, and those are two different sections.
 */
function namesSameSection(heading: string, current: string): boolean {
  const a = normalise(heading);
  const b = normalise(current);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.endsWith(short) && /\s/.test(long[long.length - short.length - 1] ?? "");
}

export class PdfFastParser implements DocumentParser {
  async *parse(src: DocumentSource): AsyncIterable<DocBlock> {
    // Not closed here: the source owns the pdfjs document and disposes it
    // when the ingest ends. The probe and the metadata pass share this exact
    // instance rather than each building their own.
    const loaded = await loadPdf(src);
    const { doc } = loaded;
    const labels = await doc.getPageLabels();
    const trailByPage = await bookmarkTrails(loaded);
    const analysis = await analysePages(loaded);

    // Bookmarks and font-size tiers are combined rather than chosen between.
    //
    // Bookmarks are authoritative but coarse — they resolve to a page, so
    // they cannot see a subsection that starts halfway down one. Font-size
    // tiers are finer but noisier. So a bookmark RE-BASES the trail when its
    // section begins, and detected headings extend it from there. Front
    // matter, which usually sits before the first bookmark, still gets a
    // section path from its headings.
    //
    // The trail is a STACK ordered by the font size that opened each section,
    // not an array indexed by heading level. Level came from the tier index,
    // and `trail.slice(0, level - 1)` cannot pad — so a heading whose level
    // exceeded the current depth appended instead of replacing, and equal-sized
    // sections nested inside one another in a staircase. Measured on a paper
    // whose seven numbered sections are all one size: `1 Introduction` >
    // `2 Background` > `3 Model Architecture` > `4 Why Self-Attention`, each a
    // child of the last, when all seven are peers. Popping every entry opened
    // at a size no larger than this one makes equal sizes siblings by
    // construction and makes a bigger heading close everything smaller.
    let stack: TrailEntry[] = [];
    let trail: string[] = [];
    let currentBookmarkKey = "";

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = assembleLines(content.items).filter(
        (line) =>
          line.text.length > 0 &&
          !analysis.runningText.has(normalise(line.text)) &&
          !isPageNumberLine(line.text),
      );

      const bookmark = trailByPage.get(pageNumber - 1);
      if (bookmark) {
        const key = bookmark.join("\u0000");
        // Only on the page where the section actually starts. Re-basing on
        // every page would discard subsection depth built up since.
        if (key !== currentBookmarkKey) {
          // Infinity, so no detected heading can close a bookmarked section —
          // only the next bookmark may. Bookmarks are the authoritative half.
          stack = bookmark.map((text) => ({ text, size: Infinity }));
          trail = [...bookmark];
          currentBookmarkKey = key;
        }
      }

      const printed = labels?.[pageNumber - 1];
      const locator = {
        type: "page" as const,
        value: String(pageNumber),
        ordinal: pageNumber - 1,
        // Only carried when it actually differs — a book with roman-numeral
        // front matter is exactly the case this exists for.
        ...(printed && printed !== String(pageNumber)
          ? { printedLabel: printed }
          : {}),
      };

      const toBBox = (group: PdfLine[]): BBox => {
        const x0 = Math.min(...group.map((l) => l.x0));
        const x1 = Math.max(...group.map((l) => l.x1));
        const top = Math.max(...group.map((l) => l.yTop));
        const bottom = Math.min(...group.map((l) => l.yBaseline));
        // Normalised to 0..1 with a TOP-LEFT origin, because that is what a
        // viewer paints in. PDF user space has its origin bottom-left.
        return [
          x0 / viewport.width,
          (viewport.height - top) / viewport.height,
          (x1 - x0) / viewport.width,
          (top - bottom) / viewport.height,
        ];
      };

      /** Where this page's text actually reaches, for the wrap test above. */
      const rightEdge = lines.reduce((max, l) => Math.max(max, l.x1), 0);

      let paragraph: PdfLine[] = [];
      const flushParagraph = (): DocBlock | null => {
        if (paragraph.length === 0) return null;
        const block: DocBlock = {
          kind: "paragraph",
          text: joinWrapped(paragraph),
          locator,
          sectionPath: trail,
          bbox: toBBox(paragraph),
        };
        paragraph = [];
        return block;
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const level = headingLevelFor(line.size, analysis);

        if (level !== null) {
          const pending = flushParagraph();
          if (pending) yield pending;

          // A heading set too wide for its measure wraps, and each line
          // arrives separately. Left alone they become separate headings of
          // equal size that nest into one another: a report cover reading
          // "THE 9/11" / "COMMISSION" / "REPORT" produced three roots, and a
          // journal title split across two lines put its SECOND half at the
          // top of the outline.
          //
          // Same size, close together and running down the page is necessary
          // but NOT sufficient — a section heading immediately above its first
          // subheading looks identical by those tests, and merging those two
          // destroys a real level of hierarchy. What separates them is shape.
          // A line only wraps because it ran out of measure, so a wrapped
          // heading is either justified (its first line reaches the right edge
          // the page's text uses) or centred (its lines share an axis). Two
          // sibling headings are left-aligned and short.
          const group = [line];
          while (i + 1 < lines.length && group.length < HEADING_WRAP_MAX_LINES) {
            const previous = group[group.length - 1]!;
            const next = lines[i + 1]!;
            const gap = previous.yBaseline - next.yBaseline;
            const centred = Math.abs(centreOf(previous) - centreOf(next)) < line.size;
            const ranToTheEdge = previous.x1 >= rightEdge - line.size;
            if (
              Math.abs(next.size - line.size) >= 0.5 ||
              headingLevelFor(next.size, analysis) === null ||
              gap <= 0 ||
              gap > line.size * HEADING_WRAP_GAP_RATIO ||
              !(centred || ranToTheEdge) ||
              joinWrapped([...group, next]).length > HEADING_WRAP_MAX_CHARS
            ) {
              break;
            }
            group.push(next);
            i++;
          }
          const text = joinWrapped(group);

          const top = stack.at(-1);
          let opensAt = line.size;
          let carried = text;
          if (top && namesSameSection(text, top.text)) {
            // The same section, printed. Keep whichever name is fuller — the
            // bookmark usually has the whole title where the page shows only
            // the line that fitted — and keep its authority.
            carried = top.text.length >= text.length ? top.text : text;
            opensAt = Math.max(top.size, line.size);
            stack.pop();
          } else {
            while (stack.length > 0 && stack[stack.length - 1]!.size <= line.size) {
              stack.pop();
            }
          }

          yield {
            kind: "heading",
            level,
            text,
            locator,
            // Ancestors only, never the heading itself — the same convention
            // the markdown parser uses, so the chunker can rely on it.
            sectionPath: stack.map((e) => e.text),
            bbox: toBBox(group),
            attrs: { fontSize: line.size },
          };

          stack.push({ text: carried, size: opensAt });
          trail = stack.map((e) => e.text);
          continue;
        }

        const previous = lines[i - 1];
        const gap = previous ? previous.yBaseline - line.yBaseline : 0;
        const paragraphBroke =
          previous !== undefined &&
          (gap > line.size * PARAGRAPH_GAP_RATIO ||
            Math.abs(previous.size - line.size) > 0.6 ||
            // Back up the page: assembleLines emits a two-column band column by
            // column, so a jump upwards is the top of the next column. Without
            // this the last sentence of one column and the first of the next
            // are welded into a single paragraph.
            gap < 0);
        if (paragraphBroke) {
          const pending = flushParagraph();
          if (pending) yield pending;
        }
        paragraph.push(line);
      }

      const tail = flushParagraph();
      if (tail) yield tail;
    }
  }

  metadata(src: DocumentSource): Promise<DocumentMetadata> {
    return pdfMetadata(src);
  }
}

/**
 * Rejoin lines the PDF broke for layout.
 *
 * A hyphen at end of line is a soft break introduced by justification, so the
 * word is reassembled; otherwise a space is the right join. Shared with the
 * OCR parser, whose recognised lines wrap for exactly the same reason, so it
 * asks only for `.text`.
 */
export function joinWrapped(lines: readonly { text: string }[]): string {
  let out = "";
  for (const line of lines) {
    if (out.length === 0) {
      out = line.text;
      continue;
    }
    if (/[‐-]$/.test(out)) out = `${out.slice(0, -1)}${line.text}`;
    else out = `${out} ${line.text}`;
  }
  return out;
}

/**
 * Which heading tier a line's size puts it in, or null for body text.
 *
 * Membership of `headingSizes` used to be REQUIRED, which made detection a
 * function of what the sample happened to see: the 9/11 Commission Report's
 * chapter headings are 16pt on perhaps 5% of its 585 pages, so twenty samples
 * could miss the size entirely and silently demote every one of them to body
 * text. Size above body size is the test; the tier list only ranks it, and an
 * unsampled size takes the rank its magnitude earns.
 */
function headingLevelFor(size: number, analysis: PageAnalysis): number | null {
  if (!analysis.trustSizes) return null;
  if (size < analysis.bodySize * HEADING_SIZE_RATIO) return null;
  const exact = analysis.headingSizes.findIndex((s) => Math.abs(s - size) < 0.5);
  const rank = exact === -1 ? analysis.headingSizes.filter((s) => s > size).length : exact;
  return Math.min(6, rank + 1);
}

/**
 * Learn the body font size and the running header/footer text.
 *
 * Body size is weighted by character count rather than by line count: a page
 * has few headings but they are visually prominent, and weighting by lines
 * lets a heading-heavy contents page redefine what "body" means.
 */
async function analysePages({ doc }: LoadedPdf): Promise<PageAnalysis> {
  // Spread across the whole document, first and last page included. The
  // stepping loop this replaced never reached the tail — 400 pages sampled 1,
  // 21 … 381, and a 21-to-39-page document sampled only pages 1 to 20 — so a
  // heading size used solely later on was never learned as a tier, and every
  // such heading was silently demoted to body text. (`samplePageNumbers` gets
  // the tail right but is deliberately sparse, because the probe pays to
  // rasterise; this pass only reads text, so it can afford the density.)
  const count = Math.min(ANALYSIS_SAMPLE, doc.numPages);
  const sampled: number[] = [];
  for (let i = 0; i < count; i++) {
    sampled.push(1 + Math.round((i * (doc.numPages - 1)) / Math.max(1, count - 1)));
  }

  const weightBySize = new Map<number, number>();
  /** Lines per size, alongside characters per size — the noise test counts lines. */
  const linesBySize = new Map<number, number>();
  const edgeCounts = new Map<string, number>();

  for (const pageNumber of sampled) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = assembleLines(content.items);

    for (const line of lines) {
      const size = Math.round(line.size * 2) / 2;
      weightBySize.set(size, (weightBySize.get(size) ?? 0) + line.text.length);
      linesBySize.set(size, (linesBySize.get(size) ?? 0) + 1);
    }
    // Only the first and last lines can be a running header or footer.
    for (const edge of [lines[0], lines.at(-1)]) {
      if (!edge) continue;
      const key = normalise(edge.text);
      if (key.length < 3) continue;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  const bodySize =
    [...weightBySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  const headingSizes = [...weightBySize.keys()]
    .filter((s) => s >= bodySize * HEADING_SIZE_RATIO)
    .sort((a, b) => b - a);

  // Repeating on most sampled pages means it is furniture, not content. Needs
  // enough samples to be meaningful, or a two-page document loses its title.
  const threshold = Math.max(3, Math.ceil(sampled.length * 0.5));
  const runningText = new Set(
    [...edgeCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([key]) => key),
  );

  // Is the size signal worth believing at all? See MAX_TRUSTED_* above.
  const headingLines = headingSizes.reduce((n, s) => n + (linesBySize.get(s) ?? 0), 0);
  const perPage = headingLines / sampled.length;
  const trustSizes =
    headingSizes.length <= MAX_TRUSTED_TIERS || perPage <= MAX_TRUSTED_HEADINGS_PER_PAGE;
  if (!trustSizes) {
    log.warn(
      `font sizes read as OCR noise (${headingSizes.length} heading tiers, ` +
        `${perPage.toFixed(1)} heading lines per page); structure will come ` +
        `from bookmarks alone`,
    );
  }

  return { bodySize, headingSizes, trustSizes, runningText };
}

/**
 * Resolve embedded bookmarks to a section trail per page index.
 *
 * Destinations are indirect references, so each has to be resolved through
 * getPageIndex. Entries that fail to resolve are skipped rather than fatal —
 * broken destinations are common in real files and are not worth refusing a
 * whole book over.
 */
export async function bookmarkTrails({ doc }: LoadedPdf): Promise<Map<number, string[]>> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline || outline.length === 0) return new Map();

  const byPage = new Map<number, string[]>();

  type OutlineItem = Awaited<ReturnType<typeof doc.getOutline>>[number];
  const visit = async (items: readonly OutlineItem[], trail: string[]): Promise<void> => {
    for (const item of items) {
      // Collapsed, not merely trimmed. A deck exported to PDF names each
      // bookmark after the slide's own title placeholder, whitespace and all,
      // so a title padded with spaces to centre it arrives as
      // "Slide 3:            Sapphires". That run then sits inside the section
      // path, where section_prefix matches segment by segment — and a caller
      // typing the title as it reads on screen would never match it.
      const title = item.title?.replace(/\s+/gu, " ").trim();
      if (!title) continue;
      const next = [...trail, title];

      const dest = item.dest;
      const ref = Array.isArray(dest) ? dest[0] : null;
      if (ref && typeof ref === "object" && "num" in ref) {
        const index = await doc.getPageIndex(ref as never).catch(() => -1);
        // First bookmark wins for a page: a later sibling starting on the same
        // page should not overwrite the section that page actually opens.
        if (index >= 0 && !byPage.has(index)) byPage.set(index, next);
      }
      if (item.items?.length) await visit(item.items, next);
    }
  };

  await visit(outline, []);
  return byPage;
}
