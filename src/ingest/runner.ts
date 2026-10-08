import { createHash } from "node:crypto";
import path from "node:path";
import { ulid } from "ulid";
import type { AppContext } from "../context.js";
import {
  deleteChunksOf,
  deleteDocument,
  failIngest,
  finalizeDocument,
  findBySha256,
  findStaleAtPath,
  ingestLeaseIsLive,
  insertDocument,
  LEASE_RENEW_INTERVAL_MS,
  renewLease,
  restartIngest,
  setChunkCount,
  setSourcePath,
  type DocumentRow,
} from "../db/documentsRepo.js";
import { insertChunks, type InsertableChunk } from "../db/chunksRepo.js";
import { EMBEDDING_MODEL_NAME } from "../embeddings/embedder.js";
import { chunkBlocks, fitToBudget, type DraftChunk } from "../pipeline/chunker.js";
import { OutlineBuilder } from "../pipeline/outline.js";
import { markReferences } from "../pipeline/references.js";
import { routeDocument, type Route } from "../pipeline/router.js";
import { UnsupportedFormatError } from "../pipeline/ir.js";
import type { DocumentMetadata, DocumentSource, Format } from "../pipeline/ir.js";
import { openSource } from "../pipeline/source.js";
import { assertRealPathInside, libraryRelative, safeResolve } from "../security/paths.js";
import { withDocumentLock } from "../security/locks.js";
import { log, describeError } from "../log.js";

/** Chunks embedded and written per transaction. */
const BATCH_SIZE = 64;

/**
 * Indexing runs in flight, so shutdown can drain them instead of discarding
 * committed work (Ctrl-C used to throw away 90% of a 900-page book).
 */
const inFlight = new Set<Promise<void>>();

/** True once shutdown has begun; new ingests are refused from that point. */
let draining = false;

export class ShuttingDownError extends Error {
  override readonly name = "ShuttingDownError";
}

/**
 * Stop accepting ingests and wait for the running ones, up to `timeoutMs`.
 * Returns how many were still unfinished; their unrenewed leases are reclaimed
 * at the next start.
 */
