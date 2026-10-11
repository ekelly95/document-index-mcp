import type { SourceStatus } from "../library/sourceStatus.js";
import { oneLine } from "./shapes.js";

/** How the reading tools word a source that no longer matches its index. */

export interface DriftedSource {
  document_id: string;
  title: string;
  source_path: string;
}

const REMEDY = "Run `pnpm sync` (or ingest_document on the path) to bring the index up to date.";

/**
 * A caveat paragraph for sources that changed or went missing since they were
 * indexed, or "" when every one is present. Without it a quotation from an
 * edited file reads exactly like a current one.
 */
export function driftCaveat(changed: readonly DriftedSource[], missing: readonly DriftedSource[]): string {
  const lines: string[] = [];
  for (const d of changed) {
    lines.push(
      `  - "${oneLine(d.title)}" (${d.source_path}) has changed since it was indexed; quotes from it may be out of date.`,
    );
  }
  for (const d of missing) {
    lines.push(
      `  - "${oneLine(d.title)}" (${d.source_path}) is no longer on disk; its passages describe a file that is gone.`,
    );
  }
  return lines.length === 0 ? "" : `\n\n_Source drift:_\n${lines.join("\n")}\n${REMEDY}`;
}

/** Split documents by status into the two lists `driftCaveat` takes. */
export function partitionDrift<T extends DriftedSource>(
  docs: readonly T[],
  status: (doc: T) => SourceStatus,
): { changed: T[]; missing: T[] } {
  const changed: T[] = [];
  const missing: T[] = [];
  for (const d of docs) {
    const s = status(d);
    if (s === "changed") changed.push(d);
    else if (s === "missing") missing.push(d);
  }
  return { changed, missing };
}
