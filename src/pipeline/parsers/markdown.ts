import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { toString as mdToString } from "mdast-util-to-string";
import type { Heading, Root, RootContent } from "mdast";
import type {
  BlockKind,
  DocBlock,
  DocumentMetadata,
  DocumentParser,
  DocumentSource,
} from "../ir.js";

/**
 * Markdown -> IR.
 *
 * The unified/remark stack is the one already proven in obsidian-mcp, and the
 * same principle applies here: the AST is used only to LOCATE blocks, and
 * every block's text is sliced from the original source. remark-stringify
 * escapes `[`, which would corrupt wikilinks, embeds and callouts — so it is
 * never used. Slicing also means an ingested chunk is byte-identical to what
 * is on disk, which is what makes a quoted passage trustworthy.
 */
const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/** mdast node type -> IR block kind. Anything absent is skipped. */
const KIND_BY_TYPE: Partial<Record<RootContent["type"], BlockKind>> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  table: "table",
  code: "code",
  blockquote: "quote",
};

export class MarkdownParser implements DocumentParser {
  async *parse(src: DocumentSource): AsyncIterable<DocBlock> {
    const source = src.text();
    const tree: Root = processor.parse(source);

    // The heading trail in effect for BODY blocks. A heading block itself
    // carries its ancestors only, not its own title.
    let trail: string[] = [];

    // `section` scheme: the locator advances at every H1/H2. The spec left
    // locator_value undefined for section-scheme formats; this is the rule.
    let ordinal = 0;

    for (const node of tree.children) {
      const kind = KIND_BY_TYPE[node.type];
      if (!kind) continue; // yaml frontmatter, thematicBreak, raw html

      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const text = source.slice(start, end).trim();
      if (!text) continue;

      if (node.type === "heading") {
        const heading = node as Heading;
        const title = mdToString(heading).trim();
        const parentTrail = trail.slice(0, heading.depth - 1);

        if (heading.depth <= 2) ordinal++;

        yield {
          kind: "heading",
          level: heading.depth,
          text,
          locator: { type: "section", value: `sec-${ordinal}`, ordinal },
          sectionPath: parentTrail,
          bbox: null,
        };

        trail = [...parentTrail, title];
        continue;
      }

      yield {
        kind,
        text,
        locator: { type: "section", value: `sec-${ordinal}`, ordinal },
        sectionPath: trail,
        bbox: null,
        ...(node.type === "code"
          ? { attrs: { language: node.lang ?? undefined } }
          : {}),
        ...(node.type === "list" ? { attrs: { ordered: node.ordered ?? false } } : {}),
      };
    }
  }

  async metadata(src: DocumentSource): Promise<DocumentMetadata> {
    const source = src.text();

    // A cheap scan rather than a second full parse. locatorCount is only used
    // as a progress denominator; the runner records the true count once the
    // stream has been consumed.
    const fenced = /^```/gm;
    let inFence = false;
    let locatorCount = 0;
    let firstH1: string | null = null;

    for (const line of source.split(/\r?\n/)) {
      if (fenced.test(line)) inFence = !inFence;
      fenced.lastIndex = 0;
      if (inFence) continue;
      const m = /^(#{1,2})\s+(.*)$/.exec(line);
      if (!m) continue;
      locatorCount++;
      // `# ` with nothing after it matches too; an empty capture is no title.
      if (m[1] === "#" && firstH1 === null) firstH1 = m[2]?.trim() || null;
    }

    return {
      title: frontmatterTitle(source) ?? firstH1 ?? path.basename(src.absPath, path.extname(src.absPath)),
      locatorScheme: "section",
      locatorCount: Math.max(1, locatorCount),
    };
  }
}

/** `title:` from YAML frontmatter, without pulling in a YAML parser. */
function frontmatterTitle(source: string): string | null {
  if (!source.startsWith("---")) return null;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return null;
  const m = /^title:\s*(.+)$/m.exec(source.slice(0, end));
  // `title: ""` unquotes to nothing; an empty value is no title.
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") || null;
}