export async function drainIngests(timeoutMs = 10_000): Promise<number> {
  draining = true;
  if (inFlight.size === 0) return 0;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    // Never hold the event loop open purely to time out a wait.
    timer.unref?.();
  });
  try {
    // allSettled, not all: a failing ingest has already recorded itself, and
    // one rejection must not abandon the wait for the others.
    await Promise.race([Promise.allSettled([...inFlight]), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return inFlight.size;
}

/** Test seam: undo `drainIngests` so a later test can ingest again. */
export function resumeIngests(): void {
  draining = false;
}

/** Ingests currently running. Exposed for shutdown reporting and tests. */
export function activeIngests(): number {
  return inFlight.size;
}

/**
 * What a call to `beginIngest` actually did.
 *
 * The distinction matters because only "started" makes this caller the writer.
 * The other two mean somebody else owns the document — already finished, or
 * still going — and this call did no work.
 */
export type IngestOutcome = "started" | "reused" | "joined";

export interface IngestHandle {
  documentId: string;
  title: string;
  format: Format;
  locatorCount: number;
  /** From the parser, when it knows it skipped real content. See ir.ts. */
  warning: string | null;
  outcome: IngestOutcome;
  /**
   * Resolves when THIS call's indexing finishes.
   *
   * Already resolved for "reused" and "joined", where this call is not the
   * writer. Poll get_document_outline for the other writer's progress.
   */
  done: Promise<void>;
}

/**
 * The document's identity, hashed from the same buffer every later stage
 * reads, so the sha256 can never describe a different revision than the chunks.
 */
function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Prepare an ingest and start it. Everything up to the `documents` row write is
 * awaited, so the caller gets a real document_id; parse, chunk, embed and insert
 * run behind the returned `done`. Progress is chunk_count against locator_count,
 * which get_document_outline reports.
 *
 * OWNERSHIP: `ingest_status = 'processing'` is the lock — if it is processing,
 * it is not yours. The claim is one synchronous better-sqlite3 transaction
 * (`claimForIngest`), so check-then-write cannot interleave. Doing it outside
 * that transaction once let a second ingest of the same file delete a finished
 * index (docs/gotchas.md).
 *
 * SUPERSEDING: an edited file is a new document (new sha). The version it
 * replaces is evicted by `finalizeDocument` in the transaction that publishes the
 * replacement, never at claim time, so a failed ingest leaves the old version
 * searchable. Meanwhile the path legally holds two rows: old 'ready', new
 * 'processing'.
 */
export async function beginIngest(
  ctx: AppContext,
  relPath: string,
  opts: { title?: string } = {},
): Promise<IngestHandle> {
  if (draining) {
    throw new ShuttingDownError(
      "document-index-mcp is shutting down and is not accepting new documents. Re-ingest after it restarts.",
    );
  }

  const requested = safeResolve(ctx.config.libraryRoot, relPath);
  // The canonical on-disk path, so `Methods.md` and `methods.md` are one file
  // on Windows rather than two documents that supersede nothing.
  const absPath = await assertRealPathInside(ctx.config.libraryRoot, requested);
  const sourcePath = libraryRelative(ctx.config.libraryRoot, absPath);

  // Read once. Everything after this point — the hash, the format sniff, the
  // PDF probe, the metadata pass and the parse — works from this one buffer
  // and, for a PDF, from one pdfjs document built out of it. Closed when the
  // ingest ends, on every path out of this function.
  const src = await openSource(absPath, ctx.config.maxFileBytes);
  let handedOff = false;
  try {
    const sha256 = sha256Of(src.bytes);

    // Advisory only — `claimForIngest` re-reads and is the authority. This
    // exists so an already-known file does not pay for routing and metadata,
    // which for a PDF means parsing the document, just to be told there is
    // nothing to do. Skipped when the path differs, because that case has a
    // row to update and the transaction is where writes belong.
    const known = findBySha256(ctx.db, sha256);
    if (known && known.source_path === sourcePath) {
      if (known.ingest_status === "ready") return settled(known, "reused");
      if (known.ingest_status === "processing" && ingestLeaseIsLive(known)) {
        return settled(known, "joined");
      }
    }

    const route = await routeDocument(src, {
      ocr: {
        mode: ctx.config.ocrMode,
        lang: ctx.config.ocrLang,
        workers: ctx.config.ocrWorkers,
        cacheDir: ctx.config.modelCacheDir,
        ...(ctx.config.ocrLangPath ? { langPath: ctx.config.ocrLangPath } : {}),
      },
    });
    const meta = await route.parser.metadata(src);
    // `??` alone let an empty string through — a `# ` line, a `title: ""`
    // frontmatter, or a caller passing "" all produced nameless documents in
    // the library listing. Whitespace-only is as absent as absent.
    const present = (t: string | undefined): string | undefined =>
      t !== undefined && t.trim().length > 0 ? t.trim() : undefined;
    const title =
      present(opts.title) ?? present(meta.title) ?? path.basename(absPath, path.extname(absPath));

    const { claim, supersede } = claimForIngest(ctx, {
      sha256,
      sourcePath,
      title,
      route,
      meta,
    });
    if (claim.outcome !== "started") return { ...claim, done: Promise.resolve() };

    const documentId = claim.documentId;
    const done = indexInBackground(ctx, documentId, claim.title, src, route, meta, supersede);
    // From here the background work owns the source and closes it; this
    // function's own cleanup must not.
    handedOff = true;

    // Registered so shutdown can wait for it. The stored promise swallows the
    // rejection — the caller's `done` still rejects, and the runner has
    // already logged and recorded the cause — because an unhandled rejection
    // on this second reference would take the process down.
    const tracked = done.catch(() => {});
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));

    return { ...claim, done };
  } finally {
    if (!handedOff) await src.close();
  }
}

/**
 * Run the indexing behind the handle's `done` promise, and close the source
 * when it settles either way.
 */
