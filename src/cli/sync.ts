import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { indexCounts } from "../db/chunksRepo.js";
import { beginIngest, drainIngests } from "../ingest/runner.js";
import { disposeOcrPool } from "../pipeline/parsers/ocrPool.js";
import { describeError, installProcessHandlers } from "../log.js";
import { planSync } from "./syncPlan.js";
import { resolveTargets } from "./targets.js";

/**
 * Bring the index up to date with the files behind it.
 *
 *   pnpm sync --library=<root> [targets...] [--recursive] [--dry-run]
 *
 * Every indexed file is statted. One that changed is re-ingested, keeping its
 * title; the version it replaces leaves tombstones, so its chunk_ids explain
 * where they went. A failed document is retried once its file has changed.
 * A missing file is reported and nothing more: the index never deletes on the
 * strength of a file being absent, which is also what an unmounted drive or a
 * sync client mid-download looks like. delete_document is the deliberate way.
 *
 * Named targets (files or folders, as for `pnpm ingest`) are also swept for
 * supported files no document holds yet, which are ingested.
 */

const DRAIN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  installProcessHandlers();
  const argv = process.argv.slice(2);
  const recursive = argv.includes("--recursive");
  const dryRun = argv.includes("--dry-run");
  const targets = argv.filter((a) => !a.startsWith("--"));

  const config = loadConfig(argv);
  process.stderr.write(`library: ${config.libraryRoot}\ndb:      ${config.dbPath}\n\n`);

  const warn = (m: string) => process.stderr.write(`${m}\n`);
  const { files, resolved } = await resolveTargets(config.libraryRoot, targets, recursive, warn);
  if (targets.length > 0 && resolved === 0) {
    process.stderr.write(`\nnothing to sweep: no target exists under ${config.libraryRoot}\n`);
    process.exit(2);
  }

  const ctx = createContext(config, { requireIndexLock: true });
  const plan = planSync(ctx.db, config.libraryRoot, files);

  for (const d of plan.missing) {
    process.stderr.write(`missing   ${d.source_path} — ${d.id} (left in the index; delete_document drops it)\n`);
  }
  for (const d of plan.changed) process.stderr.write(`changed   ${d.source_path}\n`);
  for (const d of plan.retry) process.stderr.write(`retry     ${d.source_path} (failed before; the file has changed)\n`);
  for (const rel of plan.untracked) process.stderr.write(`new       ${rel}\n`);

  const work = [
    ...plan.changed.map((d) => ({ path: d.source_path, title: d.title as string | undefined })),
    ...plan.retry.map((d) => ({ path: d.source_path, title: undefined })),
    ...plan.untracked.map((p) => ({ path: p, title: undefined })),
  ];
  process.stderr.write(
    `\n${plan.changed.length} changed, ${plan.retry.length} to retry, ${plan.untracked.length} new, ` +
      `${plan.missing.length} missing\n`,
  );
  if (dryRun || work.length === 0) {
    if (dryRun) process.stderr.write("dry run: nothing was changed\n");
    ctx.db.close();
    ctx.lock.release();
    process.exit(0);
  }

  let interrupted = false;
  const stop = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("\ninterrupted — finishing the current document, then stopping\n");
    void (async () => {
      await drainIngests(DRAIN_TIMEOUT_MS);
      await disposeOcrPool().catch(() => {});
      try {
        ctx.db.close();
      } catch {
        // Already closed.
      }
      ctx.lock.release();
      process.exit(130);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.stderr.write("warming up the embedding model (first run downloads ~65MB)...\n\n");
  await ctx.embedder.warmup();

  let indexed = 0;
  let unchanged = 0;
  let failed = 0;
  const started = Date.now();
  for (const [i, item] of work.entries()) {
    const prefix = `[${i + 1}/${work.length}] ${item.path}`;
    try {
      const handle = await beginIngest(ctx, item.path, item.title === undefined ? {} : { title: item.title });
      if (handle.outcome !== "started") {
        // Touched but byte-identical: the stat is refreshed and nothing re-indexed.
        unchanged++;
        process.stderr.write(`${prefix} — bytes unchanged; stat refreshed\n`);
        continue;
      }
      await handle.done;
      indexed++;
      process.stderr.write(`${prefix} — ok\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`${prefix} — FAILED: ${describeError(err)}\n`);
    }
  }

  const counts = indexCounts(ctx.db);
  process.stderr.write(
    `\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s — ${indexed} indexed, ` +
      `${unchanged} unchanged, ${failed} failed, ${plan.missing.length} missing\n` +
      `index: ${counts.chunks} chunks / ${counts.fts} fts / ${counts.vectors} vectors\n`,
  );
  await disposeOcrPool().catch(() => {});
  ctx.db.close();
  ctx.lock.release();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
