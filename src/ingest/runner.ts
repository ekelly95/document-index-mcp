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
import { chunkBlocks, type DraftChunk } from "../pipeline/chunker.js";
import { OutlineBuilder } from "../pipeline/outline.js";
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
 * Indexing runs currently in flight, so shutdown can wait for them.
 *
 * Nothing tracked these, and the signal handler called `process.exit(0)`
 * immediately: Ctrl-C ninety percent of the way through a 900-page book threw
 * away all of it, because the next startup found a 'processing' row and
 * cleared it. Draining keeps what has already been committed and lets
 * finalisation happen if it is close.
 */
const inFlight = new Set<Promise<void>>();

/** True once shutdown has begun; new ingests are refused from that point. */
let draining = false;

export class ShuttingDownError extends Error {
  override readonly name = "ShuttingDownError";
}

/**
 * Stop accepting ingests and wait for the ones already running.
 *
 * Returns how many were still unfinished when `timeoutMs` ran out. Those keep
 * their 'processing' row with its lease unrenewed, so the next startup's
 * recovery reclaims them; the alternative — waiting indefinitely on a
 * half-embedded 900-page book — is worse for a host that is trying to quit.
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
 * The document's identity, taken over the bytes that will actually be indexed.
 *
 * Previously this streamed the file in its own pass, before the sniff, the
 * probe, the metadata read and the parse each opened it again. The hash
 * therefore described a revision that nothing downstream necessarily saw: edit
 * the file during the seconds between, and the stored sha256 belonged to one
 * version while the chunks belonged to another. Hashing the one buffer every
 * later stage reads closes that by construction rather than by timing.
 */
function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Prepare an ingest and start it.
 *
 * Everything up to and including the `documents` row write is awaited, so the
 * caller always gets a real document_id and an honest locator count. The
 * indexing itself — parse, chunk, embed, insert — runs behind the returned
 * `done` promise.
 *
 * This is what replaces the source spec's async Tasks extension. Progress is
 * observable through documents.chunk_count against locator_count, which
 * get_document_outline already reports, so no protocol extension and no task
 * store is needed.
 *
 * ---
 *
 * OWNERSHIP, which is the whole reason this function has the shape it does.
 *
 * `ingest_status = 'processing'` IS the lock. A row in that state has exactly
 * one writer, and every other caller must leave it strictly alone. The claim
 * is made in `claimForIngest` below, inside a single better-sqlite3
 * transaction — and because better-sqlite3 is synchronous, that transaction
 * cannot interleave with anything at all: there is no await inside it for the
 * event loop to switch on. Check-then-write is therefore atomic by
 * construction, not by convention.
 *
 * An earlier version of this function did the check-then-write OUTSIDE the
 * lock and held the lock only around indexing, which let a second caller
 * observe a live ingest, call deleteChunksOf on it, re-index from seq 0, hit
 * UNIQUE(document_id, seq), throw, and have its own error handler delete the
 * first caller's finished index and mark the document failed. Two concurrent
 * ingests of one file could destroy a good index. The rule that fixes it is
 * the one stated above: if it is 'processing', it is not yours.
 *
 * ---
 *
 * SUPERSEDING, which is why the claim returns a list it does not act on.
 *
 * Re-ingesting an edited file produces a NEW document — the sha changed — so
 * the version it replaces has to go. It goes at finalisation, not here. The
 * claim commits in milliseconds; indexing then runs for up to a couple of
 * minutes, and anything in that stretch can fail: a malformed page, the
 * embedder falling over, a full disk, the host killing the process. Deleting
 * the predecessor up front meant every one of those failures left the library
 * with no copy of that path at all — and since the file on disk had already
 * been edited, the old text was gone for good.
 *
 * So `claimForIngest` only names the documents to evict, and
 * `finalizeDocument` evicts them inside the transaction that publishes the
 * replacement. In between, the path carries two rows: the old one 'ready' and
 * still answering searches, the new one 'processing' and invisible to them.
 * That interim state is legal by construction — `source_path` has no UNIQUE
 * constraint, and both search legs already filter to 'ready'.
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
        // Inside the lock and inside the claim, so no retry can be running: the
        // row is still 'processing' until failIngest flips it, and every call
        // in there is synchronous.
        //
        // Logged as well as recorded. `documents.error_message` is only ever
        // seen by a caller who polls get_document_outline for this exact id,
        // and after a fire-and-forget ingest nothing prompts them to — so a
        // failed background index could previously leave no trace anywhere a
        // person would look.
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
   * Documents currently occupying this source path that this ingest replaces.
   *
   * Deliberately NOT deleted here. They are handed to `finalizeDocument`, which
   * evicts them in the same transaction that publishes the replacement, so a
   * failure anywhere in between leaves the old version searchable. Empty for
   * every outcome except "started" — the other two do no indexing.
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
      // Somebody else owns this. Touch nothing — not the chunks, not the row,
      // and not the path either: whoever claimed it will do the superseding at
      // its own finalisation, on this caller's behalf.
      //
      // The lease check is what stops that courtesy becoming a deadlock. A row
      // abandoned by a crash is still 'processing', and without the check every
      // future ingest of that file would politely join an ingest that is never
      // going to progress. An expired lease means nobody is home, so this call
      // falls through and takes the document over below.
      return { claim: claimOf(existing, "joined"), supersede: [] };
    }

    // Editing a file changes its sha256, so the old version survives as a
    // second document at the same path and would keep answering searches with
    // text that is no longer in the file. One library path holds one document;
    // the previous occupant goes.
    //
    // Checked BEFORE the reuse branch, not after. A file whose contents are
    // replaced by those of another already-indexed file takes the reuse path —
    // the sha is known — and would otherwise move that document onto this path
    // without evicting what was already there, leaving two documents claiming
    // one path: the exact state this exists to prevent.
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
      // Identical bytes are the same document wherever they live: sha256 is
      // the identity. A renamed or copied file only needs its location
      // recorded, and `sha256 UNIQUE` would refuse a second copy regardless.
      //
      // Evicted eagerly on THIS path, unlike the "started" path below: there
      // is nothing to parse and nothing to embed, so there is no later failure
      // for the old version to survive — and deferring would leave two 'ready'
      // documents at one path with nothing scheduled to resolve it.
      //
      // deleteDocument, not a raw DELETE: the FK cascade takes document_chunks
      // and its AFTER DELETE trigger clears FTS, but vec_chunks is a vec0
      // virtual table that no cascade reaches, and orphaned vectors still
      // answer KNN queries.
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
    for await (const chunk of chunkBlocks(route.parser.parse(src), {
      scheme: meta.locatorScheme,
    })) {
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

  // A document that produced nothing must not be published as though it were
  // complete. PDF already refuses emptiness out loud — a scan with no text
  // layer under --ocr=off — but Markdown and text had no such gate, so a
  // one-byte file
  // became a 'ready' document with zero chunks. Searching it then returns
  // nothing, which is indistinguishable from a topic the library does not
  // cover: exactly the confusion the PDF probe exists to prevent.
  //
  // Thrown rather than finalised, so the caller's error path marks it 'failed'
  // with this message attached and get_document_outline can say why.
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
