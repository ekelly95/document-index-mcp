import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { bySeq, byChunkId, chunkExists, seqRange, type ChunkRow } from "../db/chunksRepo.js";
import { getDocument } from "../db/documentsRepo.js";
import { describeLocation, ChunkRefShape, toChunkRef } from "./shapes.js";
import { describeError, fail, okStructured } from "./result.js";

/**
 * The only tool that returns body text, and the reason whole-document dumps
 * are impossible. Every read is a bounded window that the caller has to walk
 * deliberately.
 */
const MAX_TOTAL_CHARS = 24_000; // ~6k tokens, about 1.5 screens of context

const inputSchema = z.object({
  chunk_id: z.string().optional().describe("From search_document results"),
  document_id: z.string().optional().describe("With seq, from outline spans"),
  seq: z.number().int().min(0).optional(),
  before: z.number().int().min(0).max(5).default(1),
  after: z.number().int().min(0).max(5).default(1),
});

const outputSchema = z.object({
  document_id: z.string(),
  document_title: z.string().describe("Title of the source document"),
  source_path: z.string().describe("Library-relative path of the source file"),
  chunks: z.array(ChunkRefShape.extend({ text: z.string() })),
  has_more_before: z.boolean(),
  has_more_after: z.boolean(),
});

export function registerGetChunkContext(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_chunk_context",
    {
      title: "Get Chunk Context",
      description:
        "Full text of one chunk plus up to 5 neighbours on each side in reading order. " +
        "Address it by chunk_id (from search results) OR by document_id + seq (from " +
        "outline spans). This is the only tool that returns body text and it is hard-capped " +
        "at ~24k characters — walk seq windows to read progressively.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        if (!args.chunk_id && !(args.document_id && args.seq !== undefined)) {
          return fail("Provide either chunk_id, or document_id together with seq.");
        }

        const anchor = args.chunk_id
          ? byChunkId(ctx.db, args.chunk_id)
          : bySeq(ctx.db, args.document_id!, args.seq!);
        if (!anchor) {
          return fail(
            args.chunk_id
              ? `Unknown chunk_id "${args.chunk_id}".`
              : `No chunk at seq ${args.seq} in document ${args.document_id}.`,
          );
        }

        const lo = Math.max(0, anchor.seq - args.before);
        const hi = anchor.seq + args.after;
        let rows = seqRange(ctx.db, anchor.document_id, lo, hi);

        // DEVIATION from the source spec, which filtered the window with
        // .filter() and a running total. That drops an oversized chunk and
        // then keeps a later small one, returning a NON-CONTIGUOUS window
        // whose seq numbers silently skip. Trim from the edges instead, and
        // never trim away the anchor the caller actually asked for.
        let truncatedBefore = false;
        let truncatedAfter = false;
        const total = (rs: ChunkRow[]) => rs.reduce((s, r) => s + r.text.length, 0);

        while (total(rows) > MAX_TOTAL_CHARS && rows.length > 1 && rows[0]!.seq < anchor.seq) {
          rows.shift();
          truncatedBefore = true;
        }
        while (total(rows) > MAX_TOTAL_CHARS && rows.length > 1) {
          rows.pop();
          truncatedAfter = true;
        }

        // The anchor's existence implies the document row exists (FK, and
        // deletes cascade chunks first), so a miss here is a real bug worth
        // surfacing rather than papering over with placeholders.
        const doc = getDocument(ctx.db, anchor.document_id);
        if (!doc) {
          return fail(`Document ${anchor.document_id} vanished mid-read; re-run the search.`);
        }

        const payload = {
          document_id: anchor.document_id,
          document_title: doc.title,
          source_path: doc.source_path,
          chunks: rows.map((r) => ({ ...toChunkRef(r), text: r.text })),
          has_more_before: lo > 0 || truncatedBefore,
          has_more_after:
            truncatedAfter || chunkExists(ctx.db, anchor.document_id, hi + 1),
        };

        return okStructured(render(payload), payload);
      } catch (err) {
        return fail(`get_chunk_context failed: ${describeError(err)}`);
      }
    },
  );
}

function render(payload: z.infer<typeof outputSchema>): string {
  const header = `${payload.document_title} (${payload.source_path})`;
  const parts = payload.chunks.map(
    (c) => `### [seq ${c.seq}] ${describeLocation(c)}\n\n${c.text}`,
  );
  const hints: string[] = [];
  const first = payload.chunks[0];
  const last = payload.chunks.at(-1);
  if (payload.has_more_before && first) {
    hints.push(`earlier: seq ${Math.max(0, first.seq - 1)}`);
  }
  if (payload.has_more_after && last) hints.push(`later: seq ${last.seq + 1}`);

  const body = parts.join("\n\n---\n\n");
  return hints.length > 0
    ? `${header}\n\n${body}\n\n_(more available — ${hints.join(", ")})_`
    : `${header}\n\n${body}`;
}
