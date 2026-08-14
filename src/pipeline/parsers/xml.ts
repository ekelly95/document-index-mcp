import { DOMParser } from "linkedom";

/**
 * The XML walking kit for the zip+XML formats. DOCX is the only one left.
 *
 * Everything is matched by local name with any namespace prefix stripped:
 * real documents arrive as `<dc:title>`, `<w:p>`, plain `<item>`, and every
 * mix in between, and linkedom preserves prefixes in `localName`.
 */

/**
 * The sliver of DOM these parsers touch, declared structurally because the
 * build has no DOM lib. linkedom's real nodes satisfy it at runtime; keeping
 * the surface this small is also what keeps the walkers honest about what
 * they depend on.
 */
export interface XmlNode {
  nodeType: number;
  textContent: string | null;
}
export interface XmlElement extends XmlNode {
  localName: string;
  children: Iterable<XmlElement>;
  childNodes: Iterable<XmlNode>;
  getAttribute(name: string): string | null;
}

export const collapse = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim();

/** Local name with any namespace prefix stripped: `dc:title` -> `title`. */
export const local = (el: XmlElement): string => {
  const name = el.localName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
};

export const elements = (parent: XmlElement): XmlElement[] => [...parent.children];

/** Depth-first descendants with the given (prefix-stripped) local name. */
export function findAll(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (el: XmlElement): void => {
    if (local(el) === name) out.push(el);
    for (const child of elements(el)) visit(child);
  };
  for (const el of elements(root)) visit(el);
  return out;
}

export const findFirst = (root: XmlElement, name: string): XmlElement | null =>
  findAll(root, name)[0] ?? null;

export function parseXml(text: string): XmlElement {
  return new DOMParser().parseFromString(text, "text/xml") as unknown as XmlElement;
}

/**
 * Rows of already-extracted cell text -> a GFM pipe table, the block `text`
 * convention ir.ts sets for tables. Returns null when there is nothing to
 * render, so callers can skip the block the way they skip empty paragraphs.
 */
export function gfmTable(rows: string[][]): string | null {
  const [head, ...body] = rows;
  if (!head || head.length === 0) return null;
  const cell = (s: string): string => collapse(s).replace(/\|/g, "\\|");
  const line = (cells: string[]): string => `| ${cells.map(cell).join(" | ")} |`;
  return [
    line(head),
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map(line).filter((l) => l !== "|  |"),
  ].join("\n");
}
