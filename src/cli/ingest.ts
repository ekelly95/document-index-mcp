import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { indexCounts } from "../db/chunksRepo.js";
import { beginIngest, drainIngests } from "../ingest/runner.js";
import { disposeOcrPool } from "../pipeline/parsers/ocrPool.js";
import { installProcessHandlers } from "../log.js";

/**
 * Bulk ingest, outside the MCP request/response cycle.
 *
 * The in-chat tool is fire-and-forget and fine for one paper at a time; this
 * is for pointing at a library folder and walking away. No timeout applies to
 * either, but only this one gives you a progress log and an exit code.
 *
 *   pnpm ingest --library=C:\Users\me\Notes . --recursive
 */

const SUPPORTED = new Set([".md", ".markdown", ".txt", ".pdf", ".docx"]);

/** How long an interrupted run waits for the document in hand. */
const DRAIN_TIMEOUT_MS = 30_000;

async function* walk(dir: string, recursive: boolean): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .git, .obsidian, .document-index
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* walk(full, recursive);
    } else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

async function main(): Promise<void> {
  installProcessHandlers();
  const argv = process.argv.slice(2);
  const recursive = argv.includes("--recursive");
  const targets = argv.filter((a) => !a.startsWith("--"));
  if (targets.length === 0) targets.push(".");

  const config = loadConfig(argv);
  // Unlike the server, which runs as a peer when another process holds the
  // lock, a bulk run insists on it: see ContextOptions.requireIndexLock.
  const ctx = createContext(config, { requireIndexLock: true });

  // The CLI had no signal handling at all: Ctrl-C mid-library left the current
  // document 'processing', the WAL uncheckpointed and the lock file behind.
  // Everything already indexed is committed and keeps, so this only has to
  // finish the document in hand and put the index down properly.
  let interrupted = false;
  const stop = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("\ninterrupted — finishing the current document, then stopping\n");
    void (async () => {
      const abandoned = await drainIngests(DRAIN_TIMEOUT_MS);
      if (abandoned > 0) {
        process.stderr.write(
          `${abandoned} ingest(s) did not finish in time and will be reset on the next run\n`,
        );
      }
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

  process.stderr.write(`library: ${config.libraryRoot}\ndb:      ${config.dbPath}\n\n`);
  process.stderr.write("warming up the embedding model (first run downloads ~130MB)...\n");
  await ctx.embedder.warmup();

  const files: string[] = [];
  for (const target of targets) {
    const abs = path.resolve(config.libraryRoot, target);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      process.stderr.write(`skip (not found): ${target}\n`);
      continue;
    }
    if (stat.isDirectory()) {
      for await (const file of walk(abs, recursive)) files.push(file);
    } else {
      files.push(abs);
    }
  }

  process.stderr.write(`\n${files.length} file(s) to consider\n\n`);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  const started = Date.now();

  for (const [i, file] of files.entries()) {
    const rel = path.relative(config.libraryRoot, file);
    const prefix = `[${i + 1}/${files.length}] ${rel}`;
    try {
      const handle = await beginIngest(ctx, rel);
      if (handle.outcome !== "started") {
        skipped++;
        process.stderr.write(
          `${prefix} — ${handle.outcome === "reused" ? "already indexed" : "already being indexed elsewhere"}\n`,
        );
        continue;
      }
      await handle.done;
      indexed++;
      process.stderr.write(`${prefix} — ok\n`);
    } catch (err) {
      failed++;
      process.stderr.write(
        `${prefix} — FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const counts = indexCounts(ctx.db);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(
    `\ndone in ${seconds}s — ${indexed} indexed, ${skipped} already present, ${failed} failed\n` +
      `index: ${counts.chunks} chunks / ${counts.fts} fts / ${counts.vectors} vectors` +
      (counts.chunks === counts.fts && counts.chunks === counts.vectors
        ? " (in agreement)\n"
        : "  *** MISMATCH ***\n"),
  );

  await disposeOcrPool().catch(() => {});
  ctx.db.close();
  ctx.lock.release();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  // `.message`, not String(err): these messages are written for a person to
  // act on, and an "IndexLockedError:" prefix in front of a paragraph that
  // already explains itself is noise.
  process.stderr.write(`ingest failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
