import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/sqlite.js";
import { getMeta, setMeta } from "../db/sqlite.js";
import { libraryRelative } from "../security/paths.js";

/**
 * Which library root an index was built against, and what to do when the
 * configured one differs.
 *
 * `source_path` is stored relative to the root, so moving the whole library
 * folder — index and all — changes nothing that matters. Pointing an existing
 * index at a DIFFERENT folder (the parent, a subfolder) is another matter:
 * every stored path then names the wrong file, and drift detection would
 * report the whole library missing. The two look identical from the config
 * alone, so a sample of documents decides which happened.
 */

const META_KEY = "library_root";
/** Enough to tell a moved library from a different one without statting it all. */
const SAMPLE = 20;

export type RootCheck =
  | { status: "recorded" | "same" | "moved" }
  | { status: "mismatch"; recorded: string; message: string };

const sameRoot = (a: string, b: string) =>
  process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

export function checkLibraryRoot(db: Db, libraryRoot: string): RootCheck {
  const recorded = getMeta(db, META_KEY);
  if (recorded === null) {
    setMeta(db, META_KEY, libraryRoot);
    return { status: "recorded" };
  }
  if (sameRoot(recorded, libraryRoot)) return { status: "same" };

  const sample = db
    .prepare("SELECT source_path FROM documents WHERE ingest_status = 'ready' ORDER BY id LIMIT ?")
    .all(SAMPLE) as { source_path: string }[];
  const resolving = sample.filter((d) => fs.existsSync(path.resolve(libraryRoot, d.source_path))).length;
  if (resolving === sample.length) {
    // The library moved as a whole; the relative paths still hold.
    setMeta(db, META_KEY, libraryRoot);
    return { status: "moved" };
  }
  return {
    status: "mismatch",
    recorded,
    message:
      `This index was built for the library root ${recorded}, and only ${resolving} of ` +
      `${sample.length} sampled documents resolve under the configured root. If the root was ` +
      `changed on purpose, run \`pnpm rebase --library=<new root> --db=<this index>\` to ` +
      `re-express every path against it.`,
  };
}

export interface RebaseResult {
  /** Documents whose stored path changed. */
  rebased: number;
  /** Paths that would fall outside the new root. Non-empty means nothing was written. */
  outside: string[];
}

/**
 * Re-express every stored path against a new root, in one transaction, or
 * change nothing at all if any document would fall outside it: a partial
 * rebase would leave the index split between two roots with no record of
 * which row belongs to which.
 */
export function rebaseLibrary(db: Db, oldRoot: string, newRoot: string): RebaseResult {
  const rows = db.prepare("SELECT id, source_path FROM documents").all() as { id: string; source_path: string }[];
  const tombstones = db.prepare("SELECT id, source_path FROM superseded_documents").all() as {
    id: string;
    source_path: string;
  }[];

  const reexpress = (rel: string): string | null => {
    const next = libraryRelative(newRoot, path.resolve(oldRoot, rel));
    return next === "" || next.startsWith("../") || next === ".." || path.isAbsolute(next) ? null : next;
  };

  const outside = rows.filter((r) => reexpress(r.source_path) === null).map((r) => r.source_path);
  if (outside.length > 0) return { rebased: 0, outside };

  let rebased = 0;
  db.transaction(() => {
    const update = db.prepare("UPDATE documents SET source_path = ? WHERE id = ?");
    for (const r of rows) {
      const next = reexpress(r.source_path)!;
      if (next !== r.source_path) {
        update.run(next, r.id);
        rebased++;
      }
    }
    // Tombstones are history: re-expressed where they can be, left as they
    // were where the old file lay outside the new root.
    const updateTomb = db.prepare("UPDATE superseded_documents SET source_path = ? WHERE id = ?");
    for (const t of tombstones) {
      const next = reexpress(t.source_path);
      if (next !== null && next !== t.source_path) updateTomb.run(next, t.id);
    }
    setMeta(db, META_KEY, newRoot);
  })();
  return { rebased, outside: [] };
}
