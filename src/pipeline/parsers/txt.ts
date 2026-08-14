import path from "node:path";
import type {
  DocBlock,
  DocumentMetadata,
  DocumentParser,
  DocumentSource,
} from "../ir.js";

/**
 * Plain text -> IR.
 *
 * Nothing here is reliable the way a real format's structure is; these are
 * heuristics over prose that happens to be conventionally formatted. The
 * outline for a .txt is therefore allowed to come out flat, and
 * get_document_outline returning a single root for an unstructured file is a
 * correct answer rather than a failure.
 */

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+\S/;

/**
 * Heading level for a line, or null if it reads as body text.
 *
 * Deliberately conservative: a false positive fragments a document into
 * meaningless sections, which is worse than a flat outline.
 */
export function headingLevel(line: string, next: string | undefined): number | null {
  const t = line.trim();
  if (!t || t.length > 90) return null;

  const n = next?.trim() ?? "";

  // "1. Introduction" is both a plausible numbered section and a plausible
  // list item, and LIST_ITEM claimed every one of them — so the single-level
  // case in the comment below was unreachable, and a text file numbering its
  // sections the commonest way got a flat outline. The discriminator is what
  // follows: a section heading is followed by a blank line, a list item by its
  // sibling or by its own wrapped continuation. Requiring the blank line keeps
  // the parser's bias intact, since the cost of guessing wrong here is a whole
  // document fragmented into sections that do not exist.
  const looksLikeListItem = LIST_ITEM.test(line);
  const singleLevelNumbered = /^\d+[.)]\s+\S/.test(t);
  if (looksLikeListItem && !(singleLevelNumbered && n === "")) return null;

  // Setext underlines.
  if (/^={3,}$/.test(n)) return 1;
  if (/^-{3,}$/.test(n)) return 2;

  // Numbered sections: "1. Introduction", "1.2 Methods", "2.3.1 Sampling".
  const numbered = /^(\d+(?:\.\d+)*)\.?\s+\S/.exec(t);
  if (numbered && !/[.!?]$/.test(t)) {
    return Math.min(6, numbered[1]!.split(".").length);
  }

  // Named divisions.
  if (/^(chapter|part|section|appendix|book)\b/i.test(t)) return 1;

  // ALL-CAPS lines. Requires a letter, so "1234" or "----" do not qualify.
  if (t === t.toUpperCase() && /\p{Lu}/u.test(t) && !/[.!?]$/.test(t)) return 2;

  return null;
}

export class TxtParser implements DocumentParser {
  async *parse(src: DocumentSource): AsyncIterable<DocBlock> {
    const source = src.text();
    yield* blocksOf(source);
  }

  async metadata(src: DocumentSource): Promise<DocumentMetadata> {
    const source = src.text();
    const lines = source.split(/\r?\n/);
    let locatorCount = 0;
    let firstHeading: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const level = headingLevel(lines[i]!, lines[i + 1]);
      if (level === null || level > 2) continue;
      locatorCount++;
      firstHeading ??= lines[i]!.trim();
    }

    return {
      title: firstHeading ?? path.basename(src.absPath, path.extname(src.absPath)),
      locatorScheme: "section",
      locatorCount: Math.max(1, locatorCount),
    };
  }
}

function* blocksOf(source: string): Generator<DocBlock> {
  const lines = source.split(/\r?\n/);

  let trail: string[] = [];
  let ordinal = 0;
  let para: string[] = [];
  let list: string[] = [];

  const block = (
    kind: DocBlock["kind"],
    text: string,
    sectionPath: string[],
    level?: number,
  ): DocBlock => ({
    kind,
    ...(level === undefined ? {} : { level }),
    text,
    locator: { type: "section", value: `sec-${ordinal}`, ordinal },
    sectionPath,
    bbox: null,
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const level = headingLevel(line, lines[i + 1]);

    if (level !== null) {
      if (para.length > 0) {
        yield block("paragraph", para.join("\n").trim(), trail);
        para = [];
      }
      if (list.length > 0) {
        yield block("list", list.join("\n").trim(), trail);
        list = [];
      }

      const title = line.trim();
      const parentTrail = trail.slice(0, level - 1);
      if (level <= 2) ordinal++;

      yield block("heading", title, parentTrail, level);
      trail = [...parentTrail, title];

      // Consume a setext underline so it never becomes body text.
      const nextTrimmed = lines[i + 1]?.trim() ?? "";
      if (/^(={3,}|-{3,})$/.test(nextTrimmed)) i++;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      if (para.length > 0) {
        yield block("paragraph", para.join("\n").trim(), trail);
        para = [];
      }
      list.push(line);
      continue;
    }

    if (line.trim() === "") {
      if (para.length > 0) {
        yield block("paragraph", para.join("\n").trim(), trail);
        para = [];
      }
      if (list.length > 0) {
        yield block("list", list.join("\n").trim(), trail);
        list = [];
      }
      continue;
    }

    // A non-blank, non-item line directly under a list is a continuation of
    // the current item rather than the start of a paragraph.
    if (list.length > 0) {
      list.push(line);
      continue;
    }
    para.push(line);
  }

  if (para.length > 0) yield block("paragraph", para.join("\n").trim(), trail);
  if (list.length > 0) yield block("list", list.join("\n").trim(), trail);
}
