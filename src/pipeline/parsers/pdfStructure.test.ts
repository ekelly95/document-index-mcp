import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLines, type PdfLine } from "./pdfCommon.js";
import {
  analyseStructure,
  isCitationMarkerLine,
  looksLikeHeading,
  type AnalysedPage,
} from "./pdfStructure.js";

/**
 * Shapes taken from a real designed textbook (NCSF sport-nutrition chapters):
 * 9pt body, 12.6pt section headings, 10.8pt sub-headings, and a dozen other
 * sizes of infographic and table text that are not headings.
 */

const item = (str: string, x: number, y: number, size: number, width: number, fontName = "f1") => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  height: size,
  fontName,
});

const line = (text: string, y: number, size: number, font: string, x0 = 72): PdfLine => ({
  text,
  x0,
  x1: x0 + text.length * size * 0.5,
  yBaseline: y,
  yTop: y + size,
  size,
  font,
});

const PAGE_HEIGHT = 792;

function page(n: number, extra: PdfLine[] = []): AnalysedPage {
  return {
    height: PAGE_HEIGHT,
    lines: [
      // Running header alternating between even and odd pages, plus a footer.
      line(n % 2 ? "NCSF Sport Nutrition Chapter 5" : "Chapter 5 NCSF Sport Nutrition", 759, 8, "f9"),
      line(`Section ${n} Heading`, 700, 12.6, "f2"),
      line("Body text that explains the section in ordinary sentences, at length.", 680, 9, "f6"),
      line("More body text continues here with further explanation of the topic.", 666, 9, "f6"),
      ...extra,
      line(String(95 + n), 33, 9, "f6"),
      line("Micronutrients and Water", 27, 8, "f9"),
    ],
  };
}

test("an explicit space item is kept even when the gap is narrow", () => {
  const lines = assembleLines([
    item("Adequate Intakes for", 69.8, 255.9, 12, 75.9),
    item(" ", 145.8, 255.9, 12, 0.2),
    item("Chromium", 147.7, 255.9, 24, 91.2),
  ]);
  assert.deepEqual(lines.map((l) => l.text), ["Adequate Intakes for Chromium"]);
});

test("a sidebar line and a heading sharing a baseline become two lines", () => {
  const lines = assembleLines([
    item("body caused by free radicals.", 32, 264, 9, 98),
    item("Vitamins", 225, 264, 12.6, 53),
  ]);
  assert.deepEqual(
    lines.map((l) => [l.text, l.size]),
    [
      ["body caused by free radicals.", 9],
      ["Vitamins", 12.6],
    ],
  );
});

test("a heading style that recurs and introduces body text is trusted; figure labels are not", () => {
  const pages = Array.from({ length: 8 }, (_, i) =>
    page(
      i + 1,
      i === 2
        ? [
            line("COO", 400, 17, "f11"),
            line("R", 380, 17, "f11"),
            line("0 - 6 months 40 mg*", 360, 12, "f16"),
            line("7 - 12 months 50 mg*", 345, 12, "f16"),
            line("Plain body after the figure, in ordinary sentences.", 320, 9, "f6"),
          ]
        : [],
    ),
  );
  const analysis = analyseStructure(pages);

  assert.equal(analysis.bodySize, 9);
  assert.equal(analysis.headingLevel(line("Section 3 Heading", 700, 12.6, "f2")), 1);
  assert.equal(analysis.headingLevel(line("COO", 400, 17, "f11")), null);
  assert.equal(analysis.headingLevel(line("0 - 6 months 40 mg*", 360, 12, "f16")), null);
});

test("a typeset document with many sizes keeps its headings", () => {
  // Twelve distinct sizes above body: the old guard read this as OCR noise and
  // discarded every heading, leaving whole textbook chapters flat.
  const figure = Array.from({ length: 12 }, (_, k) => line(`${k}`, 500 - k * 10, 10 + k, `fig${k}`));
  const pages = Array.from({ length: 6 }, (_, i) => page(i + 1, figure));
  const analysis = analyseStructure(pages);
  assert.equal(analysis.headingLevel(line("Section 1 Heading", 700, 12.6, "f2")), 1);
});

test("alternating running headers and the footer are furniture; the same words in the body are not", () => {
  const analysis = analyseStructure(Array.from({ length: 8 }, (_, i) => page(i + 1)));
  assert.ok(analysis.isRunning(line("NCSF Sport Nutrition Chapter 5", 759, 8, "f9"), PAGE_HEIGHT));
  assert.ok(analysis.isRunning(line("Chapter 5 NCSF Sport Nutrition", 759, 8, "f9"), PAGE_HEIGHT));
  assert.ok(analysis.isRunning(line("Micronutrients and Water", 27, 8, "f9"), PAGE_HEIGHT));
  assert.ok(!analysis.isRunning(line("Micronutrients and Water", 679, 13.3, "f1"), PAGE_HEIGHT));
});

test("citation markers on their own line are recognised, and real text is not", () => {
  for (const marker of ["(5)", "(119)", "(26, 57, 114)", "(51, 56, 69, 77-79, 117)", " (3) "]) {
    assert.ok(isCitationMarkerLine(marker), marker);
  }
  for (const text of ["(see page 5)", "5", "(a)", "Table (5) shows", "(1967 study)"]) {
    assert.ok(!isCitationMarkerLine(text), text);
  }
});

test("heading plausibility rejects callouts, bullets, captions and formulas", () => {
  for (const ok of ["Vitamin B (Thiamin)", "3.2 Sampling", "THE 9/11", "Protein Turnover"]) {
    assert.ok(looksLikeHeading(ok), ok);
  }
  for (const no of [
    "Athletes vary in their protein requirements:",
    "• Young healthy females – women who were obese",
    "Table 2. Total Mean Nutritional Intake",
    "body caused by free radicals. Vitamins",
    "BV = ( Nr / Na ) × 100",
    "? ? ? ?",
    "Recognised line number 4 of this photographed page.",
  ]) {
    assert.ok(!looksLikeHeading(no), no);
  }
});
