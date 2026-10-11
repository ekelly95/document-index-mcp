import fs from "node:fs";
import { loadConfig, parseFlags } from "../config.js";
import { createContext } from "../context.js";
import { indexCounts } from "../db/chunksRepo.js";
import { acquireIndexLock } from "../db/processLock.js";
import { beginIngest } from "../ingest/runner.js";
import { disposeOcrPool } from "../pipeline/parsers/ocrPool.js";
import { describeError, installProcessHandlers } from "../log.js";
import { insertTombstones } from "../db/documentsRepo.js";
import {
  hashChunkText,
  moveAside,
  readOldCitations,
  readOldIndex,
  tombstonesAfterRebuild,
  type OldChunk,
} from "./oldIndex.js";

/**
 * Rebuild an index from the library, keeping every document's title.
 *
 *   pnpm reindex --library=<root> [--db=<index>] [--from=<old index>]
 *
 * The index is derived data, so a schema bump or a pipeline change is
 * answered by rebuilding rather than migrating. What the files cannot supply
 * is the titles a caller chose at ingest time, so those are read out of the
 * old index first. Without --from, the old index is moved aside as
 * `<db>.v<version>.bak` (with its -wal and -shm); with it, the old index is
 * only read and the new one is built at --db.
 *
 * Ids survive the rebuild where they still mean the same thing: each document
 * keeps its document_id, and a chunk whose text is identical at the same seq
 * keeps its chunk_id. Every other old chunk_id gets a tombstone, so a citation
 * made against the old index explains itself instead of reading as unknown.
 */

async function main(): Promise<void> {
  installProcessHandlers();
  const argv = process.argv.slice(2);
  const config = loadConfig(argv);
  const from = parseFlags(argv).get("from");

  const source = from ?? config.dbPath;
  if (!fs.existsSync(source)) throw new Error(`No index to rebuild from at ${source}.`);
  if (from === undefined) {
    // Refuse while anything else has the index open; nothing is moved yet.
    acquireIndexLock(config.dbPath).release();
  } else if (fs.existsSync(config.dbPath)) {
    throw new Error(`${config.dbPath} already exists; --from builds a NEW index. Remove it or pick another --db.`);
  }

  const old = readOldIndex(source);
  const citations = readOldCitations(source);
  const oldChunks = new Map<string, Map<number, OldChunk>>();
  for (const c of citations.chunks) {
    let bySeq = oldChunks.get(c.document_id);
    if (!bySeq) oldChunks.set(c.document_id, (bySeq = new Map()));
    bySeq.set(c.seq, c);
  }
  process.stderr.write(`${old.documents.length} document(s) in the v${old.version} index at ${source}\n`);
  if (from === undefined) {
    process.stderr.write(`moved it aside to ${moveAside(config.dbPath, old.version)}\n`);
  }

  const ctx = createContext(config, { requireIndexLock: true });
  process.stderr.write("warming up the embedding model...\n\n");
  await ctx.embedder.warmup();

  let rebuilt = 0;
  const failures: string[] = [];
  const rebuiltAs = new Map<string, string | null>();
  const reused = new Set<string>();
  const started = Date.now();
  for (const [i, doc] of old.documents.entries()) {
    const prefix = `[${i + 1}/${old.documents.length}] ${doc.source_path}`;
    try {
      const previous = doc.id === undefined ? undefined : oldChunks.get(doc.id);
      const handle = await beginIngest(ctx, doc.source_path, {
        title: doc.title,
        ...(doc.id === undefined ? {} : { preferredId: doc.id }),
        ...(previous === undefined
          ? {}
          : {
              reuseChunkId: (seq: number, text: string) => {
                const was = previous.get(seq);
                if (!was || was.text_hash !== hashChunkText(text)) return undefined;
                reused.add(was.chunk_id);
                return was.chunk_id;
              },
            }),
      });
      await handle.done;
      if (doc.id !== undefined) rebuiltAs.set(doc.id, handle.documentId);
      rebuilt++;
      process.stderr.write(`${prefix} — ok\n`);
    } catch (err) {
      failures.push(doc.source_path);
      if (doc.id !== undefined) rebuiltAs.set(doc.id, null);
      process.stderr.write(`${prefix} — FAILED: ${describeError(err)}\n`);
    }
  }

  const tombstones = tombstonesAfterRebuild(
    citations,
    old.documents,
    rebuiltAs,
    reused,
    new Date().toISOString(),
  );
  insertTombstones(ctx.db, tombstones);
  if (citations.chunks.length > 0) {
    process.stderr.write(
      `\nkept ${reused.size} of ${citations.chunks.length} chunk_id(s); ` +
        `${citations.chunks.length - reused.size} now explain themselves as retired\n`,
    );
  }

  const counts = indexCounts(ctx.db);
  process.stderr.write(
    `\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s — ${rebuilt} rebuilt, ${failures.length} failed\n` +
      `index: ${counts.chunks} chunks / ${counts.fts} fts / ${counts.vectors} vectors\n`,
  );
  await disposeOcrPool().catch(() => {});
  ctx.db.close();
  ctx.lock.release();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`reindex failed: ${describeError(err)}\n`);
  process.exit(1);
});
