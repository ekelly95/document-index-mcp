import type { Format, LocatorType } from "../pipeline/ir.js";
import type { Db } from "./sqlite.js";

export type IngestStatus = "pending" | "processing" | "ready" | "failed";

export interface DocumentRow {
  id: string;
  title: string;
  source_path: string;
  format: Format;
  sha256: string;
  engine_used: string;
  locator_scheme: LocatorType;
  locator_count: number;
  chunk_count: number;
  embedding_model: string | null;
  outline_json: string;
  ingest_status: IngestStatus;
  error_message: string | null;
  ingest_warning: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewDocument {
  id: string;
  title: string;
  sourcePath: string;
  format: Format;
  sha256: string;
  engineUsed: string;
  locatorScheme: LocatorType;
  locatorCount: number;
  embeddingModel: string;
  ingestWarning: string | null;
}

const now = () => new Date().toISOString();

export function insertDocument(db: Db, doc: NewDocument): void {
  db.prepare(
    `INSERT INTO documents (
       id, title, source_path, format, sha256, engine_used, locator_scheme,
       locator_count, chunk_count, embedding_model, outline_json,
       ingest_status, ingest_warning, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', 'processing', ?, ?, ?)`,
  ).run(
    doc.id,
    doc.title,
    doc.sourcePath,
    doc.format,
    doc.sha256,
    doc.engineUsed,
    doc.locatorScheme,
    doc.locatorCount,
    doc.embeddingModel,
    doc.ingestWarning,
    now(),
    now(),
  );
}

export function findBySha256(db: Db, sha256: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE sha256 = ?").get(sha256) as
    | DocumentRow
    | undefined;
}

export function getDocument(db: Db, id: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
    | DocumentRow
    | undefined;
}

/**
 * Other documents at this library path, i.e. earlier versions of an edited
 * file. Case-insensitive only where the filesystem is (macOS `realpath` does
 * not canonicalise case); on Linux `Notes.md` and `notes.md` are two files.
 */
export function findStaleAtPath(
  db: Db,
  sourcePath: string,
  keepSha256: string,
  caseInsensitive = process.platform === "win32" || process.platform === "darwin",
): DocumentRow[] {
  return db
    .prepare(
      `SELECT * FROM documents WHERE source_path = ? ${caseInsensitive ? "COLLATE NOCASE" : ""} AND sha256 <> ?`,
    )
    .all(sourcePath, keepSha256) as DocumentRow[];
}

/**
 * Reclaim a failed or interrupted document's row for a fresh attempt (sha256
 * is UNIQUE). Setting 'processing' is the claim; see `beginIngest`.
 */
export function restartIngest(
  db: Db,
  id: string,
  fields: {
    title: string;
    sourcePath: string;
    format: Format;
    engineUsed: string;
    locatorScheme: LocatorType;
    locatorCount: number;
    embeddingModel: string;
    ingestWarning: string | null;
  },
): void {
  db.prepare(
    `UPDATE documents
        SET ingest_status = 'processing', error_message = NULL,
            title = ?, source_path = ?, format = ?, engine_used = ?,
            locator_scheme = ?, locator_count = ?, embedding_model = ?,
            ingest_warning = ?,
            chunk_count = 0, outline_json = '[]', updated_at = ?
      WHERE id = ?`,
  ).run(
    fields.title,
    fields.sourcePath,
    fields.format,
    fields.engineUsed,
    fields.locatorScheme,
    fields.locatorCount,
    fields.embeddingModel,
    fields.ingestWarning,
    now(),
    id,
  );
}

/**
 * Move a ready document to a new library path without touching its content.
 *
 * A file that was renamed or copied has the same sha256, so it is the same
 * document; only where it lives changed. Re-indexing identical bytes would be
 * pure waste, and `sha256 UNIQUE` forbids a second copy anyway.
 */
export function setSourcePath(db: Db, id: string, sourcePath: string): void {
  db.prepare(
    "UPDATE documents SET source_path = ?, updated_at = ? WHERE id = ?",
  ).run(sourcePath, now(), id);
}

/** Documents currently being indexed. Their chunks are deliberately unsearchable. */
export function listProcessing(db: Db): DocumentRow[] {
  return db
    .prepare("SELECT * FROM documents WHERE ingest_status = 'processing' ORDER BY updated_at")
    .all() as DocumentRow[];
}

export function listDocuments(db: Db): DocumentRow[] {
  return db
    .prepare("SELECT * FROM documents ORDER BY created_at DESC")
    .all() as DocumentRow[];
}

/** Ingest progress: chunk_count against locator_count is the whole mechanism. */
export function setChunkCount(db: Db, id: string, count: number): void {
  db.prepare(
    "UPDATE documents SET chunk_count = ?, updated_at = ? WHERE id = ?",
  ).run(count, now(), id);
}

/**
 * How often a live ingest renews its lease regardless of progress. A batch of
 * OCR pages can outlast the whole lease, and an expired lease lets a second
 * writer take the document over.
 */
export const LEASE_RENEW_INTERVAL_MS = 60_000;

/**
 * Renew the ingest lease without recording progress.
 *
 * Guarded on `ingest_status = 'processing'` so a timer that fires after the
 * ingest finalized or failed touches nothing — a lease can only be renewed
 * while the claim it protects still exists.
 */
export function renewLease(db: Db, id: string): void {
  db.prepare(
    "UPDATE documents SET updated_at = ? WHERE id = ? AND ingest_status = 'processing'",
  ).run(now(), id);
}

/**
 * Publish a finished index and evict the versions it supersedes, in one
 * transaction: before it commits the old version answers searches and the new
 * one is invisible; after, only the new one exists. Eviction happens here, not
 * at claim time, so a failed ingest never costs the previous version.
 */
export function finalizeDocument(
  db: Db,
  id: string,
  fields: { chunkCount: number; locatorCount: number; outlineJson: string },
  supersede: readonly string[] = [],
): void {
  db.transaction(() => {
    for (const staleId of supersede) deleteDocument(db, staleId);
    db.prepare(
      `UPDATE documents
          SET chunk_count = ?, locator_count = ?, outline_json = ?,
              ingest_status = 'ready', error_message = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(fields.chunkCount, fields.locatorCount, fields.outlineJson, now(), id);
  })();
}

export function failDocument(db: Db, id: string, message: string): void {
  db.prepare(
    "UPDATE documents SET ingest_status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
  ).run(message, now(), id);
}

/**
 * Abandon an ingest: drop its chunks and record why, in one transaction, so a
 * crash between the two cannot leave an empty 'processing' row behind.
 */
export function failIngest(db: Db, id: string, message: string): void {
  db.transaction(() => {
    deleteChunksOf(db, id);
    failDocument(db, id, message);
  })();
}

/**
 * Delete a document and everything derived from it. Chunks and FTS go by
 * cascade and trigger; vec_chunks is a virtual table no cascade reaches, so its
 * rows are deleted explicitly or they keep answering KNN queries.
 */
export function deleteDocument(db: Db, id: string): void {
  db.transaction((docId: string) => {
    db.prepare("DELETE FROM vec_chunks WHERE document_id = ?").run(docId);
    db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
  })(id);
}

/**
 * How long a 'processing' row is believed without being renewed. A live
 * writer renews every batch and every minute; five quiet minutes means its
 * process is gone. This lease plus the BEGIN IMMEDIATE claim is what lets
 * several processes (Claude Desktop starts two) share one index safely.
 */
export const INGEST_LEASE_MS = 5 * 60_000;

/** Has this claim been renewed recently enough to still be believed? */
export function ingestLeaseIsLive(row: DocumentRow, now = Date.now()): boolean {
  const updated = Date.parse(row.updated_at);
  if (Number.isNaN(updated)) return false;
  return now - updated < INGEST_LEASE_MS;
}

/**
 * Mark ingests abandoned by a crash as failed, so their partial chunks never
 * answer searches and the file can be ingested again. Only expired leases are
 * reclaimed: clearing every 'processing' row once deleted a live writer's work
 * in another process.
 */
export function recoverInterrupted(db: Db, now = Date.now()): number {
  const rows = db
    .prepare("SELECT * FROM documents WHERE ingest_status = 'processing'")
    .all() as DocumentRow[];
  const abandoned = rows.filter((row) => !ingestLeaseIsLive(row, now));
  for (const { id } of abandoned) {
    failIngest(db, id, "Ingest was interrupted before it completed. Re-ingest to retry.");
  }
  return abandoned.length;
}

/** Drop a document's chunks and vectors, keeping the document row itself. */
export function deleteChunksOf(db: Db, documentId: string): void {
  db.transaction((id: string) => {
    db.prepare("DELETE FROM vec_chunks WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    db.prepare("UPDATE documents SET chunk_count = 0, updated_at = ? WHERE id = ?").run(now(), id);
  })(documentId);
}
