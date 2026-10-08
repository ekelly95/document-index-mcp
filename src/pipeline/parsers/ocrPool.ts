import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type Tesseract from "tesseract.js";
import { describeError, log } from "../../log.js";

/**
 * The process-wide tesseract.js worker pool.
 *
 * One pool rather than one per document, because each worker is a
 * worker_thread with its own WASM heap (150-300MB with a page in flight) and a
 * multi-second spawn. It is shared while scans are being read and torn down
 * once nothing has held it for `idleMs`, so one scanned PDF does not pin
 * hundreds of megabytes for the rest of a long-lived server's life. A new
 * configuration key (only tests produce one) disposes the old pool.
 *
 * tesseract.js is imported dynamically so a server that never meets a scan
 * never loads it.
 */

/**
 * Resolution scans are rasterised at before recognition. 300 DPI is the
 * classic OCR sweet spot: below ~200 accuracy falls off, above ~400 costs
 * memory and time for nothing. Also stamped into tesseract as
 * `user_defined_dpi`, which silences its "Invalid resolution 0 dpi" guess
 * and feeds its segmentation the truth.
 */
export const OCR_RENDER_DPI = 300;

export interface OcrPoolConfig {
  /** Tesseract language string, e.g. "eng" or "deu+eng". */
  lang: string;
  /** Worker threads in the pool; pages recognised concurrently. */
  workers: number;
  /** Model cache root; traineddata lives in a `tesseract/` subdirectory. */
  cacheDir: string;
  /**
   * Local directory holding the traineddata, instead of the jsDelivr CDN. Set
   * by `--ocr-lang-path`; tests point it at the bundled @tesseract.js-data/eng
   * package so they never touch the network. See `stageLanguageData`.
   */
  langPath?: string;
}

export type OcrScheduler = Tesseract.Scheduler;

let pool: { key: string; promise: Promise<OcrScheduler> } | null = null;

/** How long an unheld pool survives. Five minutes covers a batch of scans. */
let idleMs = 5 * 60_000;
let holders = 0;
let idleTimer: NodeJS.Timeout | null = null;

// NUL written as an escape, never a literal byte: see docs/gotchas.md. Neither
// a lang code nor a path can contain one, so two configurations never collide.
const poolKey = (cfg: OcrPoolConfig): string =>
  [cfg.lang, cfg.cacheDir, cfg.workers, cfg.langPath ?? ""].join("\u0000");

/**
 * The scheduler for this configuration, built at most once.
 *
 * The promise is memoised so concurrent callers share one build. A build that
 * fails is forgotten, so the next scan retries instead of rethrowing the first
 * failure (an offline language-data download, say) until the server restarts.
 */
export function acquireOcrScheduler(cfg: OcrPoolConfig): Promise<OcrScheduler> {
  const key = poolKey(cfg);
  if (pool?.key !== key) {
    const stale = pool;
    const entry = {
      key,
      promise: (async () => {
        if (stale) await terminate(stale.promise);
        return buildScheduler(cfg);
      })(),
    };
    entry.promise.catch(() => {
      if (pool === entry) pool = null;
    });
    pool = entry;
  }
  return pool.promise;
}

/**
 * Keep the pool alive while one document is being read. Returns the release;
 * the idle countdown starts when the last holder lets go.
 */
export function holdOcrPool(): () => void {
  holders++;
  clearIdleTimer();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0 && pool) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (holders === 0) void disposeOcrPool();
      }, idleMs);
      idleTimer.unref();
    }
  };
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/** Test seam: shorten the idle window. */
export function setOcrPoolIdleMs(ms: number): void {
  idleMs = ms;
}

/** Whether a pool is built or being built. For tests and diagnostics. */
export function ocrPoolActive(): boolean {
  return pool !== null;
}

/** Tear the pool down. Idempotent; safe to call with no pool built. */
export async function disposeOcrPool(): Promise<void> {
  clearIdleTimer();
  const current = pool;
  pool = null;
  if (current) await terminate(current.promise);
}

async function terminate(promise: Promise<OcrScheduler>): Promise<void> {
  try {
    const scheduler = await promise;
    await scheduler.terminate();
  } catch {
    // A pool that failed to build has nothing to terminate.
  }
}

