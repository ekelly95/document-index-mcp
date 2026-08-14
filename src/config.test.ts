import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_OCR_WORKERS, loadConfig } from "./config.js";

function tempLibrary(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-config-"));
}

test("OCR defaults: auto, English, the documented worker count", () => {
  const config = loadConfig([`--library=${tempLibrary()}`]);
  assert.equal(config.ocrMode, "auto");
  assert.equal(config.ocrLang, "eng");
  assert.equal(config.ocrWorkers, DEFAULT_OCR_WORKERS);
});

test("the renamed environment and derived paths are the defaults", () => {
  const lib = tempLibrary();
  process.env["DOCUMENT_INDEX_LIBRARY_PATH"] = lib;
  try {
    const config = loadConfig([]);
    assert.equal(config.libraryRoot, path.resolve(lib));
    assert.equal(
      config.dbPath,
      path.resolve(lib, ".document-index", "document-index.db"),
    );
    assert.equal(config.modelCacheDir, path.resolve(lib, ".document-index", "models"));
  } finally {
    delete process.env["DOCUMENT_INDEX_LIBRARY_PATH"];
  }
});

test("OCR flags are honoured", () => {
  const config = loadConfig([
    `--library=${tempLibrary()}`,
    "--ocr=off",
    "--ocr-lang=deu+eng",
    "--ocr-workers=4",
  ]);
  assert.equal(config.ocrMode, "off");
  assert.equal(config.ocrLang, "deu+eng");
  assert.equal(config.ocrWorkers, 4);
});

test("OCR env vars are honoured, and flags win over them", () => {
  const lib = tempLibrary();
  process.env["DOCUMENT_INDEX_OCR"] = "off";
  process.env["DOCUMENT_INDEX_OCR_LANG"] = "fra";
  process.env["DOCUMENT_INDEX_OCR_WORKERS"] = "3";
  try {
    const fromEnv = loadConfig([`--library=${lib}`]);
    assert.equal(fromEnv.ocrMode, "off");
    assert.equal(fromEnv.ocrLang, "fra");
    assert.equal(fromEnv.ocrWorkers, 3);

    const fromFlag = loadConfig([`--library=${lib}`, "--ocr=auto"]);
    assert.equal(fromFlag.ocrMode, "auto");
  } finally {
    delete process.env["DOCUMENT_INDEX_OCR"];
    delete process.env["DOCUMENT_INDEX_OCR_LANG"];
    delete process.env["DOCUMENT_INDEX_OCR_WORKERS"];
  }
});

test("a mistyped OCR mode is refused, not coerced", () => {
  const lib = tempLibrary();
  for (const bad of ["on", "true", "AUTO", ""]) {
    assert.throws(
      () => loadConfig([`--library=${lib}`, `--ocr=${bad}`]),
      /Invalid OCR mode/,
    );
  }
});

test("an OCR language that is not a plain code is refused", () => {
  const lib = tempLibrary();
  // The language string becomes a traineddata filename and a download URL, so
  // separators and traversal must never survive validation.
  for (const bad of ["../eng", "eng deu", "eng/", "eng+", "+eng", ""]) {
    assert.throws(
      () => loadConfig([`--library=${lib}`, `--ocr-lang=${bad}`]),
      /Invalid OCR language/,
    );
  }
});

test("a fractional or sub-one OCR worker count is refused", () => {
  const lib = tempLibrary();
  for (const bad of ["0", "1.5", "2workers", "-1"]) {
    assert.throws(
      () => loadConfig([`--library=${lib}`, `--ocr-workers=${bad}`]),
      /Invalid OCR worker count/,
    );
  }
});
