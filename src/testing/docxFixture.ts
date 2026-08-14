import { strToU8, zipSync, type Zippable } from "fflate";

/**
 * A minimal, hand-assembled DOCX — for tests only. The philosophy the whole
 * suite follows: precise structural cases, no binary blobs in the repository.
 */

/** A note cited by the block it hangs off. `kind` picks which part it lands in. */
export interface DocxNoteSpec {
  kind: "footnote" | "endnote";
  text: string;
}

export type DocxBlockSpec =
  | { heading: string; level: number; note?: DocxNoteSpec }
  | { paragraph: string; note?: DocxNoteSpec }
  | { quote: string }
  | { bullets: (string | { text: string; level: number; note?: DocxNoteSpec })[] }
  | { table: string[][] };

export interface DocxFixtureSpec {
  dcTitle?: string;
  blocks: DocxBlockSpec[];
}

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";

const xml = (body: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const para = (text: string, pPr = "", extraRuns = ""): string =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}` +
  `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>${extraRuns}</w:p>`;

/**
 * Hands out note ids and collects their text.
 *
 * Ids start at 1 because Word reserves -1 and 0 for the separator notes every
 * file carries, which `buildDocx` emits so the parser's filtering of them is
 * exercised against the real shape rather than an idealised one.
 */
class NoteAllocator {
  readonly footnotes: { id: number; text: string }[] = [];
  readonly endnotes: { id: number; text: string }[] = [];
  private next = 1;

  /** The run that cites `note`, to be appended inside the citing paragraph. */
  ref(note: DocxNoteSpec | undefined): string {
    if (!note) return "";
    const id = this.next++;
    const tag = note.kind === "footnote" ? "footnoteReference" : "endnoteReference";
    (note.kind === "footnote" ? this.footnotes : this.endnotes).push({ id, text: note.text });
    return `<w:r><w:${tag} w:id="${id}"/></w:r>`;
  }
}

function blockXml(block: DocxBlockSpec, notes: NoteAllocator): string {
  if ("heading" in block) {
    return para(
      block.heading,
      `<w:pStyle w:val="Heading${block.level}"/>`,
      notes.ref(block.note),
    );
  }
  if ("paragraph" in block) return para(block.paragraph, "", notes.ref(block.note));
  if ("quote" in block) return para(block.quote, `<w:pStyle w:val="Quote"/>`);
  if ("bullets" in block) {
    return block.bullets
      .map((b) => {
        const spec = typeof b === "string" ? { text: b, level: 0, note: undefined } : b;
        return para(
          spec.text,
          `<w:numPr><w:ilvl w:val="${spec.level}"/><w:numId w:val="1"/></w:numPr>`,
          notes.ref(spec.note),
        );
      })
      .join("");
  }
  const rows = block.table
    .map(
      (cells) =>
        `<w:tr>` +
        cells.map((c) => `<w:tc><w:tcPr/>${para(c)}</w:tc>`).join("") +
        `</w:tr>`,
    )
    .join("");
  return `<w:tbl><w:tblPr/><w:tblGrid/>${rows}</w:tbl>`;
}

export function buildDocx(spec: DocxFixtureSpec): Buffer {
  const files: Zippable = {};
  const overrides: string[] = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
  ];

  const notes = new NoteAllocator();
  const body = spec.blocks.map((b) => blockXml(b, notes)).join("");

  files["word/document.xml"] = strToU8(
    xml(`<w:document xmlns:w="${NS_W}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
  );

  for (const [kind, collected] of [
    ["footnote", notes.footnotes],
    ["endnote", notes.endnotes],
  ] as const) {
    if (collected.length === 0) continue;
    const part = `word/${kind}s.xml`;
    files[part] = strToU8(
      xml(
        `<w:${kind}s xmlns:w="${NS_W}">` +
          // The furniture Word writes into every file, real notes or not.
          `<w:${kind} w:type="separator" w:id="-1">${para("")}</w:${kind}>` +
          `<w:${kind} w:type="continuationSeparator" w:id="0">${para("")}</w:${kind}>` +
          collected
            .map((n) => `<w:${kind} w:id="${n.id}">${para(n.text)}</w:${kind}>`)
            .join("") +
          `</w:${kind}s>`,
      ),
    );
    overrides.push(
      `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.` +
        `wordprocessingml.${kind}s+xml"/>`,
    );
  }

  if (spec.dcTitle !== undefined) {
    files["docProps/core.xml"] = strToU8(
      xml(
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
          `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(spec.dcTitle)}</dc:title></cp:coreProperties>`,
      ),
    );
    overrides.push(
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    );
  }

  files["[Content_Types].xml"] = strToU8(
    xml(
      `<Types xmlns="${NS_CT}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        overrides.join("") +
        `</Types>`,
    ),
  );
  files["_rels/.rels"] = strToU8(
    xml(
      `<Relationships xmlns="${NS_REL}">` +
        `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
  );

  return Buffer.from(zipSync(files));
}
