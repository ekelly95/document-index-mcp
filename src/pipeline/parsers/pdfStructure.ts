import type { PdfLine } from "./pdfCommon.js";

/**
 * Which lines of a text-layer PDF are headings, and which are page furniture.
 *
 * "Larger than body text" is not a heading test on its own. In a designed
 * textbook most large text is infographic and table labelling — "COO",
 * "AMMONIA", "0 - 6 months 40 mg*" — at a dozen sizes, while the real headings
 * are two or three exact styles used consistently. The old rule took every size
 * above body as a heading tier and, past six tiers, gave up on font sizes
 * entirely; on a real 11-chapter textbook that left six chapters with no
 * structure at all and filled the rest with figure labels as section titles.
 *
 * So headings are recognised by STYLE — a (size, font) pair — and a style is
 * trusted only when its lines read like headings, recur across pages, and are
 * followed by body text (or by another trusted heading). Figure labels fail the
 * first two, table titles the third, and an OCR text layer's near-continuum of
 * sizes fails all three, because its "large" lines are ordinary sentences.
 */

/** A style must be at least this much larger than body text to be a heading. */
const HEADING_SIZE_RATIO = 1.15;
/** Fraction of a style's lines that must read as headings. */
const MIN_PLAUSIBLE = 0.75;
/** Fraction of a style's lines that must be followed by body text or a trusted heading. */
const MIN_FOLLOWED_BY_BODY = 0.6;
/** Header/footer bands, as a fraction of page height from the top and bottom. */
const RUNNING_BAND = 0.08;

export interface AnalysedPage {
  lines: readonly PdfLine[];
  height: number;
}

export interface StructureAnalysis {
  bodySize: number;
  /** Heading level 1..6 for a line that opens a heading, or null for body text. */
  headingLevel(line: PdfLine): number | null;
  /** Set in a trusted heading style, whatever it says: a wrapped heading's later lines. */
  isHeadingStyle(line: PdfLine): boolean;
  /** A running header or footer, repeated across pages in the page margins. */
  isRunning(line: PdfLine, pageHeight: number): boolean;
}

const BULLET = /^[•▪■□●○◦‣∙·*–—-]/u;
const CAPTION = /^(?:table|figure|fig\.?|chart|exhibit|source|note|key|adapted from)\b/i;

/**
 * Could this line be a heading at all? Short, title-like, mostly letters,
 * starting with a capital or a number, and not ending mid-sentence or as a
 * lead-in (":"), which is how callouts and figure captions read.
 */
export function looksLikeHeading(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 120) return false;
  if (t.split(/\s+/).length > 14) return false;
  const visible = t.replace(/\s/g, "");
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (letters < 2 || letters / visible.length < 0.4) return false;
  if (BULLET.test(t) || CAPTION.test(t)) return false;
  // A formula, not a title: "BV = ( Nr / Na ) × 100".
  if (/[=÷×]/.test(t)) return false;
  if (!/^[\p{Lu}\p{N}]/u.test(t)) return false;
  return !/[.,;:–—-]$/.test(t);
}

/**
 * A superscript citation that pdfjs set on its own baseline: "(5)",
 * "(26, 57, 114)", "(77-79)". Content-free, and as a chunk of its own it
 * matches any query that mentions a number.
 */
export function isCitationMarkerLine(text: string): boolean {
  return /^\s*\(\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?(?:\s*,\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?)*\s*\)\s*$/.test(
    text,
  );
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const styleKey = (line: PdfLine): string => `${round1(line.size)}|${line.font}`;

/**
 * Header/footer identity: the words, ignoring order, case and numbers, so
 * "Chapter 5 NCSF Sport Nutrition" on even pages and "NCSF Sport Nutrition
 * Chapter 5" on odd pages are one header, and "96" and "97" are one footer.
 */
function runningKey(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[\d]+/g, " ")
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 0);
  return [...new Set(words)].sort().join(" ");
}

const inMargin = (line: PdfLine, height: number): boolean =>
  line.yBaseline > height * (1 - RUNNING_BAND) || line.yBaseline < height * RUNNING_BAND;

/** How many pages a style must appear on, scaled to how many were analysed. */
function minPages(analysed: number): number {
  if (analysed <= 4) return 1;
  if (analysed <= 12) return 2;
  return 3;
}

