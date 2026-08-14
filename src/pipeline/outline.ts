import type { Locator } from "./ir.js";

/**
 * The heading tree, built from emitted chunks rather than from raw IR.
 *
 * Chunks are what carry `seq`, and the outline's whole purpose is to hand a
 * caller a span it can jump to with get_chunk_context. Deriving the tree from
 * chunks means the spans are true by construction instead of being correlated
 * back afterwards, and it works identically for every format because a
 * sectionPath is a sectionPath whether it came from an ATX heading, a DOCX
 * style or a PDF font-size tier.
 */

export interface OutlineLocator {
  type: Locator["type"];
  value: string;
  ordinal: number;
  printed_label: string | null;
}

export interface OutlineNode {
  title: string;
  level: number;
  locator: OutlineLocator;
  chunk_seq_start: number;
  chunk_seq_end: number;
  children: OutlineNode[];
}

export class OutlineBuilder {
  private readonly roots: OutlineNode[] = [];

  /**
   * The nodes currently open, innermost last — the trail from a root down to
   * whatever section the previous chunk sat in.
   *
   * This replaced a document-global Map keyed by the joined heading trail,
   * which made a section's IDENTITY its title path. Two sections with the same
   * trail were therefore the same node wherever they sat in the document, so a
   * file with a repeated `## Notes` — an ordinary shape for a working notebook
   * — collapsed into one node whose span ran from the first occurrence to the
   * last and swallowed everything between them. The outline advertises
   * `chunk_seq_start` as a jump target, so that sent a caller to the wrong
   * place and reported a section far longer than it is; the merged node also
   * froze its locator at first sighting, citing page 3 for a span reaching
   * page 210.
   *
   * A title is a label. Identity is position: the same trail, still open,
   * uninterrupted. Re-entering a trail after leaving it opens a new section.
   */
  private readonly open: OutlineNode[] = [];

  /**
   * Record one chunk against the tree.
   *
   * Chunks whose sectionPath is empty — anything before the first heading —
   * deliberately create no node. A document with no headings therefore yields
   * an empty outline, which is an honest answer rather than a fabricated root.
   */
  add(seq: number, sectionPath: readonly string[], locator: Locator): void {
    for (let depth = 0; depth < sectionPath.length; depth++) {
      const title = sectionPath[depth]!;
      const current = this.open[depth];

      // Reuse the open node only while the trail has matched all the way down
      // to here. A mismatch at any depth closes that node and everything under
      // it, because a section cannot resume once its parent has moved on.
      if (!current || current.title !== title) {
        this.open.length = depth;
        const node: OutlineNode = {
          title,
          level: depth + 1,
          locator: {
            type: locator.type,
            value: locator.value,
            ordinal: locator.ordinal,
            printed_label: locator.printedLabel ?? null,
          },
          chunk_seq_start: seq,
          chunk_seq_end: seq,
          children: [],
        };
        (this.open[depth - 1]?.children ?? this.roots).push(node);
        this.open.push(node);
      }

      // Every ancestor of this chunk extends to cover it, so a parent's span
      // stays contiguous by construction rather than by reconciliation.
      const node = this.open[depth]!;
      node.chunk_seq_end = Math.max(node.chunk_seq_end, seq);
    }

    // Anything deeper than this chunk's trail is no longer open.
    this.open.length = sectionPath.length;
  }

  build(): OutlineNode[] {
    return this.roots;
  }
}

/** Prune to `maxDepth` levels for get_document_outline. */
export function pruneOutline(nodes: readonly OutlineNode[], maxDepth: number): OutlineNode[] {
  if (maxDepth <= 0) return [];
  return nodes.map((n) => ({
    ...n,
    children: pruneOutline(n.children, maxDepth - 1),
  }));
}
