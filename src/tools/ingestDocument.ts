import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { beginIngest } from "../ingest/runner.js";
import { FORMATS } from "./shapes.js";
import { describeFsError, fail, okStructured } from "./result.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the library root"),
  title: z.string().optional().describe("Overrides the title detected from the file"),
});

const outputSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  format: z.enum(FORMATS),
  status: z.enum(["processing", "ready"]),
  locator_count: z.number().int(),
  reused: z.boolean(),
  warning: z
    .string()
    .nullable()
    .describe("Set when known content was skipped; the index is incomplete"),
});

export function registerIngestDocument(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "ingest_document",
    {
      title: "Ingest Document",
      description:
        "Index a file from the library into the retrieval index. PDF, DOCX, Markdown and " +
        "plain text are ingestible in this build; EPUB, PowerPoint, HTML and legacy binary " +
        "Office (.doc) are recognised and refused with a reason naming the remedy. " +
        "Scanned PDFs are detected and " +
        "OCR'd automatically — expect those to index slowly, a few seconds per page. " +
        "Format is decided by content " +
        "rather than extension, which is why a mislabelled file is still routed correctly. " +
        "Returns immediately with a document_id while indexing " +
        "continues in the background — poll get_document_outline with that id to watch " +
        "chunk_count rise and see when status becomes 'ready'. Re-ingesting an identical " +
        "file is a no-op and returns the existing document_id.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        const handle = await beginIngest(
          ctx,
          args.path,
          args.title === undefined ? {} : { title: args.title },
        );

        // Deliberately not awaited: that is what keeps a 900-page book from
        // blowing the client's request timeout. The rejection IS handled here
        // though — an unhandled rejection would take the whole server process
        // down.
        //
        // The handler used to be empty, on the grounds that the failure is
        // recorded on the document row. It is, but only a caller who polls
        // get_document_outline for this exact id will ever see it, and nothing
        // prompts them to. The runner logs the cause; this catch exists to
        // keep the process alive, so it stays quiet rather than saying the
        // same thing twice.
        handle.done.catch(() => {});

        const reused = handle.outcome === "reused";
        const payload = {
          document_id: handle.documentId,
          title: handle.title,
          format: handle.format,
          status: reused ? ("ready" as const) : ("processing" as const),
          locator_count: handle.locatorCount,
          reused,
          warning: handle.warning,
        };

        const text =
          handle.outcome === "reused"
            ? `"${handle.title}" is already indexed (document_id ${handle.documentId}). Nothing to do.`
            : handle.outcome === "joined"
              ? `"${handle.title}" is already being indexed by an earlier call ` +
                `(document_id ${handle.documentId}). Nothing further started. ` +
                `Call get_document_outline with that id to check progress.`
              : `Indexing "${handle.title}" [${handle.format}], ~${handle.locatorCount} section(s). ` +
                `document_id ${handle.documentId}. ` +
                `Call get_document_outline with that id to check progress.`;

        return okStructured(
          handle.warning === null ? text : `${text}\n\nWarning: ${handle.warning}`,
          payload,
        );
      } catch (err) {
        return fail(`ingest_document failed: ${describeFsError(err, args.path)}`);
      }
    },
  );
}