function indexInBackground(
  ctx: AppContext,
  documentId: string,
  /** The resolved title, as stored on the row — not meta.title, which may be absent or a placeholder. */
  title: string,
  src: DocumentSource,
  route: Route,
  meta: DocumentMetadata,
  supersede: readonly string[],
): Promise<void> {
  // The queue, not the document lock, is what bounds cost here: the lock only
  // stops two writers for the SAME document, and the expensive resources —
  // CPU, the one ONNX model, the single SQLite writer — are shared across all
  // of them. Acquired inside, so the claim has already committed and the
  // caller already has its document_id; only the work waits.
  return withDocumentLock(documentId, () =>
    ctx.queue.run(async () => {
      // The mutex is a backstop, not the mechanism: the 'processing' claim above
      // already guarantees a single writer, so this is never contended in
      // practice. It stays because it costs nothing uncontended and it keeps
      // "one writer per document" true structurally, even if a future change
      // slips an await into the claim path and quietly voids the argument.
      const started = Date.now();
      log.info(
        `indexing ${route.format} ${src.absPath} [${documentId}]` +
          (supersede.length > 0 ? `, superseding ${supersede.join(", ")}` : ""),
      );
      try {
        const chunks = await indexDocument(ctx, documentId, title, src, route, meta, supersede);
        log.info(
          `indexed ${chunks} chunk(s) in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
            `[${documentId}]` +
            (supersede.length > 0
              ? `; deleted ${supersede.length} superseded version(s)`
              : ""),
        );
      } catch (err: unknown) {
        // Inside the claim, so nothing else can be writing this row. Logged as well
        // as recorded: after a fire-and-forget ingest nobody polls error_message.
        log.error(`indexing failed for ${src.absPath} [${documentId}]: ${describeError(err)}`);
        try {
          failIngest(ctx.db, documentId, describeError(err));
        } catch (cleanupErr: unknown) {
          // The database is the thing that failed. Nothing further to do but
          // say so, rather than leave a half-cleaned document unexplained.
          log.error(`cleanup for [${documentId}] also failed: ${describeError(cleanupErr)}`);
        }
        throw err;
      } finally {
        // Releases the file buffer and tears down the pdfjs document, whether
        // the ingest finished or threw.
        await src.close();
      }
    }),
  );
}

type Claim = Omit<IngestHandle, "done">;

interface ClaimResult {
  claim: Claim;
  /**
   * Documents at this source path that this ingest replaces. Evicted by
   * `finalizeDocument`, not here, so a failure in between keeps the old version.
   */
  supersede: string[];
}

function settled(row: DocumentRow, outcome: IngestOutcome): IngestHandle {
  return {
    documentId: row.id,
    title: row.title,
    format: row.format,
    locatorCount: row.locator_count,
    warning: row.ingest_warning,
    outcome,
    done: Promise.resolve(),
  };
}

/**
 * Decide what this ingest is allowed to do, and claim the document if it may.
 *
 * One synchronous transaction. Nothing here awaits, so nothing can interleave
 * — this is the atomic check-then-write the ownership rule depends on.
 */
function claimForIngest(
  ctx: AppContext,
  input: {
    sha256: string;
    sourcePath: string;
    title: string;
    route: Route;
    meta: DocumentMetadata;
  },
): ClaimResult {
  const { sha256, sourcePath, title, route, meta } = input;

  return ctx.db.transaction((): ClaimResult => {
    const existing = findBySha256(ctx.db, sha256);

    if (existing?.ingest_status === "processing" && ingestLeaseIsLive(existing)) {
      // Somebody else owns this; touch nothing. The lease check is what stops a row
      // abandoned by a crash from making every future ingest of the file join an
      // ingest that will never progress.
      return { claim: claimOf(existing, "joined"), supersede: [] };
    }

    // One library path holds one document: an edited file's previous version
    // goes. Checked before the reuse branch, which could otherwise move an
    // already-indexed document onto this path without evicting its occupant.
    const stale = findStaleAtPath(ctx.db, sourcePath, sha256);
    for (const s of stale) {
      // Scanned first, so the throw below cannot leave a half-applied eviction
      // behind. With eviction deferred to finalisation, "one ready plus one
      // processing" is now the legal steady state for a path mid-replacement —
      // but a THIRD version arriving while that is in flight has no safe
      // answer, because it cannot know which of the two it supersedes.
      if (s.ingest_status === "processing" && ingestLeaseIsLive(s)) {
        throw new Error(
          `Another version of ${sourcePath} is still indexing (document ${s.id}). ` +
            `Wait for it to finish — get_document_outline reports its progress — then re-ingest.`,
        );
      }
    }
    const staleIds = stale.map((s) => s.id);

    if (existing?.ingest_status === "ready") {
      // Identical bytes are the same document wherever they live; a renamed or
      // copied file only needs its path updated. Evicted eagerly here because nothing
      // is indexed, so there is no later failure to survive. deleteDocument, not a
      // raw DELETE: no cascade reaches the vec0 table.
      for (const id of staleIds) deleteDocument(ctx.db, id);
      if (existing.source_path !== sourcePath) {
        setSourcePath(ctx.db, existing.id, sourcePath);
      }
      return { claim: claimOf(existing, "reused"), supersede: [] };
    }

    const fields = {
      title,
      sourcePath,
      format: route.format,
      engineUsed: route.engine,
      locatorScheme: meta.locatorScheme,
      locatorCount: meta.locatorCount,
      embeddingModel: EMBEDDING_MODEL_NAME,
      ingestWarning: meta.warning ?? null,
    };

    if (existing) {
      // A previous attempt failed or was interrupted. Reuse the row — sha256
      // is UNIQUE — and clear whatever partial state it left behind.
      deleteChunksOf(ctx.db, existing.id);
      restartIngest(ctx.db, existing.id, fields);
      return {
        claim: {
          documentId: existing.id,
          title,
          format: route.format,
          locatorCount: meta.locatorCount,
          warning: meta.warning ?? null,
          outcome: "started",
        },
        supersede: staleIds,
      };
    }

    const documentId = ulid();
    insertDocument(ctx.db, { id: documentId, sha256, ...fields });
    return {
      claim: {
        documentId,
        title,
        format: route.format,
        locatorCount: meta.locatorCount,
        warning: meta.warning ?? null,
        outcome: "started",
      },
      supersede: staleIds,
    };
  }).immediate();
}

function claimOf(row: DocumentRow, outcome: IngestOutcome): Claim {
  return {
    documentId: row.id,
    title: row.title,
    format: row.format,
    locatorCount: row.locator_count,
    warning: row.ingest_warning,
    outcome,
  };
}

async function indexDocument(
  ctx: AppContext,
  documentId: string,
  title: string,
  src: DocumentSource,
  route: Route,
  meta: DocumentMetadata,
  supersede: readonly string[],
): Promise<number> {
  const outline = new OutlineBuilder();
  const locators = new Set<string>();

  let seq = 0;
  let batch: DraftChunk[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    // The title rides along with every chunk of the document, so a query that
    // names its source has something to match. It is embedded only, never
    // stored on the chunk.
    const vectors = await ctx.embedder.embedPassages(
      batch.map((chunk) => ({ ...chunk, documentTitle: title })),
    );

    const rows: InsertableChunk[] = batch.map((chunk, i) => ({
      chunkId: ulid(),
      seq: seq - batch.length + i,
      kind: chunk.kind,
      locator: chunk.locator,
      pageNumber: chunk.locator.type === "page" ? chunk.locator.ordinal + 1 : null,
      sectionPath: chunk.sectionPath,
      bbox: chunk.bbox,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      embedding: vectors[i]!,
    }));

    insertChunks(ctx.db, documentId, rows);
    setChunkCount(ctx.db, documentId, seq);
    batch = [];
  };

  // Timer-based renewal, because batch-based renewal is not enough: a parser
  // that is slow between chunks (OCR spends seconds per page) can go longer
  // than the whole lease without reaching `setChunkCount`. The callback only
  // ever runs between awaits, so it can never land inside a transaction.
  const lease = setInterval(() => renewLease(ctx.db, documentId), LEASE_RENEW_INTERVAL_MS);
  lease.unref();
  try {
    const drafts = chunkBlocks(route.parser.parse(src), { scheme: meta.locatorScheme });
    const fitted = fitToBudget(drafts, (text) => ctx.embedder.countTokens(text));
    for await (const chunk of markReferences(fitted)) {
      outline.add(seq, chunk.sectionPath, chunk.locator);
      locators.add(chunk.locator.value);
      batch.push(chunk);
      seq++;
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
  } finally {
    clearInterval(lease);
  }

  // A document that produced nothing must not be published as complete: a
  // search finding nothing would be indistinguishable from an uncovered topic.
  // Thrown, so the error path marks it 'failed' with this message.
  if (seq === 0) {
    throw new UnsupportedFormatError(
      "The file produced no indexable content — it is empty, or holds only material this parser does not read.",
    );
  }

  finalizeDocument(
    ctx.db,
    documentId,
    {
      chunkCount: seq,
      // The larger of the two, because they measure different things and each
      // is right about something. The parser's count is the document's true
      // extent — a PDF has 400 pages whether or not every one carries text —
      // and a blank or image-only page produces no chunk, so `locators.size`
      // alone would report a shorter book than exists and could talk a caller
      // into a page_range that stops before the end. `locators.size` covers
      // the other direction, where a parser could not know the count ahead.
      locatorCount: Math.max(meta.locatorCount, locators.size),
      outlineJson: JSON.stringify(outline.build()),
    },
    // Only here, in the same transaction that flips this document to 'ready',
    // do the versions it replaces go. Everything above this line can fail.
    supersede,
  );

  return seq;
}
