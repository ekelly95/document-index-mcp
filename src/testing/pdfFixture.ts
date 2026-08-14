/**
 * A minimal, hand-assembled PDF writer — for tests only.
 *
 * There is no PDF-generating dependency here on purpose. What the parser needs
 * to be tested against is not "a PDF" but specific structural cases: printed
 * page labels that disagree with the physical index (roman-numeral front
 * matter), embedded bookmarks, font-size tiers that read as headings, and a
 * page carrying no text layer at all. Hand-writing the file is the only way to
 * control those precisely.
 */

export interface FixtureLine {
  text: string;
  /** PDF user space, origin bottom-left. */
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  /**
   * Degrees anticlockwise, for margin furniture set sideways.
   *
   * arXiv stamps every preprint down the left edge of page 1 at 90°, and a
   * rotated run's text matrix is what made it measure larger than the paper's
   * own title. Without this the fixture cannot express the case at all.
   */
  rotate?: number;
}

/** Trim float noise so `cos 90°` writes as 0, not 6.1e-17. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface FixturePage {
  lines: FixtureLine[];
  /** Emit a page with an image XObject and no text, to exercise the probe. */
  imageOnly?: boolean;
  /**
   * Paint a real JPEG (see `scanImage.ts`) across the page — a scanned page
   * with recognisable content, unlike `imageOnly`'s 1×1 pixel. Any `lines`
   * are drawn on top, for pages that mix a text layer with imagery.
   */
  scanImage?: { jpeg: Buffer; width: number; height: number };
}

export interface FixtureOutlineEntry {
  title: string;
  /** 0-based page index. */
  page: number;
}

