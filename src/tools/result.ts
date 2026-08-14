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
 * Tool errors are returned as results with isError, not thrown. A thrown error
 * becomes a protocol-level failure the model cannot see or recover from;
 * returned text lets it correct the call (unknown chunk, document still
 * processing, unsupported format).
 */
export function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
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
