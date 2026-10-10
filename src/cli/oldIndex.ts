import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * What `pnpm reindex` takes from the index it replaces, kept apart from the
 * CLI's entry point so it can be tested without a model or `process.exit`.
 */

export interface OldDocument {
  title: string;
  source_path: string;
}

/** Titles and paths from any version of the index, opened read-only. */
export function readOldIndex(file: string): { version: string; documents: OldDocument[] } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const version =
      (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)
        ?.value ?? "unknown";
    // One row per path, preferring the finished version of a file.
    const documents = db
      .prepare(
        `SELECT title, source_path FROM documents
          ORDER BY source_path, CASE ingest_status WHEN 'ready' THEN 0 ELSE 1 END`,
      )
      .all() as OldDocument[];
    const seen = new Set<string>();
    return { version, documents: documents.filter((d) => !seen.has(d.source_path) && seen.add(d.source_path)) };
  } finally {
    db.close();
  }
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
