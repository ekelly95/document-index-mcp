import { createHash } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { SupersededChunkRow, SupersededDocumentRow } from "../db/documentsRepo.js";

/**
 * What `pnpm reindex` takes from the index it replaces, kept apart from the
 * CLI's entry point so it can be tested without a model or `process.exit`.
 */

export interface OldDocument {
  title: string;
  source_path: string;
  /** The document_id the rebuild should keep. Absent from indexes too old to say. */
  id?: string;
}

/** Titles and paths from any version of the index, opened read-only. */
export function readOldIndex(file: string): { version: string; documents: OldDocument[] } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const version =
      (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)
        ?.value ?? "unknown";
    // One row per path, preferring the finished version of a file.
    const hasId = columnsOf(db, "documents").has("id");
    const documents = db
      .prepare(
        `SELECT ${hasId ? "id, " : ""}title, source_path FROM documents
          ORDER BY source_path, CASE ingest_status WHEN 'ready' THEN 0 ELSE 1 END`,
      )
      .all() as OldDocument[];
    const seen = new Set<string>();
    return { version, documents: documents.filter((d) => !seen.has(d.source_path) && seen.add(d.source_path)) };
  } finally {
    db.close();
  }
}

/** A chunk an agent could have cited from the old index. */
export interface OldChunk {
  chunk_id: string;
  document_id: string;
  seq: number;
  locator_type: string;
  locator_value: string;
  page_number: number | null;
  printed_label: string | null;
  /** sha256 of the chunk text, so an identical rebuilt chunk can keep its id. */
  text_hash: string;
}

export interface OldCitations {
  /** Chunks of ready documents, the only ones search ever returned. */
  chunks: OldChunk[];
  /** Tombstones the old index already held (v6+), carried across. */
  supersededDocuments: SupersededDocumentRow[];
  supersededChunks: SupersededChunkRow[];
}

export function hashChunkText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Every id the old index could have handed out, so the rebuild can keep the
 * ones that still mean the same thing and leave tombstones for the rest.
 * Empty for an index too old or too partial to have them.
 */
export function readOldCitations(file: string): OldCitations {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    const chunks: OldChunk[] = [];
    if (tables.has("document_chunks") && columnsOf(db, "documents").has("id")) {
      const rows = db
        .prepare(
          `SELECT c.chunk_id, c.document_id, c.seq, c.locator_type, c.locator_value,
                  c.page_number, c.printed_label, c.text
             FROM document_chunks c JOIN documents d ON d.id = c.document_id
            WHERE d.ingest_status = 'ready'`,
        )
        .iterate() as Iterable<Omit<OldChunk, "text_hash"> & { text: string }>;
      for (const { text, ...rest } of rows) chunks.push({ ...rest, text_hash: hashChunkText(text) });
    }
    return {
      chunks,
      supersededDocuments: tables.has("superseded_documents")
        ? (db.prepare("SELECT * FROM superseded_documents").all() as SupersededDocumentRow[])
        : [],
      supersededChunks: tables.has("superseded_chunks")
        ? (db.prepare("SELECT * FROM superseded_chunks").all() as SupersededChunkRow[])
        : [],
    };
  } finally {
    db.close();
  }
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

/** Rename the index and its -wal/-shm out of the way, never over an earlier backup. */
export function moveAside(dbPath: string, version: string, now = Date.now()): string {
  let target = `${dbPath}.v${version}.bak`;
  if (fs.existsSync(target)) target = `${dbPath}.v${version}.${now}.bak`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, target + suffix);
  }
  return target;
}

/**
 * The tombstones a rebuild leaves behind, as a pure function of what the old
 * index held and what the rebuild did, so it can be tested without a model.
 *
 * `rebuilt` maps each old document_id to the id its path was rebuilt under, or
 * null when its rebuild failed. `reused` holds the old chunk_ids the rebuild
 * kept; every other old chunk_id gets a tombstone.
 */
export function tombstonesAfterRebuild(
  old: OldCitations,
  documents: readonly OldDocument[],
  rebuilt: ReadonlyMap<string, string | null>,
  reused: ReadonlySet<string>,
  at: string,
): { documents: SupersededDocumentRow[]; chunks: SupersededChunkRow[] } {
  const successor = (id: string | null): string | null =>
    id === null ? null : rebuilt.has(id) ? rebuilt.get(id)! : id;

  const chunks: SupersededChunkRow[] = old.supersededChunks.map((c) => ({
    ...c,
    replaced_by: successor(c.replaced_by),
  }));
  for (const c of old.chunks) {
    if (reused.has(c.chunk_id)) continue;
    chunks.push({
      chunk_id: c.chunk_id,
      document_id: c.document_id,
      seq: c.seq,
      locator_type: c.locator_type as SupersededChunkRow["locator_type"],
      locator_value: c.locator_value,
      page_number: c.page_number,
      printed_label: c.printed_label,
      replaced_by: rebuilt.get(c.document_id) ?? null,
      reason: "reindexed",
      superseded_at: at,
    });
  }

  const docs: SupersededDocumentRow[] = old.supersededDocuments.map((d) => ({
    ...d,
    replaced_by: successor(d.replaced_by),
  }));
  for (const d of documents) {
    if (d.id === undefined) continue;
    const now = rebuilt.get(d.id) ?? null;
    // Kept its id: still live, nothing to explain.
    if (now === d.id) continue;
    docs.push({
      id: d.id,
      title: d.title,
      source_path: d.source_path,
      replaced_by: now,
      reason: "reindexed",
      superseded_at: at,
    });
  }
  return { documents: docs, chunks };
}
