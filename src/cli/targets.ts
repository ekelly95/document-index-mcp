import fs from "node:fs/promises";
import path from "node:path";

/**
 * What `pnpm ingest` will look at, kept apart from the CLI's entry point so it
 * can be tested without a model, a lock or `process.exit`.
 */

export const SUPPORTED = new Set([".md", ".markdown", ".txt", ".pdf", ".docx"]);

/** Where a run says what it skipped. The CLI passes stderr. */
export type Warn = (message: string) => void;

export async function* walk(dir: string, recursive: boolean, warn: Warn): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Said, not swallowed: a folder the run could not open is part of the
    // library that did not get indexed.
    warn(`skip (unreadable): ${dir} — ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .git, .obsidian, .document-index
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* walk(full, recursive, warn);
    } else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

export interface ResolvedTargets {
  /** Absolute paths, in the order found. */
  files: string[];
  /** How many of the targets existed. Zero means the run was mistyped. */
  resolved: number;
}

/** Expand library-relative targets (files or folders) into the files to ingest. */
export async function resolveTargets(
  libraryRoot: string,
  targets: readonly string[],
  recursive: boolean,
  warn: Warn,
): Promise<ResolvedTargets> {
  const files: string[] = [];
  let resolved = 0;
  for (const target of targets) {
    const abs = path.resolve(libraryRoot, target);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      warn(`skip (not found): ${target}`);
      continue;
    }
    resolved++;
    if (stat.isDirectory()) {
      for await (const file of walk(abs, recursive, warn)) files.push(file);
    } else {
      files.push(abs);
    }
  }
  return { files, resolved };
}
