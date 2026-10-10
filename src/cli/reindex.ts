import fs from "node:fs";
import { loadConfig, parseFlags } from "../config.js";
import { createContext } from "../context.js";
import { indexCounts } from "../db/chunksRepo.js";
import { acquireIndexLock } from "../db/processLock.js";
import { beginIngest } from "../ingest/runner.js";
import { disposeOcrPool } from "../pipeline/parsers/ocrPool.js";
import { describeError, installProcessHandlers } from "../log.js";
import { moveAside, readOldIndex } from "./oldIndex.js";

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
  process.stderr.write(`${old.documents.length} document(s) in the v${old.version} index at ${source}\n`);
  if (from === undefined) {
    process.stderr.write(`moved it aside to ${moveAside(config.dbPath, old.version)}\n`);
  }

  const ctx = createContext(config, { requireIndexLock: true });
  process.stderr.write("warming up the embedding model...\n\n");
  await ctx.embedder.warmup();

  let rebuilt = 0;
  const failures: string[] = [];
  const started = Date.now();
  for (const [i, doc] of old.documents.entries()) {
    const prefix = `[${i + 1}/${old.documents.length}] ${doc.source_path}`;
    try {
      const handle = await beginIngest(ctx, doc.source_path, { title: doc.title });
      await handle.done;
      rebuilt++;
      process.stderr.write(`${prefix} — ok\n`);
    } catch (err) {
      failures.push(doc.source_path);
      process.stderr.write(`${prefix} — FAILED: ${describeError(err)}\n`);
    }
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
