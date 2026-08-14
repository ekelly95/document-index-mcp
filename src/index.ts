import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { buildServer } from "./server.js";
import { activeIngests, drainIngests } from "./ingest/runner.js";
import { disposeOcrPool } from "./pipeline/parsers/ocrPool.js";
import { describeError, installProcessHandlers, log } from "./log.js";

/**
 * Entry point. Everything is logged to stderr: stdout is the JSON-RPC channel
 * and a stray write to it corrupts the protocol stream.
 */

/** How long a shutdown waits for in-flight indexing before giving up on it. */
const DRAIN_TIMEOUT_MS = 10_000;

/** How long `process.exit` gets to work before the process is killed outright. */
const FORCE_EXIT_MS = 3_000;

async function main(): Promise<void> {
  installProcessHandlers();
  const config = loadConfig();
  const ctx = createContext(config);
  const server = buildServer(ctx);

  let shuttingDown = false;

  /**
   * Stop cleanly, or say what was lost.
   *
   * This used to close the database and call process.exit(0) on the spot, so
   * Ctrl-C during a long index discarded every chunk of it: the row was left
   * 'processing' and the next startup reclaimed it. Now new ingests are
   * refused, in-flight ones get a bounded window to reach a batch boundary or
   * finish outright, and only then does the process go.
   *
   * Whatever does not finish keeps its 'processing' row with an unrenewed
   * lease, which recovery reclaims on the next start. That is the honest
   * trade: a host asking the server to quit should not be made to wait out a
   * 900-page book.
   */
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    void (async () => {
      const active = activeIngests();
      if (active > 0) {
        log.info(`${reason} — waiting for ${active} ingest(s) to reach a safe point`);
      }
      try {
        const abandoned = await drainIngests(DRAIN_TIMEOUT_MS);
        if (abandoned > 0) {
          log.warn(
            `${abandoned} ingest(s) did not finish in ${DRAIN_TIMEOUT_MS / 1000}s and were ` +
              `left interrupted; they will be reset on the next start. Re-ingest to retry.`,
          );
        }
      } catch (err: unknown) {
        log.error(`shutdown drain failed: ${describeError(err)}`);
      }

      // After the drain, not before: a draining OCR ingest is still feeding
      // pages to these workers. Terminating them rejects whatever jobs an
      // abandoned ingest still has in flight, which lands in the runner's
      // normal failure path.
      try {
        await disposeOcrPool();
      } catch {
        // Workers that refuse to die will go down with the process.
      }

      try {
        await server.close();
      } catch {
        // The transport may already be gone; that is what got us here.
      }
      try {
        ctx.db.close();
      } catch {
        // Already closed, or never opened.
      }
      ctx.lock.release();
      log.info("stopped");

      // process.exit() is not reliably the end of a process. It runs atexit
      // handlers and static destructors belonging to the native addons loaded
      // here — SQLite, ONNX Runtime and its thread pool — and one of those
      // deadlocked exactly once: a server that had already logged this line
      // sat idle for hours afterwards, still holding the index lock, so every
      // restart the host attempted was refused.
      //
      // By this line the drain is done, the database is closed and the lock is
      // released, so there is nothing left to flush and no reason to negotiate.
      // This only fires while the event loop still turns; a deadlock inside
      // native teardown is out of reach from here, which is why the lock also
      // records that it was released rather than trusting the pid alone.
      const forced = setTimeout(() => process.kill(process.pid, "SIGKILL"), FORCE_EXIT_MS);
      forced.unref();
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("interrupted"));
  process.on("SIGTERM", () => shutdown("terminated"));

  // The trigger that actually fires on the deployment target. On Windows,
  // SIGTERM is not natively delivered and SIGINT only reaches console-attached
  // processes — so under a GUI host like Claude Desktop a signal-only handler
  // may never run at all. A stdio host closing its end of the pipe is the
  // reliable signal, and it is the normal way an MCP server is stopped.
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.stdin.on("end", () => shutdown("stdin ended"));

  await server.connect(new StdioServerTransport());
  log.info(
    `ready — library ${config.libraryRoot}, db ${config.dbPath}, ` +
      `ingest concurrency ${config.ingestConcurrency}, ` +
      // Which process holds the lock is a race, so say it: it is the first
      // thing worth knowing when two of them disagree about what recovery ran.
      // Worded so neither line is a substring of the other, because the way
      // this gets read is a grep across two logs.
      `${ctx.primary ? "role primary (runs startup recovery)" : "role peer (another process runs startup recovery)"}`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`document-index-mcp failed to start: ${describeError(err)}\n`);
  process.exit(1);
});
