import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { deleteDocument, getDocument, type DocumentRow } from "../db/documentsRepo.js";
import { describeError, fail, okStructured } from "./result.js";

const inputSchema = z.object({
  document_id: z.string().describe("From get_document_outline's library listing"),
});

const outputSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  source_path: z.string(),
  chunks_removed: z.number().int(),
});

export function registerDeleteDocument(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "delete_document",
    {
      title: "Delete Document",
      description:
        "Remove a document from the index: its chunks, its full-text entries and its " +
        "vectors. The source file on disk is never touched. Use it to drop something " +
        "ingested by mistake — an edited file does NOT need this, because re-ingesting " +
        "one already replaces the version it supersedes. Deletion is permanent; the " +
        "document's chunk_ids stop resolving, and re-ingesting the file rebuilds it.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        // One synchronous transaction: better-sqlite3 does not yield inside
        // one, so the re-read and the delete cannot be separated by an ingest
        // claiming the same document in between.
        type Result =
          | { ok: false; reason: string }
          | { ok: true; doc: DocumentRow };

        const result = ctx.db.transaction((): Result => {
          const doc = getDocument(ctx.db, args.document_id);
          if (!doc) {
            return { ok: false, reason: `Unknown document_id "${args.document_id}".` };
          }

          // 'processing' means a live writer owns this row (see beginIngest);
          // deleting it underneath would leave that writer inserting chunks
          // against a document that no longer exists. Refusing is instant and
          // honest — waiting would mean blocking the call for a whole index.
          if (doc.ingest_status === "processing") {
            return {
              ok: false,
              reason:
                `"${doc.title}" is still being indexed (${doc.chunk_count} chunks so far). ` +
                `Wait for get_document_outline to report it ready, then delete.`,
            };
          }

          deleteDocument(ctx.db, doc.id);
          return { ok: true, doc };
        })();

        if (!result.ok) return fail(result.reason);

        const { doc } = result;
        const payload = {
          document_id: doc.id,
          title: doc.title,
          source_path: doc.source_path,
          chunks_removed: doc.chunk_count,
        };
        return okStructured(
          `Deleted "${doc.title}" (${doc.source_path}) — ${doc.chunk_count} chunk(s) removed ` +
            `from the chunk, full-text and vector indexes. The file itself is untouched.`,
          payload,
        );
      } catch (err) {
        return fail(`delete_document failed: ${describeError(err)}`);
      }
    },
  );
}
