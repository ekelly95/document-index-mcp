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
 * Documents indexed from this library path whose content no longer matches.
 *
 * Editing a file changes its sha256, so a re-ingest produces a SECOND document
 * at the same path while the old one keeps ranking. This is the query that
 * finds the stale one. `COLLATE NOCASE` because macOS APFS is case-insensitive
 * but `realpath` does not canonicalise case there, so two spellings of one
 * path can reach the database.
 */
export function findStaleAtPath(
  db: Db,
  sourcePath: string,
  keepSha256: string,
): DocumentRow[] {
  return db
    .prepare(
      "SELECT * FROM documents WHERE source_path = ? COLLATE NOCASE AND sha256 <> ?",
    )
    .all(sourcePath, keepSha256) as DocumentRow[];
}

/**
 * Reclaim an existing row for a fresh ingest attempt.
 *
 * The row is reused rather than replaced because sha256 is UNIQUE — the
 * previous attempt failed or was interrupted, and this clears every trace of
 * it. Setting `ingest_status = 'processing'` is what claims the document: see
 * the ownership rule in `src/ingest/runner.ts`.
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
 * How often a live ingest proves it is still alive, independent of progress.
 *
 * `setChunkCount` renews the lease as a side effect, but only per 64-chunk
 * batch — and a batch can legitimately take longer than the whole lease when
 * the work between chunks is slow, OCR being the motivating case. An expired
 * lease is not just cosmetic: `claimForIngest` would hand the document to a
 * second writer that deletes the first writer's chunks under it. One renewal
 * a minute keeps a live writer five times inside its five-minute lease.
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
 * Publish a finished index, and evict whatever it supersedes, atomically.
 *
 * `supersede` carries the documents that used to occupy this source path. They
 * are deleted HERE rather than when the ingest was claimed, and that ordering
 * is the whole point: an ingest that fails after the claim — a parser throwing
 * halfway through, the embedder dying, the disk filling, the process being
 * killed — must leave the previous version of the file still searchable. The
 * old behaviour deleted first and committed, so any of those failures left the
 * library with no copy of that path at all.
 *
 * Both halves go in one transaction, so a reader never observes the gap: either
 * the old version is live and the new one is still 'processing' (and therefore
 * invisible to search), or the new one is 'ready' and the old one is gone.
 * better-sqlite3 nests via SAVEPOINT, so deleteDocument's own transaction
 * composes correctly inside this one.
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
 * Abandon an ingest: drop whatever it wrote and record why, atomically.
 *
 * These were two separate statements, and the gap between them was a real
 * state: a crash after the chunks were deleted but before the status moved
 * left a document still claiming to be 'processing' with nothing in it —
 * indistinguishable from a live ingest that had not got going yet, and cleared
 * only when its lease eventually expired. One transaction removes the gap.
 */
export function failIngest(db: Db, id: string, message: string): void {
  db.transaction(() => {
    deleteChunksOf(db, id);
    failDocument(db, id, message);
  })();
}

/**
 * Delete a document and everything derived from it.
 *
 * document_chunks goes by FK cascade, and its AFTER DELETE trigger clears the
 * FTS index. vec_chunks is a virtual table: no foreign key reaches it, so its
 * rows must be deleted explicitly or the vector index silently accumulates
 * orphans that still answer KNN queries.
 */
export function deleteDocument(db: Db, id: string): void {
  db.transaction((docId: string) => {
    db.prepare("DELETE FROM vec_chunks WHERE document_id = ?").run(docId);
    db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
  })(id);
}

/**
 * How long an `ingest_status = 'processing'` row is believed without evidence.
 *
 * The row IS the ingest claim, and `setChunkCount` refreshes `updated_at`
 * after every 64-chunk batch — roughly every three seconds at the measured
 * 50ms/chunk — so a live writer keeps its lease renewed by orders of
 * magnitude. A row that has not moved in five minutes has no writer.
 *
 * This exists because `processing` on its own cannot distinguish "someone is
 * working on this" from "someone died working on this", and the two need
 * opposite responses: leave the first strictly alone, clear the second.
 *
 * It is the defence, not a backstop to one. `processLock.ts` was once described
 * here as making a second writer impossible; it never could, and it no longer
 * tries — a host that starts two processes per server, as Claude Desktop does,
 * makes concurrent writers ordinary. What holds is this lease plus the
 * `BEGIN IMMEDIATE` transaction in `claimForIngest`, both of which are atomic
 * across processes. Weakening either reopens the defect the lock was blamed for.
 */
export const INGEST_LEASE_MS = 5 * 60_000;

/** Has this claim been renewed recently enough to still be believed? */
export function ingestLeaseIsLive(row: DocumentRow, now = Date.now()): boolean {
  const updated = Date.parse(row.updated_at);
  if (Number.isNaN(updated)) return false;
  return now - updated < INGEST_LEASE_MS;
}

/**
 * Mark documents left mid-ingest by a crash or a host restart as failed.
 *
 * Called at startup, by the process holding the index lock and no other. A
 * 'processing' row whose writer is gone would otherwise advertise itself forever
 * as in progress, and its partial chunks would answer searches as though the
 * document were complete.
 *
 * Only expired leases are reclaimed. Clearing every `processing` row outright
 * would be correct only if this process were the sole writer, and it was
 * catastrophic when that assumption failed, because it deleted a live writer's
 * committed chunks in another process. The lease costs one comparison and
 * removes the whole class of failure — which is what makes it safe for peer
 * processes to share an index at all.
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
