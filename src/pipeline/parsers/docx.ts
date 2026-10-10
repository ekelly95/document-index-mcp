import path from "node:path";
import {
  UnsupportedFormatError,
  type DocBlock,
  type DocumentMetadata,
  type DocumentParser,
  type DocumentSource,
} from "../ir.js";
import { openZip, type ZipArchive } from "../zip.js";
import {
  collapse,
  elements,
  findAll,
  findFirst,
  gfmTable,
  local,
  parseXml,
  type XmlElement,
} from "./xml.js";

/**
 * DOCX -> IR.
 *
 * A Word document is one body stream, so it takes the `section` scheme the
 * markdown parser defined: the locator advances at every Heading 1/2, and
 * the heading trail nests the way the styles do. Only what the author wrote
 * is read — headers, footers, comments and tracked-change machinery live in
 * other parts of the zip and are never inflated.
 *
 * Footnotes and endnotes are on the author's side of that line, so they ARE
 * read, from their own parts of the zip. In academic prose they carry the
 * citations, and dropping them silently is the failure this project refuses
 * everywhere else: a search for a source that IS cited would come back empty,
 * indistinguishable from one that is not.
 */

interface LoadedDocx {
  /** The `w:body` element itself, never the document node. */
  body: XmlElement;
  title: string | null;
  /** `w:id` -> note text, for footnotes and endnotes respectively. */
  footnotes: Map<string, string>;
  endnotes: Map<string, string>;
  /** Paragraph style id -> heading level, resolved through word/styles.xml. */
  headingStyles: Map<string, number>;
}

const keepEntry = (name: string): boolean =>
  name === "word/document.xml" ||
  name === "word/styles.xml" ||
  name === "docProps/core.xml" ||
  name === "word/footnotes.xml" ||
  name === "word/endnotes.xml";

export class DocxParser implements DocumentParser {
  async metadata(src: DocumentSource): Promise<DocumentMetadata> {
    const doc = await loadDocx(src);
    const headings = countSectionHeadings(doc);
    return {
      title:
        doc.title ??
        firstHeadingOneText(doc) ??
        path.basename(src.absPath, path.extname(src.absPath)),
      locatorScheme: "section",
      locatorCount: Math.max(1, headings),
    };
  }

  async *parse(src: DocumentSource): AsyncIterable<DocBlock> {
    const doc = await loadDocx(src);

    // The heading trail in effect for BODY blocks; a heading block itself
    // carries its ancestors only — the convention every parser here shares.
    let trail: string[] = [];
    let ordinal = 0;
    const locator = (): DocBlock["locator"] => ({
      type: "section",
      value: `sec-${ordinal}`,
      ordinal,
    });

    let listLines: string[] = [];
    let listTrail: string[] = [];
    /** Notes cited by list items, which cannot be emitted until the list is. */
    let listNotes: DocBlock[] = [];
    const flush = function* (): Generator<DocBlock> {
      if (listLines.length > 0) {
        yield {
          kind: "list",
          text: listLines.join("\n"),
          locator: locator(),
          sectionPath: listTrail,
          bbox: null,
          attrs: { ordered: false },
        };
        listLines = [];
        yield* listNotes;
        listNotes = [];
      }
    };

    // Word numbers notes by order of reference, not by w:id, so the marker a
    // reader sees comes from a counter here rather than from the file.
    const seen = { footnote: 0, endnote: 0 };

    /**
     * The notes cited by one element, as blocks of their own.
     *
     * Their own blocks rather than appended to the citing sentence: block text
     * is what get_chunk_context hands back verbatim, and splicing a
     * bibliography line into the middle of a paragraph corrupts the prose. The
     * locator and trail match the citing block, so the boundary law puts the
     * note in the same chunk whenever there is room for it.
     */
    const notesOf = function* (el: XmlElement, trail: string[]): Generator<DocBlock> {
      for (const ref of noteRefs(el)) {
        const text = (ref.kind === "footnote" ? doc.footnotes : doc.endnotes).get(ref.id);
        if (text === undefined) continue;
        seen[ref.kind] += 1;
        yield {
          kind: "caption",
          text: `[${ref.kind} ${seen[ref.kind]}] ${text}`,
          locator: locator(),
          sectionPath: trail,
          bbox: null,
        };
      }
    };

    for (const el of bodyBlocks(doc.body)) {
      switch (local(el)) {
        case "p": {
          const text = paragraphText(el);
          if (!text) continue;

          const style = paragraphStyle(el);
          const headingLevel = headingLevelOf(el, doc.headingStyles);
          if (headingLevel !== null) {
            yield* flush();
            const parentTrail = trail.slice(0, headingLevel - 1);
            if (headingLevel <= 2) ordinal++;
            yield {
              kind: "heading",
              level: headingLevel,
              text,
              locator: locator(),
              sectionPath: parentTrail,
              bbox: null,
            };
            trail = [...parentTrail, text];
            yield* notesOf(el, trail);
            continue;
          }

          if (findFirst(el, "numPr")) {
            const level = Number(findFirst(el, "ilvl")?.getAttribute("w:val") ?? "0") || 0;
            if (listLines.length === 0) listTrail = trail;
            listLines.push(`${"  ".repeat(level)}- ${text}`);
            listNotes.push(...notesOf(el, trail));
            continue;
          }

          yield* flush();
          const isQuote = style !== null && /quote/i.test(style);
          yield {
            kind: isQuote ? "quote" : "paragraph",
            text: isQuote ? `> ${text}` : text,
            locator: locator(),
            sectionPath: trail,
            bbox: null,
          };
          yield* notesOf(el, trail);
          continue;
        }
        case "tbl": {
          yield* flush();
          const rows = findAll(el, "tr").map((tr) =>
            findAll(tr, "tc").map((tc) =>
              findAll(tc, "p")
                .map(paragraphText)
                .filter((t) => t.length > 0)
                .join(" "),
            ),
          );
          const text = gfmTable(rows);
          if (text) {
            yield { kind: "table", text, locator: locator(), sectionPath: trail, bbox: null };
            yield* notesOf(el, trail);
          }
          continue;
        }
        default:
          continue; // sectPr, bookmarks, sdt wrappers &c.
      }
    }
    yield* flush();
  }
}

