import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { getDocument, listDocuments } from "../db/documentsRepo.js";
import { pruneOutline, type OutlineNode } from "../pipeline/outline.js";
import { FORMATS, LOCATOR_TYPES } from "./shapes.js";
import { describeError, fail, okStructured } from "./result.js";

const inputSchema = z.object({
  document_id: z
    .string()
    .optional()
    .describe("Omit to list every ingested document with its status"),
  max_depth: z.number().int().min(1).max(6).default(3),
});

const OutlineNodeShape = z.object({
  title: z.string(),
  level: z.number().int(),
  locator: z.object({
    type: z.enum(LOCATOR_TYPES),
    value: z.string(),
    ordinal: z.number().int(),
    printed_label: z.string().nullable(),
  }),
  chunk_seq_start: z.number().int(),
  chunk_seq_end: z.number().int(),
  // Recursive. z.lazy would validate the nesting, but it also has to survive
  // conversion to JSON Schema for tools/list; z.any() keeps the handshake
  // simple and the nesting is produced by our own builder, not by a caller.
  children: z.array(z.any()),
});

const outputSchema = z.object({
  documents: z
    .array(
      z.object({
        document_id: z.string(),
        title: z.string(),
        format: z.enum(FORMATS),
        ingest_status: z.enum(["pending", "processing", "ready", "failed"]),
        chunk_count: z.number().int(),
        locator_count: z.number().int(),
        ingest_warning: z
          .string()
          .nullable()
          .describe("Set when known content was skipped at ingest; the index is incomplete"),
      }),
    )
    .optional(),
  document_id: z.string().optional(),
  title: z.string().optional(),
  format: z.enum(FORMATS).optional(),
  locator_scheme: z.enum(LOCATOR_TYPES).optional(),
  locator_count: z.number().int().optional(),
  chunk_count: z.number().int().optional(),
  ingest_status: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  error_message: z.string().nullable().optional(),
  ingest_warning: z.string().nullable().optional(),
  entries: z.array(OutlineNodeShape).optional(),
});

export function registerGetDocumentOutline(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_document_outline",
    {
      title: "Get Document Outline",
      description:
        "Hierarchical heading tree with locators and chunk seq spans. Costs almost no " +
        "context — use it to orient before targeted get_chunk_context reads, and jump " +
        "straight to a section with document_id + chunk_seq_start. Never returns body text. " +
        "Call it with no document_id to list the library. It also reports ingest progress: " +
        "a document still being indexed shows status 'processing' with a rising chunk_count.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        if (!args.document_id) {
          const docs = listDocuments(ctx.db);
          const payload = {
            documents: docs.map((d) => ({
              document_id: d.id,
              title: d.title,
              format: d.format,
              ingest_status: d.ingest_status,
              chunk_count: d.chunk_count,
              locator_count: d.locator_count,
              ingest_warning: d.ingest_warning,
            })),
          };
          const text =
            docs.length === 0
              ? "No documents ingested yet. Use ingest_document with a path relative to the library root."
              : docs
                  .map(
                    (d) =>
                      `- ${d.title} [${d.format}] ${d.ingest_status} — ${d.chunk_count} chunks — ${d.id}` +
                      (d.ingest_warning === null ? "" : " — warning: indexed incomplete"),
                  )
                  .join("\n");
          return okStructured(text, payload);
        }

        const doc = getDocument(ctx.db, args.document_id);
        if (!doc) return fail(`Unknown document_id "${args.document_id}".`);

        if (doc.ingest_status !== "ready") {
          const payload = {
            document_id: doc.id,
            title: doc.title,
            format: doc.format,
            ingest_status: doc.ingest_status,
            chunk_count: doc.chunk_count,
            locator_count: doc.locator_count,
            error_message: doc.error_message,
            ingest_warning: doc.ingest_warning,
            entries: [],
          };
          const text =
            doc.ingest_status === "processing"
              ? `"${doc.title}" is still indexing — ${doc.chunk_count} chunks so far ` +
                `(~${doc.locator_count} sections expected). Call again shortly.`
              : `"${doc.title}" is ${doc.ingest_status}.` +
                (doc.error_message ? ` ${doc.error_message}` : "");
          return okStructured(text, payload);
        }

        const full = JSON.parse(doc.outline_json) as OutlineNode[];
        const entries = pruneOutline(full, args.max_depth);

        const payload = {
          document_id: doc.id,
          title: doc.title,
          format: doc.format,
          locator_scheme: doc.locator_scheme,
          locator_count: doc.locator_count,
          chunk_count: doc.chunk_count,
          ingest_status: doc.ingest_status,
          ingest_warning: doc.ingest_warning,
          entries,
        };

        const header =
          `${doc.title} [${doc.format}] — ${doc.chunk_count} chunks across ` +
          `${doc.locator_count} ${doc.locator_scheme}(s)` +
          (doc.ingest_warning === null ? "" : `\n\nWarning: ${doc.ingest_warning}`);
        const body =
          entries.length === 0
            ? "(no headings detected — read from seq 0 with get_chunk_context)"
            : renderOutline(entries, 0).join("\n");

        return okStructured(`${header}\n\n${body}`, payload);
      } catch (err) {
        return fail(`get_document_outline failed: ${describeError(err)}`);
      }
    },
  );
}

function renderOutline(nodes: readonly OutlineNode[], depth: number): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(
      `${"  ".repeat(depth)}- ${node.title}  [seq ${node.chunk_seq_start}–${node.chunk_seq_end}, ` +
        `${node.locator.type} ${node.locator.value}]`,
    );
    out.push(...renderOutline(node.children, depth + 1));
  }
  return out;
}
