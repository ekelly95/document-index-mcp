import path from "node:path";
import { loadConfig, parseFlags } from "../config.js";
import { acquireIndexLock } from "../db/processLock.js";
import { getMeta, openDatabase } from "../db/sqlite.js";
import { EMBEDDING_DIM, EMBEDDING_MODEL_NAME } from "../embeddings/embedder.js";
import { describeError, installProcessHandlers } from "../log.js";
import { rebaseLibrary } from "../library/root.js";

/**
 * Point an existing index at a different library root.
 *
 *   pnpm rebase --library=<new root> --db=<index> [--old-root=<previous root>]
 *
 * Every stored source_path is re-expressed relative to the new root, in one
 * transaction. If any document would fall outside it, nothing is written and
 * the offenders are listed. --old-root defaults to the root the index
 * recorded; an index from before roots were recorded needs it spelled out.
 *
 * --db matters: the default index location is inside the library root, so
 * with a new root and no --db this would open (and create) a different, empty
 * index. Moving the whole library folder needs no rebase at all.
 */

async function main(): Promise<void> {
  installProcessHandlers();
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  if (!flags.has("db") && !process.env["DOCUMENT_INDEX_DB_PATH"]) {
    throw new Error(
      "Pass --db=<path to the existing index>. Without it the index is looked for inside the NEW " +
        "root, where there is none.",
    );
  }
  const config = loadConfig(argv);

  const lock = acquireIndexLock(config.dbPath);
  const db = openDatabase(config.dbPath, { embeddingModel: EMBEDDING_MODEL_NAME, embeddingDim: EMBEDDING_DIM });
  try {
    const oldRoot = flags.get("old-root") ?? getMeta(db, "library_root");
    if (!oldRoot) {
      throw new Error("This index never recorded its library root. Pass --old-root=<the root it was built for>.");
    }
    const from = path.resolve(oldRoot);
    process.stderr.write(`index:    ${config.dbPath}\nold root: ${from}\nnew root: ${config.libraryRoot}\n\n`);

    const result = rebaseLibrary(db, from, config.libraryRoot);
    if (result.outside.length > 0) {
      process.stderr.write(
        `refused: ${result.outside.length} document(s) would fall outside the new root, so nothing was changed:\n` +
          result.outside.map((p) => `  ${p}\n`).join("") +
          "\nChoose a root that contains them, or delete_document them first.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`rebased ${result.rebased} document path(s); the index now belongs to the new root\n`);
  } finally {
    db.close();
    lock.release();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`rebase failed: ${describeError(err)}\n`);
  process.exit(1);
});