async function buildScheduler(cfg: OcrPoolConfig): Promise<OcrScheduler> {
  const { createScheduler, createWorker, OEM, PSM } = (await import("tesseract.js")).default;

  const cachePath = path.join(cfg.cacheDir, "tesseract");
  fs.mkdirSync(cachePath, { recursive: true });

  // Staged here, before any worker exists, because tesseract.js 7 cannot report
  // a failed language load: with an errorHandler set, createWorker never
  // settles. A scan ingested offline, or with a mistyped --ocr-lang, used to
  // hang forever with its lease renewed, blocking every ingest queued behind it.
  // Workers then only ever read the cache.
  await stageLanguageData(cfg, cachePath);

  const options: Partial<Tesseract.WorkerOptions> = {
    cachePath,
    // stdout belongs to JSON-RPC; stderr does not need a line per step either.
    logger: () => {},
    errorHandler: (err: unknown) => log.warn(`tesseract worker: ${describeError(err)}`),
  };

  const settled = await Promise.allSettled(
    Array.from({ length: cfg.workers }, async () => {
      const worker = await createWorker(cfg.lang, OEM.LSTM_ONLY, options);
      await worker.setParameters({
        // Full-page auto-segmentation. The tesseract.js default is
        // SINGLE_BLOCK, which reads a whole page as one paragraph.
        tessedit_pageseg_mode: PSM.AUTO,
        user_defined_dpi: String(OCR_RENDER_DPI),
      });
      return worker;
    }),
  );

  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    await Promise.all(
      settled
        .filter((r): r is PromiseFulfilledResult<Tesseract.Worker> => r.status === "fulfilled")
        .map((r) => r.value.terminate().catch(() => {})),
    );
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error(`OCR worker failed to start: ${describeError(failed.reason)}`);
  }

  const scheduler = createScheduler();
  for (const r of settled) {
    scheduler.addWorker((r as PromiseFulfilledResult<Tesseract.Worker>).value);
  }
  return scheduler;
}

/** Where tesseract.js itself fetches LSTM-only data from. */
const LANG_CDN = "https://cdn.jsdelivr.net/npm/@tesseract.js-data";
const LANG_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Put `<code>.traineddata` (decompressed) in the worker cache for every
 * language, from --ocr-lang-path or the CDN, or throw a message a person can
 * act on. Either file form is accepted from a local directory: the npm data
 * packages ship `.gz`, tessdata_fast/tessdata_best ship plain.
 */
export async function stageLanguageData(cfg: OcrPoolConfig, cachePath: string): Promise<void> {
  for (const code of cfg.lang.split("+")) {
    const target = path.join(cachePath, `${code}.traineddata`);
    if (fs.existsSync(target)) continue;

    let data: Uint8Array;
    if (cfg.langPath) {
      const found = [`${code}.traineddata`, `${code}.traineddata.gz`]
        .map((name) => path.join(cfg.langPath!, name))
        .find((file) => fs.existsSync(file));
      if (!found) {
        throw new Error(
          `OCR language data for "${code}" is not in the --ocr-lang-path directory ` +
            `(looked for ${code}.traineddata and ${code}.traineddata.gz).`,
        );
      }
      data = fs.readFileSync(found);
    } else {
      const url = `${LANG_CDN}/${code}/4.0.0_best_int/${code}.traineddata.gz`;
      let resp: Response;
      try {
        resp = await fetch(url, { signal: AbortSignal.timeout(LANG_DOWNLOAD_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(
          `Could not download OCR language data for "${code}" (${describeError(err)}). ` +
            `Check the connection, or pass --ocr-lang-path.`,
        );
      }
      if (!resp.ok) {
        throw new Error(
          `Could not download OCR language data for "${code}": HTTP ${resp.status}` +
            (resp.status === 404 ? `. Is "${code}" a Tesseract language code?` : "."),
        );
      }
      data = new Uint8Array(await resp.arrayBuffer());
    }

    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    const partial = `${target}.part`;
    fs.writeFileSync(partial, data);
    fs.renameSync(partial, target);
  }
}