function loadDocx(src: DocumentSource): Promise<LoadedDocx> {
  return src.derive("docx", async () => {
    const name = path.basename(src.absPath);
    const archive = openZip(src.bytes, keepEntry);

    if (!archive.has("word/document.xml")) {
      throw new UnsupportedFormatError(`${name} has no word/document.xml; not a valid DOCX.`);
    }
    const doc = parseXml(archive.text("word/document.xml"));

    // The document NODE's textContent is null by DOM spec; the body element's
    // is the actual prose.
    const body = findFirst(doc, "body");
    if (!body || collapse(body.textContent).length === 0) {
      // The refusal principle the PDF probe established: never let a document
      // ingest as a silently empty success.
      throw new UnsupportedFormatError(`${name} has no body text.`);
    }

    return {
      body,
      title: coreTitle(archive),
      footnotes: loadNotes(archive, "word/footnotes.xml", "footnote"),
      endnotes: loadNotes(archive, "word/endnotes.xml", "endnote"),
      headingStyles: loadHeadingStyles(archive),
    };
  });
}

/**
 * `w:id` -> note text, for one notes part.
 *
 * Every Word file carries separator and continuation-separator notes whether
 * or not the author wrote any — they are the horizontal rule above the note
 * area, not content — so only `w:type` absent or "normal" is a real note.
 */
function loadNotes(archive: ZipArchive, part: string, tag: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!archive.has(part)) return out;

  for (const note of findAll(parseXml(archive.text(part)), tag)) {
    const type = note.getAttribute("w:type");
    if (type !== null && type !== "normal") continue;
    const id = note.getAttribute("w:id");
    if (id === null) continue;

    const text = findAll(note, "p")
      .map(paragraphText)
      .filter((t) => t.length > 0)
      .join(" ");
    if (text.length > 0) out.set(id, text);
  }
  return out;
}

/** Note references anywhere inside one block, in document order. */
function noteRefs(el: XmlElement): { kind: "footnote" | "endnote"; id: string }[] {
  const out: { kind: "footnote" | "endnote"; id: string }[] = [];
  const visit = (node: XmlElement): void => {
    const name = local(node);
    if (name === "footnoteReference" || name === "endnoteReference") {
      const id = node.getAttribute("w:id");
      if (id !== null) {
        out.push({ kind: name === "footnoteReference" ? "footnote" : "endnote", id });
      }
      return;
    }
    for (const child of elements(node)) visit(child);
  };
  for (const child of elements(el)) visit(child);
  return out;
}

function coreTitle(archive: ZipArchive): string | null {
  if (!archive.has("docProps/core.xml")) return null;
  const core = parseXml(archive.text("docProps/core.xml"));
  const text = collapse(findFirst(core, "title")?.textContent);
  return text.length > 0 ? text : null;
}

/** `w:pStyle w:val` of a paragraph, from its own properties only. */
function paragraphStyle(p: XmlElement): string | null {
  const pPr = findFirst(p, "pPr");
  if (!pPr) return null;
  return findFirst(pPr, "pStyle")?.getAttribute("w:val") ?? null;
}

