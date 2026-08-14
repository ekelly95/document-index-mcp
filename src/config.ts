import path from "node:path";
import fs from "node:fs";
import { DEFAULT_INGEST_CONCURRENCY } from "./ingest/queue.js";

/**
 * Two tesseract.js workers by default. Each worker holds its own WASM heap
 * (150-300MB once a page is in flight), so this is a memory ceiling as much as
 * a throughput lever.
 */
export const DEFAULT_OCR_WORKERS = 2;

export interface ServerConfig {
  /** Jail root. Every addressable source file lives under this directory. */
  libraryRoot: string;
  /** Single SQLite file holding documents, chunks, FTS index and vectors. */
  dbPath: string;
  /** Where fastembed caches the ONNX model (~130MB, downloaded once). */
  modelCacheDir: string;
  /** Documents indexed at once, process-wide. See `ingest/queue.ts`. */
  ingestConcurrency: number;
  /** "auto" routes scanned PDFs through OCR; "off" restores the old refusal. */
  ocrMode: "auto" | "off";
  /** Tesseract language(s), e.g. "eng" or "deu+eng". */
  ocrLang: string;
  /** Concurrent OCR workers; pages in flight at once during a scan ingest. */
  ocrWorkers: number;
  /**
   * Directory holding the tesseract traineddata, instead of the jsDelivr CDN.
   * Absent means the CDN, which is the default: the first scanned page fetches
   * ~3MB and the worker caches it under `<models>/tesseract/` thereafter.
   */
  ocrLangPath?: string;
}

/**
 * Resolve configuration from flags or environment.
 *
 * As in obsidian-mcp, there is deliberately no fallback to process.cwd() for
 * the library root. A server that silently treats whatever directory it
 * happens to start in as the library is one misconfigured host away from
 * indexing an unrelated project.
 *
 * The database and model cache DO default, since both are derived artefacts
 * that are rebuildable and carry no risk if they land in the wrong place.
 */
export function loadConfig(argv: string[] = process.argv.slice(2)): ServerConfig {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    if (key) flags.set(key, value ?? "true");
  }

  const raw = flags.get("library") ?? process.env["DOCUMENT_INDEX_LIBRARY_PATH"];
  if (!raw) {
    throw new Error(
      "No library configured. Pass --library=<path> or set DOCUMENT_INDEX_LIBRARY_PATH.",
    );
  }

  const libraryRoot = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(libraryRoot);
  } catch {
    throw new Error(`Library path does not exist: ${libraryRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Library path is not a directory: ${libraryRoot}`);
  }

  const dbPath = path.resolve(
    flags.get("db") ??
      process.env["DOCUMENT_INDEX_DB_PATH"] ??
      path.join(libraryRoot, ".document-index", "document-index.db"),
  );
  const modelCacheDir = path.resolve(
    flags.get("models") ??
      process.env["DOCUMENT_INDEX_MODEL_CACHE"] ??
      path.join(libraryRoot, ".document-index", "models"),
  );

  const rawConcurrency =
    flags.get("ingest-concurrency") ?? process.env["DOCUMENT_INDEX_INGEST_CONCURRENCY"];
  // Number, not parseInt: parseInt("1.5") is 1 and parseInt("4nonsense") is 4,
  // so a typo would be silently coerced into a plausible-looking setting.
  const parsed = rawConcurrency === undefined ? NaN : Number(rawConcurrency);
  if (rawConcurrency !== undefined && (!Number.isInteger(parsed) || parsed < 1)) {
    throw new Error(
      `Invalid ingest concurrency ${JSON.stringify(rawConcurrency)}: expected an integer >= 1.`,
    );
  }
  const ingestConcurrency = Number.isInteger(parsed) ? parsed : DEFAULT_INGEST_CONCURRENCY;

  const rawOcr = flags.get("ocr") ?? process.env["DOCUMENT_INDEX_OCR"];
  if (rawOcr !== undefined && rawOcr !== "auto" && rawOcr !== "off") {
    throw new Error(
      `Invalid OCR mode ${JSON.stringify(rawOcr)}: expected "auto" or "off".`,
    );
  }
  const ocrMode = rawOcr ?? "auto";

  const rawLang = flags.get("ocr-lang") ?? process.env["DOCUMENT_INDEX_OCR_LANG"];
  // The language string becomes a traineddata filename and a download URL, so
  // it is validated as an identifier, not passed through as a path fragment.
  if (rawLang !== undefined && !/^[a-z0-9_]+(\+[a-z0-9_]+)*$/i.test(rawLang)) {
    throw new Error(
      `Invalid OCR language ${JSON.stringify(rawLang)}: expected codes like "eng" or "deu+eng".`,
    );
  }
  const ocrLang = rawLang ?? "eng";

  const rawWorkers = flags.get("ocr-workers") ?? process.env["DOCUMENT_INDEX_OCR_WORKERS"];
  const parsedWorkers = rawWorkers === undefined ? NaN : Number(rawWorkers);
  if (rawWorkers !== undefined && (!Number.isInteger(parsedWorkers) || parsedWorkers < 1)) {
    throw new Error(
      `Invalid OCR worker count ${JSON.stringify(rawWorkers)}: expected an integer >= 1.`,
    );
  }
  const ocrWorkers = Number.isInteger(parsedWorkers) ? parsedWorkers : DEFAULT_OCR_WORKERS;

  const rawLangPath =
    flags.get("ocr-lang-path") ?? process.env["DOCUMENT_INDEX_OCR_LANG_PATH"];
  let ocrLangPath: string | undefined;
  if (rawLangPath !== undefined) {
    // Not run through security/paths.ts. That jail wants a library-relative
    // path with a document extension; this is a directory deliberately outside
    // the library, supplied by whoever writes the host config — the same trust
    // level as --library and --models, neither of which is jailed either.
    //
    // It is checked eagerly all the same. The alternative is a worker rejecting
    // with ENOENT at the first scanned page, which can be many minutes into an
    // ingest, and reporting it as an OCR failure rather than a typo.
    ocrLangPath = path.resolve(rawLangPath);
    let langStat: fs.Stats;
    try {
      langStat = fs.statSync(ocrLangPath);
    } catch {
      throw new Error(`OCR language path does not exist: ${ocrLangPath}`);
    }
    if (!langStat.isDirectory()) {
      throw new Error(`OCR language path is not a directory: ${ocrLangPath}`);
    }
  }

  return {
    libraryRoot,
    dbPath,
    modelCacheDir,
    ingestConcurrency,
    ocrMode,
    ocrLang,
    ocrWorkers,
    ...(ocrLangPath ? { ocrLangPath } : {}),
  };
}
