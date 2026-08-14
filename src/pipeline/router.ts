import path from "node:path";
import {
  type DocumentParser,
  type DocumentSource,
  type Format,
  UnsupportedFormatError,
} from "./ir.js";
import { MarkdownParser } from "./parsers/markdown.js";
import { TxtParser } from "./parsers/txt.js";
import { DocxParser } from "./parsers/docx.js";
import { PdfFastParser } from "./parsers/pdfFast.js";
import { PdfOcrParser } from "./parsers/pdfOcr.js";
import { probePdf } from "./parsers/pdfProbe.js";
import { openZip } from "./zip.js";

export type Engine = "ts-fast" | "ts-ocr" | "docling" | "docling-ocr";

export interface Route {
  format: Format;
  engine: Engine;
  parser: DocumentParser;
}

/** How the OCR route is configured, threaded in from ServerConfig. */
export interface OcrRouteOptions {
  mode: "auto" | "off";
  lang: string;
  workers: number;
  /** Model cache root; traineddata caches beneath it. */
  cacheDir: string;
  /** Local traineddata directory override; tests use it to stay offline. */
  langPath?: string;
}

export interface RouteOptions {
  /**
   * Omitted means OFF — the refusal below. The server always passes its
   * config; a caller that routes without options (tests, mostly) is asking
   * for the strict behaviour.
   */
  ocr?: OcrRouteOptions;
}

/**
 * Identify a format from its content.
 *
 * Extensions are hints only. A `.txt` that is really a PDF, or a `.pdf` that
 * is really a zip, is caught here rather than producing a document full of
 * binary garbage.
 */
export function sniffFormat(src: DocumentSource): Format {
  const absPath = src.absPath;
  const head = Buffer.from(src.head.buffer, src.head.byteOffset, src.head.byteLength);

  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";

  // OOXML and EPUB are both zips ("PK\x03\x04").
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // An EPUB's first zip entry is an uncompressed `mimetype` file at a fixed
    // offset, so the format is identifiable without unzipping anything.
    if (head.subarray(30, 58).toString("latin1") === "mimetypeapplication/epub+zip") {
      return "epub";
    }
    // docx and pptx both lead with [Content_Types].xml; which one this is
    // lives in the central directory. Only the directory is walked — the
    // keep filter admits nothing, so no entry is inflated here.
    const kind = ooxmlKind(src.bytes);
    if (kind) return kind;
    const ext = path.extname(absPath).toLowerCase();
    if (ext === ".docx") return "docx";
    if (ext === ".pptx") return "pptx";
    throw new UnsupportedFormatError(
      `${path.basename(absPath)} is a zip-based format that could not be identified.`,
    );
  }

  // Legacy binary Office (.doc/.ppt/.xls) and encrypted OOXML both live in a
  // CFB container. Naming the remedy beats the generic binary refusal below.
  if (CFB_MAGIC.every((byte, i) => head[i] === byte)) {
    throw new UnsupportedFormatError(
      `${path.basename(absPath)} is a legacy binary Office file (.doc/.ppt/.xls) or an ` +
        `encrypted Office document. Run scripts/convert-for-ingest.ps1 on it: a .doc becomes ` +
        `.docx, and a .ppt becomes a PDF plus a markdown file holding its speaker notes, ` +
        `which a PDF export would otherwise discard.`,
    );
  }

  // A NUL byte in the first 512 bytes means this is not text of any kind.
  if (head.includes(0)) {
    throw new UnsupportedFormatError(
      `${path.basename(absPath)} appears to be binary, and matched no known format signature.`,
    );
  }

  const text = head.toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "html";

  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".md" || ext === ".markdown") return "md";
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) return "md";
  return "txt";
}