/**
 * Block-level children of the body, descending into content controls.
 *
 * A body-level `w:sdt` wraps its paragraphs in `w:sdtContent`; templates put
 * cover pages, abstracts and whole sections there. Skipping the wrapper
 * silently dropped all of that text.
 */
function bodyBlocks(parent: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const el of elements(parent)) {
    if (local(el) === "sdt") {
      const content = elements(el).find((c) => local(c) === "sdtContent");
      if (content) out.push(...bodyBlocks(content));
    } else {
      out.push(el);
    }
  }
  return out;
}

/** Level from a style NAME, which Word keeps in English even when the id is localized. */
function levelFromName(name: string): number | null {
  if (/^title$/i.test(name)) return 1;
  const m = /^heading\s*([1-6])$/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** `w:outlineLvl` 0..5 -> heading 1..6; 9 (and anything else) is body text. */
function levelFromOutline(el: XmlElement | null): number | null {
  const raw = el?.getAttribute("w:val");
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n + 1 : null;
}

/**
 * Style id -> heading level, from word/styles.xml.
 *
 * Matching ids like `Heading1` only worked for English Word: a German file
 * says `berschrift1` (Word strips the Ü from ids), and a custom "Chapter"
 * style based on Heading 1 is a heading too. So each style resolves by its
 * name, then its own outline level, then whatever it is based on.
 */
function loadHeadingStyles(archive: ZipArchive): Map<string, number> {
  const out = new Map<string, number>();
  if (!archive.has("word/styles.xml")) return out;

  const byId = new Map<string, { name: string; basedOn: string | null; outline: number | null }>();
  for (const style of findAll(parseXml(archive.text("word/styles.xml")), "style")) {
    const id = style.getAttribute("w:styleId");
    if (id === null) continue;
    byId.set(id, {
      name: findFirst(style, "name")?.getAttribute("w:val") ?? "",
      basedOn: findFirst(style, "basedOn")?.getAttribute("w:val") ?? null,
      outline: levelFromOutline(findFirst(style, "outlineLvl")),
    });
  }

  for (const id of byId.keys()) {
    let current: string | null = id;
    for (let depth = 0; current !== null && depth < 10; depth++) {
      const style = byId.get(current);
      if (!style) break;
      const level = levelFromName(style.name) ?? style.outline;
      if (level !== null) {
        out.set(id, level);
        break;
      }
      current = style.basedOn;
    }
  }
  return out;
}

/**
 * Heading depth of a paragraph: its own outline level, else its style as
 * resolved through styles.xml, else the English style id ("Heading1",
 * "Title") for files that ship no styles part.
 */
function headingLevelOf(p: XmlElement, headingStyles: Map<string, number>): number | null {
  const pPr = findFirst(p, "pPr");
  const own = pPr ? levelFromOutline(findFirst(pPr, "outlineLvl")) : null;
  if (own !== null) return own;

  const style = paragraphStyle(p);
  if (style === null) return null;
  const resolved = headingStyles.get(style);
  if (resolved !== undefined) return resolved;
  return levelFromName(style);
}

/**
 * A paragraph's text from its `w:t` runs. Runs concatenate raw — Word splits
 * them mid-word around formatting changes — with tabs and line breaks read
 * as spaces.
 */
function paragraphText(p: XmlElement): string {
  let out = "";
  const visit = (el: XmlElement): void => {
    const name = local(el);
    if (name === "t") {
      out += el.textContent ?? "";
      return;
    }
    if (name === "tab" || name === "br" || name === "cr") {
      out += " ";
      return;
    }
    // A tracked move keeps its text, as w:t, at both ends: w:moveFrom where
    // it left and w:moveTo where it landed. Read once, at its destination,
    // as deleted text (w:delText, never matched above) already is not read.
    if (name === "moveFrom") return;
    for (const child of elements(el)) visit(child);
  };
  for (const child of elements(p)) visit(child);
  return collapse(out);
}

function countSectionHeadings(doc: LoadedDocx): number {
  let n = 0;
  for (const p of findAll(doc.body, "p")) {
    const level = headingLevelOf(p, doc.headingStyles);
    if (level !== null && level <= 2) n++;
  }
  return n;
}

function firstHeadingOneText(doc: LoadedDocx): string | null {
  for (const p of findAll(doc.body, "p")) {
    if (headingLevelOf(p, doc.headingStyles) === 1) {
      const text = paragraphText(p);
      if (text.length > 0) return text;
    }
  }
  return null;
}
