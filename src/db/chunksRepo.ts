import type { BBox, ChunkKind, Locator, LocatorType } from "../pipeline/ir.js";
import { type Db, packVector, vecRowid } from "./sqlite.js";

export interface ChunkRow {
  id: number;
  chunk_id: string;
  document_id: string;
  seq: number;
  kind: ChunkKind;
  locator_type: LocatorType;
  locator_value: string;
  locator_ordinal: number;
  page_number: number | null;
  printed_label: string | null;
  section_path: string;
  bbox: string | null;
  text: string;
  token_count: number;
}

export interface InsertableChunk {
  chunkId: string;
  seq: number;
  kind: ChunkKind;
  locator: Locator;
  pageNumber: number | null;
  sectionPath: readonly string[];
  bbox: BBox | null;
  text: string;
  tokenCount: number;
  embedding: readonly number[];
}

/**
 * Insert a batch of chunks and their vectors in one transaction.
 *
 * The FTS index needs no explicit write: the AFTER INSERT trigger on
 * document_chunks does it. The vector table does, and its key must be the
 * rowid SQLite just assigned.
 */
export function insertChunks(
  db: Db,
  documentId: string,
  chunks: readonly InsertableChunk[],
): void {
  if (chunks.length === 0) return;

  const insertChunk = db.prepare(
    `INSERT INTO document_chunks (
       chunk_id, document_id, seq, kind, locator_type, locator_value,
       locator_ordinal, page_number, printed_label, section_path, bbox,
       text, token_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks(chunk_rowid, document_id, embedding) VALUES (?, ?, ?)",
  );

  db.transaction((rows: readonly InsertableChunk[]) => {
    for (const c of rows) {
      const info = insertChunk.run(
        c.chunkId,
        documentId,
        c.seq,
        c.kind,
        c.locator.type,
        c.locator.value,
        c.locator.ordinal,
        c.pageNumber,
        c.locator.printedLabel ?? null,
        JSON.stringify(c.sectionPath),
        c.bbox ? JSON.stringify(c.bbox) : null,
        c.text,
        c.tokenCount,
      );
      // vecRowid() returns a BigInt deliberately: better-sqlite3 binds plain
      // numbers as REAL and vec0 refuses a non-INTEGER primary key.
      insertVec.run(
        vecRowid(Number(info.lastInsertRowid)),
        documentId,
        packVector(c.embedding as number[]),
      );
    }
  })(chunks);
}

export function byChunkId(db: Db, chunkId: string): ChunkRow | undefined {
  return db.prepare("SELECT * FROM document_chunks WHERE chunk_id = ?").get(chunkId) as
    | ChunkRow
    | undefined;
}

export function bySeq(db: Db, documentId: string, seq: number): ChunkRow | undefined {
  return db
    .prepare("SELECT * FROM document_chunks WHERE document_id = ? AND seq = ?")
    .get(documentId, seq) as ChunkRow | undefined;
}

/** Chunks in [lo, hi] by seq, in reading order. */
export function seqRange(
  db: Db,
  documentId: string,
  lo: number,
  hi: number,
): ChunkRow[] {
  return db
    .prepare(
      "SELECT * FROM document_chunks WHERE document_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
    )
    .all(documentId, lo, hi) as ChunkRow[];
}

export function chunkExists(db: Db, documentId: string, seq: number): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM document_chunks WHERE document_id = ? AND seq = ?")
    .get(documentId, seq) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * A chunk row carrying its document's identity, from the join `byRowids`
 * already needed for the ready-only check. Search hits are built from these so
 * a library-wide result can say which source produced it — `source_path` is
 * library-relative by construction (see the documents DDL), never absolute.
 */
export interface HydratedChunkRow extends ChunkRow {
  document_title: string;
  source_path: string;
}

/** Restrictions applied while hydrating candidates, not after. */
export interface RowidFilter {
  /** Drop chunks of documents that are not finished indexing. */
  readyOnly?: boolean;
  kind?: ChunkKind;
  pageRange?: readonly [number, number];
}

/**
 * Hydrate ranked candidates, discarding the ones that fail the filter.
 *
 * The filtering happens HERE rather than in the caller's loop because the
 * vector leg can only pre-filter on its partition key, so everything else it
 * returns has to be checked afterwards — and the wider the net that leg casts,
 * the more rows would be loaded, `text` and all, purely to be thrown away. In
 * SQL those rows are never materialised.
 *
 * The id list is bounded by the caller's overfetch, and that bound is the
 * reason no chunking is needed here. Worst case is both legs saturated and
 * escalated to the cap: k=50 x 32 x 2^3 per leg, and the ranked list is their
 * UNION, so 25,600 ids plus a couple of filter parameters — inside SQLite's
 * 32,766-parameter limit, but not by so much that MAX_ESCALATIONS can be
 * raised without revisiting this.
 */
export function byRowids(
  db: Db,
  ids: readonly number[],
  filter: RowidFilter = {},
): Map<number, HydratedChunkRow> {
  if (ids.length === 0) return new Map();

  const where: string[] = [`c.id IN (${ids.map(() => "?").join(",")})`];
  const params: unknown[] = [...ids];

  if (filter.readyOnly) where.push("d.ingest_status = 'ready'");
  if (filter.kind) {
    where.push("c.kind = ?");
    params.push(filter.kind);
  }
  if (filter.pageRange) {
    where.push("c.page_number BETWEEN ? AND ?");
    params.push(filter.pageRange[0], filter.pageRange[1]);
  }

  const rows = db
    .prepare(
      `SELECT c.*, d.title AS document_title, d.source_path AS source_path
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as HydratedChunkRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Row-count reconciliation across the three indexes. Used by tests and the CLI. */
export function indexCounts(db: Db): {
  chunks: number;
  fts: number;
  vectors: number;
} {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    chunks: one("SELECT count(*) AS c FROM document_chunks"),
    fts: one("SELECT count(*) AS c FROM search_fts"),
    vectors: one("SELECT count(*) AS c FROM vec_chunks"),
  };
}
