import {
  type BBox,
  type ChunkKind,
  type DocBlock,
  type Locator,
  type LocatorType,
  toChunkKind,
} from "./ir.js";
import {
  estimateTokens,
  splitCode,
  splitList,
  splitProse,
  splitTable,
  takeLastTokens,
} from "../util/tokens.js";

/**
 * The layout-aware semantic chunker. One implementation for every format,
 * because it consumes the IR and never learns what produced it.
 *
 * This module is where the citation guarantee lives. Everything else in the
 * system trusts that a chunk belongs to exactly one locator.
 */

export const TARGET_TOKENS = 350;

/**
 * DEVIATION from the source spec, which used 512 (bge-small's true input
 * limit). fastembed pads every input to `maxLength`, so embed cost scales
 * with this number: measured on this machine, 512 => 140s to embed a
 * 400-page book, 400 => 105s, 256 => 64s. 400 keeps headroom under the
 * model's limit *and* buys a 25% faster ingest.
 */
export const MAX_TOKENS = 400;

export const OVERLAP_TOKENS = 40;

export interface DraftChunk {
  kind: ChunkKind;
  locator: Locator;
  sectionPath: string[];
  bbox: BBox | null;
  /** Clean GFM. This is what gets stored, FTS-indexed and returned to callers. */
  text: string;
  /**
   * Trailing text of the previous chunk, for embedding only.
   *
   * DEVIATION from the source spec, which folded overlap into the chunk text
   * itself. Overlap exists to stop a passage that straddles a boundary from
   * being invisible to the vector index — that is an *embedding* concern. Left
   * in the stored text it would also make get_chunk_context repeat sentences
   * across every adjacent chunk in a read window. Keeping it separate mirrors
   * what the spec already does for section paths: enrich the embedded input,
   * store the clean text.
   */
  overlapPrefix: string | null;
  tokenCount: number;
}

export interface ChunkerOptions {
  scheme: LocatorType;
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

/**
 * The boundary law, as a key.
 *
 * Two blocks may share a chunk only if this key matches. Every scheme this
 * build emits makes the locator alone sufficient: `page` advances per page, and
 * `section` is advanced by the parser at every H1/H2.
 *
 * The spec's second rule — never cross an H1/H2 boundary *inside* one locator —
 * lived here for the EPUB `part` scheme, where a single spine file could run
 * for dozens of pages and several chapters. It went out with that format. Any
 * future locator that can span many headings needs it back; without it, a chunk
 * drawn from such a locator carries a section path correct for only part of its
 * own text.
 */
function boundaryKey(block: DocBlock, _scheme: LocatorType): string {
  return block.locator.value;
}

function splitBlock(block: DocBlock, maxTokens: number): string[] {
  switch (block.kind) {
    case "table":
      return splitTable(block.text, maxTokens);
    case "code":
      return splitCode(block.text, maxTokens);
    case "list":
      return splitList(block.text, maxTokens);
    default:
      return splitProse(block.text, maxTokens);
  }
}

function chunkKindFor(blocks: DocBlock[]): ChunkKind {
  const kinds = new Set(
    blocks.filter((b) => b.kind !== "heading").map((b) => toChunkKind(b.kind)),
  );
  if (kinds.size === 0) return "heading";
  if (kinds.size === 1) return [...kinds][0]!;
  return "text";
}

/**
 * The section path a chunk is filed under.
 *
 * A chunk carries at most a run of headings at its front (a heading always
 * opens a new chunk, and consecutive headings group), so the most specific
 * path is the one on the last non-heading block. When a chunk is nothing but
 * headings, the deepest heading contributes its own title.
 */
function sectionPathFor(blocks: DocBlock[]): string[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind !== "heading") return block.sectionPath;
  }
  const last = blocks.at(-1)!;
  return [...last.sectionPath, last.text.replace(/^#+\s*/, "").trim()];
}

/** The union rectangle of every contributing block that carried one. */
function unionBBox(blocks: DocBlock[]): BBox | null {
  const boxes = blocks
    .map((b) => b.bbox)
    .filter((b): b is BBox => Array.isArray(b) && b.length === 4);
  if (boxes.length === 0) return null;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h] of boxes) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

