import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

/** What this build requires of an index it is asked to open. */
export interface IndexExpectations {
  embeddingModel: string;
  embeddingDim: number;
}

export class IncompatibleIndexError extends Error {
  override readonly name = "IncompatibleIndexError";
}

/**
 * Open (creating if needed) the single document-index.db, and refuse it if it was not
 * built by this build.
 *
 * WAL is set before the schema is applied so readers never block the ingest
 * writer. Read tools are then lock-free.
 *
 * `expected` is passed in rather than imported so that `db/` does not depend on
 * `embeddings/`; the constants live next to the model that defines them, and
 * pulling fastembed into the database module to read two strings would invert
 * the layering.
 */
export function openDatabase(dbPath: string, expected: IndexExpectations): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Pragmas must run outside a transaction, hence not in SCHEMA_SQL.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // NORMAL is the right durability trade for a rebuildable local index: it
  // survives process crashes, and only a host power-loss mid-write could lose
  // the tail of an ingest that can simply be re-run.
  db.pragma("synchronous = NORMAL");

  sqliteVec.load(db);

  db.exec(SCHEMA_SQL);

  try {
    assertCompatible(db, dbPath, expected);
  } catch (err) {
    // Leaving the handle open would hold a WAL lock on a file the caller has
    // just been told to delete.
    db.close();
    throw err;
  }

  return db;
}

/**
 * Make good on what the `meta` table's comment has always promised.
 *
 * The schema says a model change "has to be detectable rather than silently
 * mixed into one index", but until now nothing wrote the model and nothing
 * read the schema version back. Two 384-dimension models produce vectors that
 * are the same shape and mean entirely different things, so mixing them
 * degrades every search with no error and no symptom beyond worse answers.
 *
 * Refusing is the right failure: nothing here is unrecoverable — the index
 * rebuilds from the library — and refusing leaves the file intact for the user
 * to inspect, where an automatic rebuild would silently spend two hours.
 */
function assertCompatible(db: Db, dbPath: string, expected: IndexExpectations): void {
  const version = getMeta(db, "schema_version");
  if (version !== null && version !== String(SCHEMA_VERSION)) {
    throw new IncompatibleIndexError(
      `The index at ${dbPath} is schema version ${version}; this build expects ` +
        `${SCHEMA_VERSION}. There is no migration path yet — delete that file ` +
        `(along with its -wal and -shm siblings) and re-ingest the library.`,
    );
  }
  setMeta(db, "schema_version", String(SCHEMA_VERSION));

  // An index written before this check existed has no model recorded in meta,
  // but every document row carries the model it was embedded with. Adopt that
  // rather than assuming the current one is what built the vectors — assuming
  // is exactly the silent mixing this function exists to prevent.
  const fromDocuments = documentModels(db);
  if (fromDocuments.length > 1) {
    throw new IncompatibleIndexError(
      `The index at ${dbPath} already holds vectors from more than one embedding model ` +
        `(${fromDocuments.join(", ")}), which this build cannot have produced. Those vectors ` +
        `are not comparable with each other. Delete that file and re-ingest.`,
    );
  }
  const recorded = getMeta(db, "embedding_model") ?? fromDocuments[0] ?? null;

  if (recorded !== null && recorded !== expected.embeddingModel) {
    throw new IncompatibleIndexError(
      `The index at ${dbPath} was built with embedding model "${recorded}", but this ` +
        `build uses "${expected.embeddingModel}". Vectors from different models are not ` +
        `comparable, so mixing them would quietly degrade every search. Delete that file ` +
        `and re-ingest, or point --db at a different one.`,
    );
  }

  const dim = getMeta(db, "embedding_dim");
  if (dim !== null && dim !== String(expected.embeddingDim)) {
    throw new IncompatibleIndexError(
      `The index at ${dbPath} holds ${dim}-dimension vectors; this build produces ` +
        `${expected.embeddingDim}. Delete that file and re-ingest.`,
    );
  }

  setMeta(db, "embedding_model", expected.embeddingModel);
  setMeta(db, "embedding_dim", String(expected.embeddingDim));
}

/** Every distinct embedding model recorded against a document. Usually one, often none. */
function documentModels(db: Db): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT embedding_model AS model FROM documents WHERE embedding_model IS NOT NULL ORDER BY model",
    )
    .all() as { model: string }[];
  return rows.map((r) => r.model);
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Pack an embedding for sqlite-vec.
 *
 * vec0 wants the raw little-endian float32 bytes. Float32Array's buffer is
 * already that on every platform Node supports.
 */
export function packVector(v: readonly number[] | Float32Array): Buffer {
  const f32 = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * vec0 requires a genuine SQLite INTEGER primary key. better-sqlite3 binds
 * plain JS numbers as REAL, which vec0 rejects with "Only integers are allows
 * for primary key values" — so every rowid crossing into vec_chunks must be a
 * BigInt. Measured against better-sqlite3 13.0.3 / sqlite-vec 0.1.9.
 */
export function vecRowid(id: number): bigint {
  return BigInt(id);
}
