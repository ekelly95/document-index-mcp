import type { DocumentRow } from "../db/documentsRepo.js";
import { listDocuments } from "../db/documentsRepo.js";
import type { Db } from "../db/sqlite.js";
import { libraryRelative } from "../security/paths.js";
import { sourceStatus } from "../library/sourceStatus.js";

/**
 * What `pnpm sync` will do, decided from stats alone, kept apart from the
 * CLI's entry point so it can be tested without a model, a lock or
 * `process.exit`.
 */
export interface SyncPlan {
  /** Ready documents whose file changed: re-ingested, keeping their title. */
  changed: DocumentRow[];
  /** Failed documents whose file changed since the attempt: retried. */
  retry: DocumentRow[];
  /** Documents whose file is gone. Reported, never deleted. */
  missing: DocumentRow[];
  /** Supported files under the named targets that no document holds: ingested. */
  untracked: string[];
}

/**
 * A failed document is retried only once its file has changed. Retrying an
 * unchanged file would fail the same way on every run, and the reason is
 * already on the row for get_document_outline to show.
 *
 * `targetFiles` are absolute paths from `resolveTargets`. A file already held
 * by a document is never re-read here — that is the point of a stat-only plan
 * — so a large library with nothing new costs one stat per document.
 */
export function planSync(
  db: Db,
  libraryRoot: string,
  targetFiles: readonly string[],
  caseInsensitive = process.platform === "win32" || process.platform === "darwin",
): SyncPlan {
  const plan: SyncPlan = { changed: [], retry: [], missing: [], untracked: [] };
  const key = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const held = new Set<string>();

  for (const doc of listDocuments(db)) {
    held.add(key(doc.source_path));
    // A live writer owns it; an expired one is reaped as failed at startup.
    if (doc.ingest_status === "processing") continue;
    const status = sourceStatus(libraryRoot, doc);
    if (status === "missing") plan.missing.push(doc);
    else if (status === "changed") (doc.ingest_status === "ready" ? plan.changed : plan.retry).push(doc);
  }

  for (const file of targetFiles) {
    const rel = libraryRelative(libraryRoot, file);
    if (!held.has(key(rel))) plan.untracked.push(rel);
  }
  // A path held by both a missing and a ready row cannot happen (one path, one
  // document), so the lists are disjoint by construction.
  plan.changed.sort(byPath);
  plan.retry.sort(byPath);
  plan.missing.sort(byPath);
  return plan;
}

function byPath(a: DocumentRow, b: DocumentRow): number {
  return a.source_path.localeCompare(b.source_path);
}
