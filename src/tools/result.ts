import type { CallToolResult } from "@modelcontextprotocol/server";
import { describeError } from "../log.js";

/**
 * Ported from obsidian-mcp/src/tools/result.ts.
 */

/** A tool result carrying both the rendered text and the validated payload. */
export function okStructured<T extends Record<string, unknown>>(
  text: string,
  structuredContent: T,
): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

/**
 * Absolute paths that must never leave in a reply, longest first.
 *
 * Registered once at startup rather than threaded through every call site,
 * because the point is that no tool CAN forget it — `describeFsError` below
 * scrubbed the four filesystem errors it knew about and every other error in
 * the server went out raw, which is a guarantee that holds only until the next
 * errno nobody thought of.
 */
const redactions: { path: string; as: string }[] = [];

/** Called once from createContext, before any tool can be invoked. */
export function redactPathsInReplies(paths: readonly { path: string; as: string }[]): void {
  redactions.length = 0;
  // Longest first, because dbPath normally sits inside libraryRoot and
  // replacing the shorter one first would leave a half-substituted path.
  redactions.push(...paths.filter((p) => p.path.length > 0).sort((a, b) => b.path.length - a.path.length));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Case-insensitive on Windows, where the same directory legitimately arrives
 * spelled two ways: `config.libraryRoot` is `path.resolve`d and keeps whatever
 * the host config typed, while a path inside an fs error comes from
 * `assertRealPathInside` and carries the on-disk casing.
 */
function redact(text: string): string {
  let out = text;
  for (const { path, as } of redactions) {
    out = out.replace(new RegExp(escapeRegExp(path), process.platform === "win32" ? "gi" : "g"), as);
  }
  return out;
}

/**
 * Tool errors are returned as results with isError, not thrown. A thrown error
 * becomes a protocol-level failure the model cannot see or recover from;
 * returned text lets it correct the call (unknown chunk, document still
 * processing, unsupported format).
 *
 * Every one of them is scrubbed on the way out. See `redactions` above.
 */
export function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: redact(text) }] };
}

// Lives in log.ts — infra, which the tools layer depends on rather than the
// other way round — and is re-exported here so tool modules keep one import.
export { describeError };

/**
 * As describeError, but turns the common filesystem failures into something the
 * model can act on — and keeps the library's absolute path out of the reply.
 *
 * Node's raw ENOENT carries the resolved path, so a mistyped filename came back
 * as "no such file or directory, open 'C:\\...\\library\\nope.pdf'", putting the
 * layout of the machine into the caller's context and every transcript that
 * context reaches. Every other refusal in this server already echoes just what
 * the caller passed — "Path escapes library root: ..." — so this brings the fs
 * errors into line with them.
 *
 * This maps the errnos worth a better message; it is no longer what makes the
 * reply safe. The `default` branch used to hand Node's raw text straight out,
 * and the reachable list is longer than the four below — a symlink loop inside
 * the library gives ELOOP, which `assertRealPathInside` swallows and
 * `openSource` then throws, and ENAMETOOLONG and ERR_FS_FILE_TOO_LARGE arrive
 * the same way. `fail` scrubs all of them now, so this is about legibility.
 */
export function describeFsError(err: unknown, relPath: string): string {
  switch ((err as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
      return `Not found in the library: ${relPath}`;
    case "EISDIR":
      return `Not a file: ${relPath} is a directory`;
    case "EACCES":
    case "EPERM":
      return `Permission denied: ${relPath}`;
    default:
      return describeError(err);
  }
}
