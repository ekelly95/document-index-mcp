#!/usr/bin/env node
/**
 * Check a stress-test corpus against corpus/manifest.json.
 *
 * The corpus is 175MB of binaries and is deliberately not in git, so the
 * manifest is the only thing standing between a disk failure and every
 * measurement in docs/roadmap.md becoming unreproducible. This verifies that
 * the folder in front of you is the one those findings were measured against.
 *
 *   node scripts/corpus.mjs verify --dir=<corpus>/docs
 *   node scripts/corpus.mjs verify --dir=<corpus>/decks --set=decks
 *   node scripts/corpus.mjs list --set=decks
 *
 * Two sets, because they are measured against different things. `documents`
 * are ingested directly and test the parsers. `decks` are formats no parser
 * reads: they test scripts/convert-for-ingest.ps1, and what is checked is what
 * survives the round trip into PDF and a notes file.
 *
 * Exits non-zero if anything is missing or altered, so it can gate a run.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "..", "corpus", "manifest.json");

function readManifest() {
  if (!fs.existsSync(manifestPath)) {
    fail(`No manifest at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  // Streamed rather than readFileSync: pml-book-frontmatter.pdf is 88MB and
  // scanned-book.pdf is 18MB, and there is no reason to hold either in memory.
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function flag(name, fallback = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** The manifest list a command is working on: `documents` (default) or `decks`. */
function setOf(manifest) {
  const name = flag("set", "documents");
  const entries = manifest[name];
  if (!Array.isArray(entries)) {
    fail(`No "${name}" list in the manifest. Known: ${Object.keys(manifest).filter((k) => Array.isArray(manifest[k])).join(", ")}`);
  }
  return entries;
}

async function verify(manifest) {
  const entries = setOf(manifest);
  const dir = flag("dir");
  if (!dir) fail("Pass --dir=<path to the corpus folder for this set>");
  if (!fs.existsSync(dir)) fail(`No such directory: ${dir}`);

  let missing = 0;
  let altered = 0;
  let ok = 0;

  for (const doc of entries) {
    const file = path.join(dir, doc.file);
    if (!fs.existsSync(file)) {
      process.stdout.write(`MISSING  ${doc.file}\n`);
      if (doc.url) process.stdout.write(`         re-download: ${doc.url}\n`);
      else process.stdout.write(`         source: ${doc.source} (${doc.url_note ?? "no URL recorded"})\n`);
      missing += 1;
      continue;
    }
    const size = fs.statSync(file).size;
    const digest = await sha256(file);
    if (digest === doc.sha256) {
      ok += 1;
      continue;
    }
    // Size is reported alongside because a truncated download and a different
    // edition are both digest mismatches, and they need different responses.
    process.stdout.write(`ALTERED  ${doc.file}\n`);
    process.stdout.write(`         expected ${doc.sha256} (${doc.bytes} bytes)\n`);
    process.stdout.write(`         found    ${digest} (${size} bytes)\n`);
    altered += 1;
  }

  const extras = fs
    .readdirSync(dir)
    .filter((f) => !entries.some((d) => d.file === f));
  for (const extra of extras) process.stdout.write(`UNLISTED ${extra}\n`);

  process.stdout.write(
    `\n${ok}/${entries.length} verified` +
      (missing ? `, ${missing} missing` : "") +
      (altered ? `, ${altered} altered` : "") +
      (extras.length ? `, ${extras.length} unlisted` : "") +
      "\n",
  );
  process.exit(missing + altered > 0 ? 1 : 0);
}

function list(manifest) {
  for (const doc of setOf(manifest)) {
    process.stdout.write(`${doc.file}\n`);
    process.stdout.write(`  ${doc.source}\n`);
    process.stdout.write(`  ${doc.url ?? `(no URL recorded — ${doc.url_note ?? "verify by sha256"})`}\n`);
    process.stdout.write(`  tests: ${doc.tests}\n\n`);
  }
}

const command = process.argv[2];
const manifest = readManifest();
if (command === "verify") await verify(manifest);
else if (command === "list") list(manifest);
else fail("Usage: node scripts/corpus.mjs verify --dir=<path> | list");
