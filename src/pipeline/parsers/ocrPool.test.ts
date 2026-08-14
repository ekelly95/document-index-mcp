import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { acquireOcrScheduler, disposeOcrPool, type OcrPoolConfig } from "./ocrPool.js";
import { renderScanJpeg } from "../../testing/scanImage.js";
import { testLangPath } from "../../testing/tessdata.js";

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-ocr-"));

const TEST_POOL: OcrPoolConfig = {
  lang: "eng",
  workers: 1,
  cacheDir,
  langPath: testLangPath(),
};

after(async () => {
  await disposeOcrPool();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("the pool recognises drawn text, offline", async () => {
  const scheduler = await acquireOcrScheduler(TEST_POOL);
  const image = renderScanJpeg(["The quick brown fox"]);
  const result = await scheduler.addJob("recognize", image.jpeg, {}, { text: true, blocks: true });
  assert.match(result.data.text, /quick/i);
  assert.match(result.data.text, /brown/i);
  assert.ok(
    fs.existsSync(path.join(cacheDir, "tesseract", "eng.traineddata")),
    "traineddata was not cached under the model cache directory",
  );
});

test("a second acquire under the same configuration reuses the pool", async () => {
  const first = acquireOcrScheduler(TEST_POOL);
  const second = acquireOcrScheduler(TEST_POOL);
  assert.equal(first, second, "identical configs built two pools");
});

test("dispose then re-acquire builds a working pool again", async () => {
  await disposeOcrPool();
  await disposeOcrPool(); // idempotent
  const scheduler = await acquireOcrScheduler(TEST_POOL);
  const image = renderScanJpeg(["Lantern"]);
  const result = await scheduler.addJob("recognize", image.jpeg, {}, { text: true });
  assert.match(result.data.text, /lantern/i);
});

test("a language directory holding plain, ungzipped traineddata works", async () => {
  // The bundled @tesseract.js-data package ships `eng.traineddata.gz`, but
  // everything under tesseract-ocr/tessdata_fast — which is what a user
  // following the docs actually downloads — is plain. tesseract.js does not
  // sniff: `gzip` decides the filename it asks for, so getting this wrong
  // means ENOENT at the first scanned page for the commoner of the two layouts.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-plain-"));
  const gz = path.join(testLangPath(), "eng.traineddata.gz");
  fs.writeFileSync(
    path.join(plainDir, "eng.traineddata"),
    zlib.gunzipSync(fs.readFileSync(gz)),
  );

  const plainCache = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-ocr-plain-"));
  try {
    const scheduler = await acquireOcrScheduler({
      lang: "eng",
      workers: 1,
      cacheDir: plainCache,
      langPath: plainDir,
    });
    const image = renderScanJpeg(["Ungzipped"]);
    const result = await scheduler.addJob("recognize", image.jpeg, {}, { text: true });
    assert.match(result.data.text, /ungzipped/i);
  } finally {
    // Leave the pool holding the shared TEST_POOL config, so the tests above
    // stay independent of the order this one runs in.
    await disposeOcrPool();
    fs.rmSync(plainDir, { recursive: true, force: true });
    fs.rmSync(plainCache, { recursive: true, force: true });
  }
});
