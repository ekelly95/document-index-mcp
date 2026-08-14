#!/usr/bin/env node
/**
 * Print candidate passages for writing evaluation questions against.
 *
 *   node scripts/eval-sample.mjs --db=<corpus>/.document-index/document-index.db --per-doc=6
 *
 * Writing a relevance question means finding a passage that genuinely answers
 * something, then phrasing the question in words the passage does not use. That
 * needs the real indexed text in front of you — not the source file, because
 * what retrieval sees is what the parser produced, and the two differ in
 * exactly the places worth testing.
 *
 * Chunks are spread evenly through each document by sequence rather than taken
 * from the front, because the opening of a book is title pages and the opening
 * of a paper is its abstract, and a question set drawn only from those measures
 * nothing about finding a passage buried on page 300.
 */

import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function flag(name, fallback = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const dbPath = flag("db");
if (!dbPath) {
  process.stderr.write("Pass --db=<path to document-index.db>\n");
  process.exit(1);
}
const perDoc = Number(flag("per-doc", "6"));
const minChars = Number(flag("min-chars", "300"));
const only = flag("only");

const db = new Database(path.resolve(dbPath), { readonly: false, fileMustExist: true });

const docs = db
  .prepare(
    `SELECT id, title, source_path, format, chunk_count
       FROM documents
      WHERE ingest_status = 'ready' AND chunk_count > 0
      ORDER BY source_path`,
  )
  .all();

for (const doc of docs) {
  if (only && !doc.source_path.includes(only)) continue;

  // Long enough to contain a claim worth asking about. A 40-character chunk is
  // usually a heading or a stray caption, and a question whose answer is a
  // heading tests the outline, not retrieval.
  const rows = db
    .prepare(
      `SELECT seq, kind, locator_type, locator_value, printed_label, section_path, text
         FROM document_chunks
        WHERE document_id = ? AND length(text) >= ?
        ORDER BY seq`,
    )
    .all(doc.id, minChars);

  if (rows.length === 0) {
    process.stdout.write(`\n### ${doc.source_path} — no chunk over ${minChars} chars\n`);
    continue;
  }

  process.stdout.write(
    `\n\n${"=".repeat(78)}\n### ${doc.source_path}  (${doc.format}, ${doc.chunk_count} chunks)\n${"=".repeat(78)}\n`,
  );

  const step = Math.max(1, Math.floor(rows.length / perDoc));
  for (let i = 0; i < rows.length && i / step < perDoc; i += step) {
    const r = rows[i];
    const where =
      r.printed_label && r.printed_label !== r.locator_value
        ? `${r.locator_type} ${r.locator_value} (printed ${r.printed_label})`
        : `${r.locator_type} ${r.locator_value}`;
    const trail = JSON.parse(r.section_path).join(" > ") || "(no section path)";
    process.stdout.write(`\n--- seq ${r.seq} | ${where} | kind ${r.kind}\n`);
    process.stdout.write(`    ${trail}\n`);
    process.stdout.write(`${r.text.slice(0, 700).replace(/^/gm, "    ")}\n`);
  }
}

// Tables are rare — a few percent of a corpus — so an even sweep misses them,
// and they are the case the release plan singles out as a hybrid weakness
// (synonyms like "SSO" against "single sign-on").
const tables = db
  .prepare(
    `SELECT d.source_path, c.seq, c.locator_type, c.locator_value, c.text
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.kind = 'table' AND length(c.text) >= 120
      ORDER BY RANDOM() LIMIT 8`,
  )
  .all();

if (tables.length > 0) {
  process.stdout.write(`\n\n${"=".repeat(78)}\n### TABLES\n${"=".repeat(78)}\n`);
  for (const t of tables) {
    process.stdout.write(`\n--- ${t.source_path} | seq ${t.seq} | ${t.locator_type} ${t.locator_value}\n`);
    process.stdout.write(`${t.text.slice(0, 700).replace(/^/gm, "    ")}\n`);
  }
}

db.close();