export interface PdfFixture {
  pages: FixturePage[];
  /**
   * Printed labels. `romanFrontMatter: n` numbers the first n pages i, ii, iii
   * and restarts the rest at arabic 1 — the case that makes printed_label and
   * locator.ordinal disagree.
   */
  romanFrontMatter?: number;
  outline?: FixtureOutlineEntry[];
  /** The /Info dictionary's Title — real files often carry a useless one. */
  docTitle?: string;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** Escape the three characters that are special inside a PDF literal string. */
function pdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream(page: FixturePage): string {
  if (page.imageOnly) {
    // Paint the image XObject across the page and emit no text at all.
    return `q\n${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm\n/Im1 Do\nQ\n`;
  }
  const ops: string[] = [];
  if (page.scanImage) {
    // Fill the page width, preserving the image's aspect ratio, anchored to
    // the top of the page the way a real scan is.
    const h = Math.round((PAGE_WIDTH * page.scanImage.height) / page.scanImage.width);
    ops.push(`q\n${PAGE_WIDTH} 0 0 ${h} 0 ${PAGE_HEIGHT - h} cm\n/Sc Do\nQ`);
  }
  if (page.lines.length > 0) {
    ops.push("BT");
    for (const line of page.lines) {
      ops.push(`/${line.bold ? "F2" : "F1"} ${line.size} Tf`);
      // Tm is [a b c d e f]: cos/sin of the rotation, then the origin.
      const radians = ((line.rotate ?? 0) * Math.PI) / 180;
      const cos = round(Math.cos(radians));
      const sin = round(Math.sin(radians));
      ops.push(`${cos} ${sin} ${-sin} ${cos} ${line.x} ${line.y} Tm`);
      ops.push(`(${pdfString(line.text)}) Tj`);
    }
    ops.push("ET");
  }
  return `${ops.join("\n")}\n`;
}

/**
 * Assemble objects into a valid PDF with a correct cross-reference table.
 *
 * latin1 throughout so that one character is one byte and string offsets are
 * byte offsets, which is what the xref table has to contain.
 */
function assemble(objects: string[], rootObj: number, infoObj?: number): Buffer {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [0];

  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const info = infoObj ? ` /Info ${infoObj} 0 R` : "";
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${rootObj} 0 R${info} >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

export function buildPdf(fixture: PdfFixture): Buffer {
  const pageCount = fixture.pages.length;

  // Object layout, fixed so cross-references can be computed up front:
  //   1                catalog
  //   2                page tree
  //   3 .. 2+N         page objects
  //   3+N .. 2+2N      content streams
  //   3+2N             regular font
  //   4+2N             bold font
  //   5+2N             image XObject (always present; unused pages ignore it)
  //   6+2N ..          outline root + items, when requested
  //   after outline    one /DCTDecode XObject per page with a scanImage
  const pageObj = (i: number) => 3 + i;
  const contentObj = (i: number) => 3 + pageCount + i;
  const fontRegular = 3 + 2 * pageCount;
  const fontBold = fontRegular + 1;
  const imageObj = fontBold + 1;
  const outlineRoot = imageObj + 1;

  const objects: string[] = [];
  const push = (body: string) => objects.push(body);

  const hasOutline = (fixture.outline?.length ?? 0) > 0;

  // Scan images go after the outline block, so their numbers depend on how
  // many outline objects precede them — computed here, pushed at the end.
  const scanBase = outlineRoot + (hasOutline ? 1 + fixture.outline!.length : 0);
  const scanObjOf = new Map<number, number>();
  fixture.pages.forEach((page, i) => {
    if (page.scanImage) scanObjOf.set(i, scanBase + scanObjOf.size);
  });

  // 1 — catalog
  const pageLabels =
    fixture.romanFrontMatter && fixture.romanFrontMatter > 0
      ? ` /PageLabels << /Nums [0 << /S /r >> ${fixture.romanFrontMatter} << /S /D /St 1 >>] >>`
      : "";
  const outlineRef = hasOutline ? ` /Outlines ${outlineRoot} 0 R` : "";
  push(`<< /Type /Catalog /Pages 2 0 R${pageLabels}${outlineRef} >>`);

  // 2 — page tree
  const kids = fixture.pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ");
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  // 3..2+N — pages
  fixture.pages.forEach((page, i) => {
    const xobject = page.imageOnly
      ? ` /XObject << /Im1 ${imageObj} 0 R >>`
      : page.scanImage
        ? ` /XObject << /Sc ${scanObjOf.get(i)} 0 R >>`
        : "";
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${xobject} >> ` +
        `/Contents ${contentObj(i)} 0 R >>`,
    );
  });

  // 3+N..2+2N — content streams
  for (const page of fixture.pages) {
    const stream = contentStream(page);
    push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }

  // fonts
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  // A 1x1 grayscale image, enough for the image-only probe to see coverage.
  const pixel = "\xFF";
  push(
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n${pixel}\nendstream`,
  );

  if (hasOutline) {
    const entries = fixture.outline!;
    const firstItem = outlineRoot + 1;
    push(
      `<< /Type /Outlines /First ${firstItem} 0 R ` +
        `/Last ${firstItem + entries.length - 1} 0 R /Count ${entries.length} >>`,
    );
    entries.forEach((entry, i) => {
      const prev = i > 0 ? ` /Prev ${firstItem + i - 1} 0 R` : "";
      const next = i < entries.length - 1 ? ` /Next ${firstItem + i + 1} 0 R` : "";
      push(
        `<< /Title (${pdfString(entry.title)}) /Parent ${outlineRoot} 0 R` +
          `${prev}${next} /Dest [${pageObj(entry.page)} 0 R /Fit] >>`,
      );
    });
  }

  // Scan images: JPEG bytes embedded verbatim. /DCTDecode means the stream IS
  // the JPEG file — no zlib, no predictors — and latin1 keeps byte offsets
  // honest through `assemble`.
  for (const [pageIndex, objNum] of scanObjOf) {
    const scan = fixture.pages[pageIndex]!.scanImage!;
    if (objects.length + 1 !== objNum) {
      throw new Error(`scan image for page ${pageIndex} landed at ${objects.length + 1}, expected ${objNum}`);
    }
    push(
      `<< /Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${scan.jpeg.length} >>\nstream\n${scan.jpeg.toString("latin1")}\nendstream`,
    );
  }

  // Last, so it needs no number reserved up front.
  let infoObj: number | undefined;
  if (fixture.docTitle !== undefined) {
    push(`<< /Title (${pdfString(fixture.docTitle)}) >>`);
    infoObj = objects.length;
  }

  return assemble(objects, 1, infoObj);
}
