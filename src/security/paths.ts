import path from "node:path";
import fs from "node:fs/promises";

/**
 * Ported from obsidian-mcp/src/vault/paths.ts. The containment logic is
 * unchanged; only the extension gate differs.
 */

export class PathTraversalError extends Error {
  override readonly name = "PathTraversalError";
}

/** True when a path.relative() result climbs out of its base. */
function escapesBase(rel: string): boolean {
  return (
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith("../") ||
    path.isAbsolute(rel)
  );
}

/**
 * Extensions the library will open at all.
 *
 * This is a guard, not the format decision — routing is done by magic bytes in
 * router.ts, so a .pdf that is really a zip is still caught downstream. The
 * gate exists so that pointing the server at a directory which also happens to
 * contain .env or id_rsa does not make those addressable.
 */
const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  // Legacy Word is admitted so the router's refusal can name the remedy
  // (convert with Word) instead of the gate refusing opaquely. .ppt is NOT,
  // because there is no longer a slide format to convert it to.
  ".doc",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".txt",
]);

/**
 * Resolve a library-relative path to a safe absolute path, or throw.
 *
 * Containment is checked with path.relative rather than
 * resolved.startsWith(base). The startsWith form is a known vulnerability
 * class: a sibling directory such as `library-secrets` shares the `library`
 * prefix and would pass the check while sitting outside the root.
 */
export function safeResolve(libraryRoot: string, relInput: string): string {
  if (typeof relInput !== "string" || relInput.length === 0) {
    throw new PathTraversalError("Empty path");
  }
  if (relInput.includes("\0")) {
    throw new PathTraversalError("Illegal NUL byte in path");
  }

  const base = path.resolve(libraryRoot);
  const resolved = path.resolve(base, relInput);
  const rel = path.relative(base, resolved);

  if (rel === "" || escapesBase(rel)) {
    throw new PathTraversalError(`Path escapes library root: ${relInput}`);
  }

  // Case-insensitive: on Windows `Book.PDF` and `book.pdf` are the same file.
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new PathTraversalError(
      `Unsupported file type "${ext || "(none)"}". Supported: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
    );
  }

  return resolved;
}

/**
 * Guard against symlinks that pass the lexical check but physically escape,
 * and return the canonical on-disk path.
 *
 * A file that does not exist yet is allowed through: safeResolve has already
 * proven the path is lexically inside. This does not close a TOCTOU race
 * against a hostile local user creating a symlink between check and read.
 *
 * The realpath is RETURNED rather than discarded because it is the only
 * spelling of a file that is stable. On Windows it carries the on-disk
 * casing, so `Methods.md` and `methods.md` converge; it also collapses 8.3
 * short names and symlink aliases. Everything downstream that identifies a
 * file by its path — `source_path`, and the query that supersedes a stale
 * document — has to agree on one spelling or the same file becomes two.
 */
export async function assertRealPathInside(
  libraryRoot: string,
  abs: string,
): Promise<string> {
  const base = await fs.realpath(path.resolve(libraryRoot));

  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    // Does not exist yet; the lexical check already passed, so hand back what
    // was asked for rather than failing a caller that is about to create it.
    return abs;
  }

  if (escapesBase(path.relative(base, real))) {
    throw new PathTraversalError("Symlink escapes library root");
  }
  return real;
}

/**
 * The canonical library-relative form of an absolute path.
 *
 * One spelling per file, so `documents.source_path` can be compared with `=`.
 * Separators are normalised to `/` — a row written as `sub\file.md` would
 * otherwise never match one written as `sub/file.md`, and the two differ only
 * by which platform happened to write them.
 *
 * Case is deliberately NOT folded here. The value is user-facing (it is what
 * `get_document_outline` prints and what a caller passes back to
 * `ingest_document`), and folding it would be wrong on a case-sensitive
 * filesystem. Windows case is handled upstream instead, by deriving `abs`
 * from `assertRealPathInside`.
 */
export function libraryRelative(libraryRoot: string, abs: string): string {
  return path
    .relative(path.resolve(libraryRoot), abs)
    .split(path.sep)
    .join("/");
}
