import fs from "node:fs";
import type { DocumentRow } from "../db/documentsRepo.js";
import { safeResolve } from "../security/paths.js";

/**
 * Does the file behind a document still look like what was indexed?
 *
 * Stat only — size and truncated mtime against what `beginIngest` recorded —
 * so it is cheap enough to run on every search hit. It never hashes and never
 * acts: "changed" means the file may say something different now, and the
 * remedy (`pnpm sync`, or ingest_document) is the caller's to choose. Nothing
 * is ever deleted because a file went missing.
 *
 * A touch that leaves the bytes alone reads as "changed" until the file is
 * next ingested, which then only refreshes the stat (see setSourceLocation).
 * A false "changed" costs one re-hash; a false "present" would be a stale
 * quotation passed off as current, so the check leans the cheap way.
 */
export type SourceStatus = "present" | "changed" | "missing";

export const SOURCE_STATUSES = ["present", "changed", "missing"] as const;

export function sourceStatus(
  libraryRoot: string,
  doc: Pick<DocumentRow, "source_path" | "source_size" | "source_mtime_ms">,
): SourceStatus {
  let abs: string;
  try {
    abs = safeResolve(libraryRoot, doc.source_path);
  } catch {
    // A stored path that no longer passes the boundary check (the root
    // moved under it) does not resolve to anything this server may read.
    return "missing";
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "missing";
  // A row written before the stat was recorded has nothing to compare;
  // calling it changed sends it through one re-ingest that records one.
  if (doc.source_size === null || doc.source_mtime_ms === null) return "changed";
  return st.size === doc.source_size && Math.trunc(st.mtimeMs) === doc.source_mtime_ms
    ? "present"
    : "changed";
}

/**
 * Statuses for a set of documents, each statted once however many hits it
 * contributed.
 */
export function sourceStatuses(
  libraryRoot: string,
  docs: Iterable<Pick<DocumentRow, "id" | "source_path" | "source_size" | "source_mtime_ms">>,
): Map<string, SourceStatus> {
  const out = new Map<string, SourceStatus>();
  for (const doc of docs) {
    if (!out.has(doc.id)) out.set(doc.id, sourceStatus(libraryRoot, doc));
  }
  return out;
}
