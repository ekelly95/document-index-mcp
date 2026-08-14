/**
 * The DDL, inlined rather than kept in schema.sql.
 *
 * tsc does not copy .sql files into dist/, so a separate file would need
 * either a build step or runtime path resolution that differs between `pnpm
 * start` and `node dist/index.js`. A template string has neither problem.
 *
 * Deviations from the source spec are marked DEVIATION and explained where
 * they occur.
 */

// v2: engine_used admits 'ts-ocr' (in-process tesseract.js OCR for scanned
// PDFs). There is no migration scaffolding; an old database is refused by
// `assertCompatible` with instructions to delete and re-ingest.
// v3: the EPUB locator scheme is renamed 'chapter' -> 'part' (a spine file is
// not necessarily a book chapter, and the old name overclaimed), and documents
// gains ingest_warning for decks indexed with known-missing content. The
// rename changes CHECK constraints, which SQLite cannot ALTER in place, so v2
// is refused rather than upgraded — same pattern as v1.
// v4: vec_chunks gains chunk_size=64. vec0 allocates storage a block at a time
// and the table is partitioned per document, so at the default 1024 every
// document cost 1.5MB of vector storage whether it held three chunks or a
// thousand. Measured on a real 71-document library: 106MB of a 113MB index was
// empty padding around 1.5MB of actual vectors. An existing index cannot adopt
// a new chunk_size in place, so v3 is refused rather than upgraded.
//
// NOT a version bump: the EPUB and PPTX readers were removed, so no row can
// carry format 'epub'/'pptx' or locator scheme 'part'/'slide' again. The CHECK
// constraints below still admit them, and are deliberately left alone. They are
// now a superset of what is reachable, which is harmless — while tightening
// them would change the schema text, and there is no ALTER for a CHECK, so
// every existing index would be refused and re-ingested from scratch. Paying an
// OCR re-run to narrow a constraint nothing can violate is not a trade worth
// making. Tighten them the next time a real bump happens anyway.
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
-- ---------- meta ----------
-- Schema version and the embedding model the vectors were built with.
-- Vectors from different models are not comparable, so a model change has to
-- be detectable rather than silently mixed into one index.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- 1) documents ----------
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,                 -- ULID
  title           TEXT NOT NULL,
  source_path     TEXT NOT NULL,                    -- library-relative; display + re-ingest
  format          TEXT NOT NULL
                    CHECK (format IN ('pdf','epub','docx','pptx','md','html','txt')),
  sha256          TEXT NOT NULL UNIQUE,             -- idempotent re-ingest / dedupe
  engine_used     TEXT NOT NULL DEFAULT 'ts-fast'
                    CHECK (engine_used IN ('ts-fast','ts-ocr','docling','docling-ocr')),
  locator_scheme  TEXT NOT NULL
                    CHECK (locator_scheme IN ('page','part','slide','section')),
  locator_count   INTEGER NOT NULL DEFAULT 0,       -- pages / sections
  chunk_count     INTEGER NOT NULL DEFAULT 0,       -- also serves as ingest progress
  embedding_model TEXT,                             -- e.g. 'fast-bge-small-en-v1.5'
  outline_json    TEXT NOT NULL DEFAULT '[]',
  ingest_status   TEXT NOT NULL DEFAULT 'pending'
                    CHECK (ingest_status IN ('pending','processing','ready','failed')),
  error_message   TEXT,
  ingest_warning  TEXT,                             -- set at ingest when a parser knows it skipped real content; survives markReady. No parser sets it today (see ir.ts)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ---------- 2) document_chunks ----------
-- The retrieval + citation unit. \`id\` is the rowid alias linking FTS5 and vec0.
--
-- DEVIATION: the spec's char_start / char_end are dropped. They were defined
-- as offsets into "the locator's markdown", but the spec also makes blocks
-- transient pipeline IR that is never persisted — so the string those offsets
-- index into cannot be reconstructed from the database, making them
-- unverifiable and unusable. (document_id, locator, seq) is the citation unit.
CREATE TABLE IF NOT EXISTS document_chunks (
  id              INTEGER PRIMARY KEY,              -- rowid alias (FTS content_rowid, vec key)
  chunk_id        TEXT NOT NULL UNIQUE,             -- ULID, the external handle
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,                 -- global reading order, 0-based
  kind            TEXT NOT NULL DEFAULT 'text'
                    CHECK (kind IN ('text','table','code','list','heading')),
  locator_type    TEXT NOT NULL
                    CHECK (locator_type IN ('page','part','slide','section')),
  locator_value   TEXT NOT NULL,                    -- "41", "sec-2"
  locator_ordinal INTEGER NOT NULL,
  page_number     INTEGER,                          -- denormalized (pdf), else NULL
  printed_label   TEXT,                             -- "xii", "342" (pdf)
  section_path    TEXT NOT NULL DEFAULT '[]',       -- JSON heading trail
  bbox            TEXT,                             -- JSON "[x,y,w,h]" normalized 0..1, or NULL
  text            TEXT NOT NULL,                    -- clean GFM (no section-path prefix)
  token_count     INTEGER NOT NULL,
  UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_seq  ON document_chunks(document_id, seq);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_page ON document_chunks(document_id, page_number);
CREATE INDEX IF NOT EXISTS idx_chunks_kind     ON document_chunks(kind);

-- ---------- 3) search_fts ----------
-- External-content FTS5 over chunk text; BM25 via bm25(); kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text,
  content='document_chunks',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON document_chunks BEGIN
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON document_chunks BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON document_chunks BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ---------- 4) vector index (sqlite-vec) ----------
-- 384-dim bge-small-en-v1.5, keyed to document_chunks.id, partitioned per
-- document so a single-document search pre-filters instead of scanning.
--
-- NOTE: vec0 is a virtual table and is NOT reached by the ON DELETE CASCADE
-- above. Deleting a document must delete its vec rows explicitly.
-- NOTE: chunk_rowid must be bound as a JS BigInt. better-sqlite3 binds plain
-- numbers as SQLite REAL and vec0 rejects a non-INTEGER primary key with
-- "Only integers are allows for primary key values".
--
-- NOTE: chunk_size is not a tuning nicety, it is the difference between an
-- index that scales with your content and one that scales with your file
-- count. vec0 stores vectors in fixed blocks of chunk_size rows, and a
-- PARTITION KEY gives every distinct value its own blocks. At the default 1024
-- that is 1024 x 384 x 4 = 1,572,864 bytes per document, allocated whole, even
-- for a one-paragraph note. A library of 71 mostly-small Markdown files came to
-- 113MB holding 1.48MB of vectors; the same library at chunk_size=64 costs
-- 96KB a document instead of 1.5MB.
--
-- 64 rather than 8: a block is also the unit a KNN scan walks, and most
-- documents here are papers and transcripts that fit inside one. A 400-page
-- book needs seven blocks and wastes under 15% of them, which is the right
-- trade at the large end. Must be divisible by 8 — vec0 refuses otherwise.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_rowid  INTEGER PRIMARY KEY,
  document_id  TEXT PARTITION KEY,
  embedding    float[384],
  chunk_size=64
);
`;
