/**
 * Diagnostics, on stderr, always.
 *
 * stdout is the JSON-RPC channel for a stdio MCP server and a single stray
 * write to it corrupts the protocol stream, so there is deliberately no
 * console.log-shaped escape hatch anywhere in this module.
 *
 * Why this exists at all: ingest is fire-and-forget. `ingest_document` returns
 * a document_id immediately and indexes behind a promise nobody awaits, and
 * the only record of a failure was `documents.error_message` — discoverable
 * only by a caller who thought to poll get_document_outline for that exact id.
 * A background ingest could fail, delete nothing, log nothing, and simply
 * never appear. Deleting a user's previously-indexed document on supersede was
 * likewise completely silent.
 *
 * Deliberately not a logging framework. One line per event, prefixed and
 * timestamped, is what a local single-user server needs; levels, transports
 * and structured sinks would be scaffolding around three call sites.
 */

const stamp = (): string => new Date().toISOString();

function write(level: string, message: string): void {
  process.stderr.write(`${stamp()} ${level} document-index-mcp: ${message}\n`);
}

/** The human-readable half of an error, without the class-name prefix. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const log = {
  info: (message: string): void => write("INFO ", message),
  warn: (message: string): void => write("WARN ", message),
  error: (message: string): void => write("ERROR", message),
};

/**
 * Last-resort handlers, so a crash says why.
 *
 * Neither entry point had these. An unhandled rejection terminates the process
 * by default in Node 15+, and for a stdio MCP server that means the host sees
 * the pipe close with no explanation on either side.
 */
export function installProcessHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    log.error(`unhandled rejection: ${describeError(reason)}`);
    if (reason instanceof Error && reason.stack) process.stderr.write(`${reason.stack}\n`);
  });
  process.on("uncaughtException", (err: unknown) => {
    log.error(`uncaught exception: ${describeError(err)}`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    // Not swallowed: an uncaught exception means state is unknown, and a
    // server that keeps answering from unknown state is worse than one that
    // stops. The lock file is reclaimed on next start by its pid check.
    process.exit(1);
  });
}
