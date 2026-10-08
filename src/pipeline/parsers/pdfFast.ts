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
  type LoadedPdf,
  type PdfLine,
} from "./pdfCommon.js";
import { analyseStructure, isCitationMarkerLine, type StructureAnalysis } from "./pdfStructure.js";

/**
 * PDF with a usable text layer -> IR.
 *
 * pdfjs-dist rather than the spec's MuPDF.js: mupdf is AGPL-3.0-or-later,
 * which would be viral over this entire server. pdfjs-dist is Apache-2.0 and
 * supplies everything the design needs — per-item text matrices for bbox and
 * font size, getPageLabels() for printed page numbers, getOutline() for
 * embedded bookmarks.
 */

/** Vertical gap, as a multiple of font size, that ends a paragraph. */
const PARAGRAPH_GAP_RATIO = 1.6;
/**
 * Pages read to learn the document's heading styles and running headers. All
 * of them up to this many: a chapter-heading style can occur on 5% of a book's
 * pages, and a 20-page sample used to miss it entirely.
 */
const MAX_ANALYSED_PAGES = 600;
/** A wrapped heading's continuation may sit this many line heights below it. */
const HEADING_WRAP_GAP_RATIO = 2;
/** Lines a single heading may span, and the characters it may run to. */
const HEADING_WRAP_MAX_LINES = 4;
const HEADING_WRAP_MAX_CHARS = 200;

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
          !analysis.isRunning(line, viewport.height) &&
          !isPageNumberLine(line.text) &&
          !isCitationMarkerLine(line.text),
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
        const level = analysis.headingLevel(line);

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
              !analysis.isHeadingStyle(next) ||
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
          // Compared at the 0.1pt precision styles are recognised at: a figure
          // title set at 12.63pt must not outrank 12.60pt section headings.
          const size = Math.round(line.size * 10) / 10;
          let opensAt = size;
          let carried = text;
          if (top && namesSameSection(text, top.text)) {
            // The same section, printed. Keep whichever name is fuller — the
            // bookmark usually has the whole title where the page shows only
            // the line that fitted — and keep its authority.
            carried = top.text.length >= text.length ? top.text : text;
            opensAt = Math.max(top.size, size);
            stack.pop();
          } else {
            while (stack.length > 0 && stack[stack.length - 1]!.size <= size) {
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
 * Learn the document's heading styles and running headers from its pages.
 * See `pdfStructure.ts` for the rules.
 */
async function analysePages({ doc }: LoadedPdf): Promise<StructureAnalysis> {
  const count = Math.min(MAX_ANALYSED_PAGES, doc.numPages);
  const pageNumbers = Array.from({ length: count }, (_, i) =>
    count === doc.numPages ? i + 1 : 1 + Math.round((i * (doc.numPages - 1)) / Math.max(1, count - 1)),
  );

  const pages = [];
  for (const pageNumber of pageNumbers) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      height: page.getViewport({ scale: 1 }).height,
      lines: assembleLines(content.items).filter(
        (line) => !isPageNumberLine(line.text) && !isCitationMarkerLine(line.text),
      ),
    });
  }
  return analyseStructure(pages);
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