interface StyleStats {
  size: number;
  lines: number;
  plausible: number;
  pages: Set<number>;
  followedByBody: number;
  /** Styles of the non-body lines that followed, to credit a title above a trusted heading. */
  followedBy: string[];
}

export function analyseStructure(pages: readonly AnalysedPage[]): StructureAnalysis {
  // Running text first: it must not vote on body size or heading styles.
  const runningPages = new Map<string, Set<number>>();
  pages.forEach((page, index) => {
    for (const line of page.lines) {
      if (!inMargin(line, page.height)) continue;
      const key = runningKey(line.text);
      if (key.length < 3) continue;
      const seen = runningPages.get(key) ?? new Set<number>();
      seen.add(index);
      runningPages.set(key, seen);
    }
  });
  const runningThreshold = Math.max(2, Math.ceil(pages.length * 0.25));
  const running = new Set(
    [...runningPages.entries()].filter(([, seen]) => seen.size >= runningThreshold).map(([k]) => k),
  );
  const isRunning = (line: PdfLine, height: number): boolean =>
    inMargin(line, height) && running.has(runningKey(line.text));

  const content = pages.map((page) =>
    page.lines.filter((line) => line.text.length > 0 && !isRunning(line, page.height)),
  );

  // Body size, weighted by characters so a heading-heavy page cannot redefine it.
  const weight = new Map<number, number>();
  for (const lines of content) {
    for (const line of lines) {
      weight.set(round1(line.size), (weight.get(round1(line.size)) ?? 0) + line.text.length);
    }
  }
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  const isBody = (line: PdfLine): boolean => Math.abs(line.size - bodySize) < 0.6;

  const styles = new Map<string, StyleStats>();
  content.forEach((lines, pageIndex) => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.size < bodySize * HEADING_SIZE_RATIO) continue;
      const key = styleKey(line);
      const stats = styles.get(key) ?? {
        size: round1(line.size),
        lines: 0,
        plausible: 0,
        pages: new Set<number>(),
        followedByBody: 0,
        followedBy: [],
      };
      stats.lines++;
      if (looksLikeHeading(line.text)) stats.plausible++;
      stats.pages.add(pageIndex);

      // Skip the style's own wrapped continuation lines.
      let j = i + 1;
      while (j < lines.length && styleKey(lines[j]!) === key) j++;
      const next = lines[j];
      if (next && isBody(next)) stats.followedByBody++;
      else if (next) stats.followedBy.push(styleKey(next));
      styles.set(key, stats);
    }
  });

  const needPages = minPages(pages.length);
  const trusted = new Set<string>();
  const plausible = (s: StyleStats) => s.plausible / s.lines >= MIN_PLAUSIBLE;
  const followed = (s: StyleStats, extra = 0) =>
    (s.followedByBody + extra) / s.lines >= MIN_FOLLOWED_BY_BODY;

  for (const [key, s] of styles) {
    if (plausible(s) && followed(s) && s.pages.size >= needPages) trusted.add(key);
  }
  // Second pass: a document title followed by its first section heading, and a
  // heading set at a trusted size in a variant face (bold vs bold-italic).
  const trustedSizes = new Set([...trusted].map((k) => styles.get(k)!.size));
  for (const [key, s] of styles) {
    if (trusted.has(key) || !plausible(s)) continue;
    const intoTrusted = s.followedBy.filter((k) => trusted.has(k)).length;
    if (followed(s, intoTrusted) && s.pages.size >= needPages) trusted.add(key);
    else if (followed(s) && trustedSizes.has(s.size)) trusted.add(key);
  }

  const levels = [...new Set([...trusted].map((k) => styles.get(k)!.size))].sort((a, b) => b - a);
  const headingLevel = (line: PdfLine): number | null => {
    if (!trusted.has(styleKey(line)) || !looksLikeHeading(line.text)) return null;
    return Math.min(6, levels.indexOf(round1(line.size)) + 1);
  };

  const isHeadingStyle = (line: PdfLine): boolean => trusted.has(styleKey(line));

  return { bodySize, headingLevel, isHeadingStyle, isRunning };
}
