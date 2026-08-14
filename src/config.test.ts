import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_FILE_MB, DEFAULT_OCR_WORKERS, loadConfig } from "./config.js";

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

test("the file-size ceiling defaults, and takes a flag or an env var in megabytes", () => {
  const lib = tempLibrary();
  assert.equal(loadConfig([`--library=${lib}`]).maxFileBytes, DEFAULT_MAX_FILE_MB * 1_000_000);
  assert.equal(loadConfig([`--library=${lib}`, "--max-file-mb=64"]).maxFileBytes, 64_000_000);

  process.env["DOCUMENT_INDEX_MAX_FILE_MB"] = "32";
  try {
    assert.equal(loadConfig([`--library=${lib}`]).maxFileBytes, 32_000_000);
    assert.equal(
      loadConfig([`--library=${lib}`, "--max-file-mb=8"]).maxFileBytes,
      8_000_000,
      "the flag should win over the environment",
    );
  } finally {
    delete process.env["DOCUMENT_INDEX_MAX_FILE_MB"];
  }
});

test("a fractional or sub-one file-size ceiling is refused", () => {
  const lib = tempLibrary();
  for (const bad of ["0", "1.5", "64mb", "-1"]) {
    assert.throws(
      () => loadConfig([`--library=${lib}`, `--max-file-mb=${bad}`]),
      /Invalid max file size/,
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

test("the OCR language path is absent by default, and resolved when set", () => {
  const lib = tempLibrary();
  assert.equal(loadConfig([`--library=${lib}`]).ocrLangPath, undefined);

  const langDir = tempLibrary();
  const config = loadConfig([`--library=${lib}`, `--ocr-lang-path=${langDir}`]);
  assert.equal(config.ocrLangPath, path.resolve(langDir));
});

test("the OCR language path honours the env var, and the flag wins over it", () => {
  const lib = tempLibrary();
  const fromEnvDir = tempLibrary();
  const fromFlagDir = tempLibrary();
  process.env["DOCUMENT_INDEX_OCR_LANG_PATH"] = fromEnvDir;
  try {
    assert.equal(
      loadConfig([`--library=${lib}`]).ocrLangPath,
      path.resolve(fromEnvDir),
    );
    assert.equal(
      loadConfig([`--library=${lib}`, `--ocr-lang-path=${fromFlagDir}`]).ocrLangPath,
      path.resolve(fromFlagDir),
    );
  } finally {
    delete process.env["DOCUMENT_INDEX_OCR_LANG_PATH"];
  }
});

test("an OCR language path that is missing or not a directory is refused", () => {
  const lib = tempLibrary();
  // Checked here rather than left to the worker: the failure would otherwise
  // surface as an OCR error at the first scanned page, possibly many minutes
  // into an ingest, and look like a tesseract problem instead of a typo.
  assert.throws(
    () => loadConfig([`--library=${lib}`, `--ocr-lang-path=${path.join(lib, "nope")}`]),
    /OCR language path does not exist/,
  );

  const file = path.join(lib, "eng.traineddata");
  fs.writeFileSync(file, "not a directory");
  assert.throws(
    () => loadConfig([`--library=${lib}`, `--ocr-lang-path=${file}`]),
    /OCR language path is not a directory/,
  );
});