export async function* chunkBlocks(
  blocks: AsyncIterable<DocBlock>,
  opts: ChunkerOptions,
): AsyncIterable<DraftChunk> {
  const target = opts.targetTokens ?? TARGET_TOKENS;
  const max = opts.maxTokens ?? MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? OVERLAP_TOKENS;

  let buf: DocBlock[] = [];
  let bufTokens = 0;
  let currentKey: string | null = null;

  /**
   * The previously emitted chunk, kept only so the next one can overlap it.
   *
   * DEVIATION from the source spec, which applied overlap between chunks
   * sharing a sectionPath. Consecutive pages routinely share a sectionPath, so
   * that rule would splice page-41 text into a page-42 chunk and break the
   * boundary law the whole design rests on. Overlap therefore requires the
   * locator to match as well.
   */
  let prev: { text: string; locatorValue: string; sectionPath: string } | null = null;

  const sectionKey = (p: string[]) => JSON.stringify(p);
  const sumTokens = (bs: DocBlock[]) =>
    bs.reduce((s, b) => s + estimateTokens(b.text), 0);

  function makeChunk(
    contributing: DocBlock[],
    textOverride?: string,
    kindOverride?: ChunkKind,
  ): DraftChunk {
    const text = textOverride ?? contributing.map((b) => b.text).join("\n\n");
    const sectionPath = sectionPathFor(contributing);
    const locator = contributing[0]!.locator;

    const canOverlap =
      prev !== null &&
      prev.locatorValue === locator.value &&
      prev.sectionPath === sectionKey(sectionPath);

    const chunk: DraftChunk = {
      kind: kindOverride ?? chunkKindFor(contributing),
      locator,
      sectionPath,
      bbox: unionBBox(contributing),
      text,
      overlapPrefix:
        canOverlap && overlapTokens > 0
          ? takeLastTokens(prev!.text, overlapTokens)
          : null,
      tokenCount: estimateTokens(text),
    };

    prev = {
      text,
      locatorValue: locator.value,
      sectionPath: sectionKey(sectionPath),
    };
    return chunk;
  }

  /**
   * Emit the buffer.
   *
   * With `force`, everything goes — used at a boundary change, where holding
   * anything back would carry text across a locator and break the guarantee.
   * Without it, trailing headings are held over so a heading is never stranded
   * as the last thing in a chunk, separated from the body it introduces.
   */
  function* drain(force: boolean): Generator<DraftChunk> {
    if (buf.length === 0) return;

    let cut = buf.length;
    if (!force) {
      while (cut > 0 && buf[cut - 1]!.kind === "heading") cut--;
      // Nothing but headings: keep accumulating rather than emit a bodiless
      // chunk. The next body block will join them.
      if (cut === 0) return;
    }

    const emitting = buf.slice(0, cut);
    const held = buf.slice(cut);
    yield makeChunk(emitting);
    buf = held;
    bufTokens = sumTokens(held);
  }

  for await (const block of blocks) {
    const key = boundaryKey(block, opts.scheme);

    if (currentKey !== null && key !== currentKey) {
      yield* drain(true);
      buf = [];
      bufTokens = 0;
      prev = null; // overlap never survives a boundary
    }
    currentKey = key;

    const blockTokens = estimateTokens(block.text);

    // Structural atomicity: a table or code block over budget splits on its
    // own terms (row groups / line boundaries), never mid-structure.
    if (blockTokens > max) {
      let cut = buf.length;
      while (cut > 0 && buf[cut - 1]!.kind === "heading") cut--;
      const headings = buf.slice(cut);
      buf = buf.slice(0, cut);
      bufTokens = sumTokens(buf);

      yield* drain(true);
      buf = [];
      bufTokens = 0;

      const parts = splitBlock(block, max);
      for (let i = 0; i < parts.length; i++) {
        const carryHeadings = i === 0 && headings.length > 0;
        const contributing = carryHeadings ? [...headings, block] : [block];
        // The heading rides along with the first part even though it pushes
        // slightly past `max`. Headings are short, the cap has headroom under
        // the model's real limit, and orphaning it would be worse.
        const text = carryHeadings
          ? `${headings.map((h) => h.text).join("\n\n")}\n\n${parts[i]!}`
          : parts[i]!;
        yield makeChunk(contributing, text, toChunkKind(block.kind));
      }
      continue;
    }

    // Tables and code get a chunk of their own, even when they would fit
    // alongside neighbouring prose.
    //
    // The spec only required them to be indivisible, which is weaker. Left
    // merged into a mixed chunk, a table's `kind` degrades to "text" — so
    // filter.kind = "table" matches nothing, and the table's embedding is
    // diluted by whatever prose happened to sit next to it. Isolating them
    // makes the filter mean something and keeps the vector about the table.
    // Surrounding prose is still one get_chunk_context neighbour away, and the
    // section path travels with the embedding regardless.
    if (block.kind === "table" || block.kind === "code") {
      if (buf.some((b) => b.kind !== "heading")) yield* drain(false);
      buf.push(block);
      bufTokens += blockTokens;
      // force: an introducing heading run is already at the front of the
      // buffer and belongs with this block, not with whatever follows it.
      yield* drain(true);
      buf = [];
      bufTokens = 0;
      continue;
    }

    if (bufTokens > 0 && bufTokens + blockTokens > max) {
      yield* drain(false);
    }

    // Heading cohesion: a heading opens a new chunk. Consecutive headings are
    // allowed to group so that "Part II" / "Chapter 3" stay together.
    if (block.kind === "heading" && buf.some((b) => b.kind !== "heading")) {
      yield* drain(false);
    }

    buf.push(block);
    bufTokens += blockTokens;

    if (bufTokens >= target) {
      yield* drain(false);
    }
  }

  yield* drain(true);
}
