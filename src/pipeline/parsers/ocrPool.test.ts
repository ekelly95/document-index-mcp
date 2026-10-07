import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  acquireOcrScheduler,
  disposeOcrPool,
  holdOcrPool,
  ocrPoolActive,
  setOcrPoolIdleMs,
  type OcrPoolConfig,
} from "./ocrPool.js";
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

test("a failed build is not cached, so a later scan can retry", async () => {
  await disposeOcrPool();
  const emptyLangDir = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-nolang-"));
  const retryCache = fs.mkdtempSync(path.join(os.tmpdir(), "document-index-mcp-ocr-retry-"));
  const cfg: OcrPoolConfig = { lang: "eng", workers: 1, cacheDir: retryCache, langPath: emptyLangDir };
  try {
    await assert.rejects(acquireOcrScheduler(cfg));
    assert.equal(ocrPoolActive(), false, "the rejected build stayed cached");

    // The language data turns up; the same configuration must now work.
    fs.copyFileSync(
      path.join(testLangPath(), "eng.traineddata.gz"),
      path.join(emptyLangDir, "eng.traineddata.gz"),
    );
    const scheduler = await acquireOcrScheduler(cfg);
    const result = await scheduler.addJob("recognize", renderScanJpeg(["Retry"]).jpeg, {}, { text: true });
    assert.match(result.data.text, /retry/i);
  } finally {
    await disposeOcrPool();
    fs.rmSync(emptyLangDir, { recursive: true, force: true });
    fs.rmSync(retryCache, { recursive: true, force: true });
  }
});

test("an unheld pool is disposed after the idle window, a held one is not", async () => {
  setOcrPoolIdleMs(30);
  try {
    const release = holdOcrPool();
    await acquireOcrScheduler(TEST_POOL);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ocrPoolActive(), true, "a held pool was disposed");

    release();
    release(); // idempotent
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ocrPoolActive(), false, "an idle pool was kept");
  } finally {
    setOcrPoolIdleMs(5 * 60_000);
    await disposeOcrPool();
  }
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
