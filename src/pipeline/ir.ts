/**
 * The Block IR — the single contract every parser compiles to.
 *
 * This is the keystone of format-agnosticism. Each parser is a format expert
 * whose only job is to emit a stream of DocBlocks; the chunker, the outline
 * builder and the retrieval layer never learn what format a document came
 * from. Adding a format is one new file in parsers/ plus one branch in
 * router.ts, and nothing downstream changes.
 */

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "code"
  | "quote"
  | "caption";

export type LocatorType = "page" | "section";

/**
 * Formats the router can RECOGNISE. Several are recognised only so they can be
 * refused by name — see PARSERS and NOT_YET in router.ts. Sniffing a format
 * this build cannot read is deliberate: "this is an EPUB and I do not read
 * EPUBs" is a usable answer, "this file appears to be binary" is not.
 */
export type Format = "pdf" | "epub" | "docx" | "pptx" | "md" | "html" | "txt";

export interface Locator {
  type: LocatorType;
  /** "41", "sec-2" */
  value: string;
  /** 0-based, monotonic across the document. */
  ordinal: number;
  /** "xii", "342" — as printed on a PDF page, when it differs from the ordinal. */
  printedLabel?: string;
}

/** Normalized [x, y, w, h] in 0..1 page space. Only PDF emits it. */
export type BBox = [number, number, number, number];

export interface DocBlock {
  kind: BlockKind;
  /** Heading depth 1..6. Only meaningful when kind === "heading". */
  level?: number;
  /** GFM markdown: tables as pipe tables, code fenced. */
  text: string;
  locator: Locator;
  /** The heading trail in effect at this block. */
  sectionPath: string[];
  bbox?: BBox | null;
  attrs?: {
    language?: string;
    ordered?: boolean;
    fontSize?: number;
    bold?: boolean;
  };
}

export interface DocumentMetadata {
  title?: string;
  locatorScheme: LocatorType;
  /** page / section count. */
  locatorCount: number;
  /**
   * Set when the parser knows it is skipping real content. Persisted on the
   * document row so the incompleteness stays visible after the ingest reply —
   * a document must never look more indexed than it is.
   *
   * No parser sets this today: its only producer was the PPTX reader, which
   * warned about unread chart data and was removed with the format. The
   * channel is kept because it is the general way a parser admits partial
   * coverage, and because retiring the column would need a schema bump — which
   * costs a full re-ingest of every library, OCR included, to delete a
   * nullable field.
   */
  warning?: string;
}

/**
 * One opened document, read from disk exactly once.
 *
 * Parsers take this rather than a path so that the bytes a document is hashed
 * from are provably the bytes it is indexed from. Given a path, each stage
 * opened the file again — hash, sniff, probe, metadata, parse — and a file
 * edited between two of those reads produced an index whose contents and whose
 * sha256 came from different revisions. See `source.ts`.
 */
export interface DocumentSource {
  /** Absolute on-disk path. For diagnostics and basename-derived titles. */
  readonly absPath: string;
  /** The whole file: the exact bytes the document's sha256 is taken over. */
  readonly bytes: Uint8Array;
  /** The first 512 bytes, for format sniffing. */
  readonly head: Uint8Array;
  /** `bytes` decoded as UTF-8. Decoded once and reused. */
  text(): string;
  /**
   * Memoise a format-specific derived resource under `key`, building it at
   * most once per source and disposing it on `close()`.
   *
   * This is how a PDF gets parsed by pdfjs one time instead of three. The IR
   * stays format-blind — it memoises an opaque value it never looks inside —
   * while `loadPdf` gets to be called freely from the probe, the metadata pass
   * and the parse without any of them coordinating.
   */
  derive<T>(
    key: string,
    make: () => Promise<T>,
    dispose?: (value: T) => Promise<void>,
  ): Promise<T>;
  /** Release every derived resource. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Every parser implements exactly this.
 *
 * `parse` is an AsyncIterable rather than a returned array so the chunker
 * consumes blocks as they are produced and the embedder batches behind it,
 * instead of the whole block stream being materialised first. Note that this
 * bounds the BLOCKS, not the source: `DocumentSource` holds the file in
 * memory, which every parser here needed anyway.
 */
export interface DocumentParser {
  parse(src: DocumentSource): AsyncIterable<DocBlock>;
  metadata(src: DocumentSource): Promise<DocumentMetadata>;
}

/**
 * The coarser kind actually stored on a chunk. Several block kinds collapse
 * into "text" because retrieval only cares about the distinctions that are
 * worth filtering on.
 */
export type ChunkKind = "text" | "table" | "code" | "list" | "heading";

export function toChunkKind(kind: BlockKind): ChunkKind {
  switch (kind) {
    case "table":
      return "table";
    case "code":
      return "code";
    case "list":
      return "list";
    case "heading":
      return "heading";
    // paragraph / quote / caption are all just prose to the retrieval layer.
    default:
      return "text";
  }
}

export class UnsupportedFormatError extends Error {
  override readonly name = "UnsupportedFormatError";
}