/** The CFB/OLE compound-file signature every pre-2007 Office format shares. */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** "pptx" | "docx" from the zip central directory, null when neither. */
function ooxmlKind(bytes: Uint8Array): "pptx" | "docx" | null {
  let sawPpt = false;
  let sawWord = false;
  try {
    openZip(bytes, (name) => {
      if (name.startsWith("ppt/")) sawPpt = true;
      if (name.startsWith("word/")) sawWord = true;
      return false;
    });
  } catch {
    return null; // a corrupt zip falls through to the extension hints
  }
  if (sawPpt && !sawWord) return "pptx";
  if (sawWord && !sawPpt) return "docx";
  return null;
}

/** Formats with a parser wired up in this build. */
const PARSERS: Partial<Record<Format, () => DocumentParser>> = {
  md: () => new MarkdownParser(),
  txt: () => new TxtParser(),
  pdf: () => new PdfFastParser(),
  docx: () => new DocxParser(),
};

/**
 * Why a recognised format is not ingestible, phrased for the caller.
 *
 * EPUB and PPTX had working parsers and were removed rather than finished. Both
 * could cite confidently and wrongly — an EPUB `part` is a spine file, not the
 * chapter a reader would understand it as, and a deck built around charts
 * indexed its titles and none of its data. A refusal that says so is worth more
 * than a locator that quietly misleads. See docs/roadmap.md.
 */
const NOT_YET: Partial<Record<Format, string>> = {
  html: "HTML support is deferred; convert to .md for now.",
  epub: "EPUB is not read: its locators could not name a real chapter. Convert to PDF or Markdown.",
  // Measured on a real 28-slide deck: exporting to PDF gives one page per
  // slide, a bookmark per slide naming it, and clean slide text — but it
  // discards speaker notes, and 22 of those 28 slides carried notes holding
  // figures that appear nowhere in the slide text. So the advice names both
  // halves. Anything less would send the caller down a route that silently
  // drops the best content in the file.
  pptx: "Slide decks are not read. Run scripts/convert-for-ingest.ps1 on the deck (or the folder holding it) and ingest what it produces: a PDF of the slides, one page each with chart labels surviving as text, plus a markdown file of the speaker notes. Both are needed — a PDF export drops the notes, and in a lecture deck the notes are often where the actual teaching is.",
};

export async function routeDocument(
  src: DocumentSource,
  opts: RouteOptions = {},
): Promise<Route> {
  const absPath = src.absPath;
  const format = sniffFormat(src);

  const make = PARSERS[format];
  if (!make) {
    throw new UnsupportedFormatError(
      `${path.basename(absPath)} was identified as ${format}. ${NOT_YET[format] ?? ""}`.trim(),
    );
  }

  if (format === "pdf") {
    // A failing probe escalates to the OCR route when it is enabled, and
    // REFUSES when it is not.
    //
    // The refusal is the important half. Ingesting a scan through the fast
    // path succeeds and produces a document containing nothing, and a later
    // search that finds nothing is indistinguishable from a topic the book
    // does not cover. A loud failure at ingest is the only honest fallback.
    const probe = await probePdf(src);
    if (probe.imageOnly || probe.mojibake) {
      const ocr = opts.ocr;
      if (ocr?.mode === "auto") {
        return {
          format,
          engine: "ts-ocr",
          parser: new PdfOcrParser({
            lang: ocr.lang,
            workers: ocr.workers,
            cacheDir: ocr.cacheDir,
            ...(ocr.langPath ? { langPath: ocr.langPath } : {}),
            // Mojibake without imagery means the text layer LOOKS plausible
            // page by page — printable, wrong words — so the per-page vote
            // cannot be trusted and every page is recognised from pixels.
            forceOcr: probe.mojibake && !probe.imageOnly,
          }),
        };
      }
      throw new UnsupportedFormatError(
        `${path.basename(absPath)} cannot be read by the text-layer parser: ${probe.detail}. ` +
          `OCR is disabled (--ocr=off), so this file cannot be indexed. ` +
          `Re-run with --ocr=auto, or OCR it externally and re-ingest.`,
      );
    }
  }

  // Every wired format runs pure TS. The Docling escalation path exists in the
  // design but is not built.
  return { format, engine: "ts-fast", parser: make() };
}
