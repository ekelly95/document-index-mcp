import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listProcessing } from "../db/documentsRepo.js";
import { hybridSearch } from "../retrieval/hybrid.js";
import { CHUNK_KINDS, ChunkRefShape, describeLocation, toChunkRef } from "./shapes.js";
import { describeError, fail, okStructured } from "./result.js";

const inputSchema = z.object({
  query: z.string().min(2),
  document_id: z
    .string()
    .optional()
    .describe("Restrict to one document; omit to search the whole library"),
  k: z.number().int().min(1).max(50).default(10),
  mode: z.enum(["hybrid", "lexical", "semantic"]).default("hybrid"),
  filter: z
    .object({
      kind: z.enum(CHUNK_KINDS).optional(),
      section_prefix: z
        .string()
        .optional()
        .describe(
          "Restrict to a branch of the heading tree. Segments are separated by › (or >) " +
            'and matched level by level, so "Part II" finds "Part II — Methods" but not ' +
            '"Part III — Results". Paste a section path straight from a hit to drill in.',
        ),
      page_range: z
        .tuple([z.number().int(), z.number().int()])
        .optional()
        .describe(
          "[low, high] inclusive, physical 1-based pages. Paginated formats only — md and " +
            "txt documents carry no page number and will never match.",
        ),
    })
    .optional(),
});

const outputSchema = z.object({
  hits: z.array(
    ChunkRefShape.extend({
      document_title: z.string().describe("Title of the source document"),
      source_path: z
        .string()
        .describe("Library-relative path of the source file; disambiguates documents sharing a title"),
      score: z.number().describe("Reciprocal-rank-fusion score; ordering only, not a relevance measure"),
      snippet: z
        .string()
        .describe("<=300 chars; query terms marked with « » when the match was lexical"),
    }),
  ),
  processing_documents: z
    .array(
      z.object({
        document_id: z.string(),
        title: z.string(),
        chunk_count: z.number().int(),
        locator_count: z.number().int(),
      }),
    )
    .describe("Documents still indexing. They were NOT searched, so this result is incomplete."),
});

export function registerSearchDocument(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search_document",
    {
      title: "Search Documents",
      description:
        "Hybrid BM25 + semantic search across ingested documents. Returns ranked snippets " +
        "with precise locators (page or section, section path, bbox). This is the usual " +
        "starting point. It never returns full text — follow a hit with get_chunk_context " +
        "using its chunk_id to read.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        // Checked here rather than in the zod schema so the model gets a result
        // it can act on, the same way get_chunk_context reports a bad
        // addressing form. A reversed range is not a search that finds nothing;
        // it is a call that cannot succeed.
        const range = args.filter?.page_range;
        if (range) {
          const [lo, hi] = range;
          if (lo < 1) {
            return fail(`page_range starts at page 1; got [${lo}, ${hi}].`);
          }
          if (lo > hi) {
            return fail(`page_range must be [low, high] with low <= high; got [${lo}, ${hi}].`);
          }
        }

        const hits = await hybridSearch(ctx.db, ctx.embedder, {
          query: args.query,
          ...(args.document_id === undefined ? {} : { documentId: args.document_id }),
          k: args.k,
          mode: args.mode,
          ...(args.filter === undefined
            ? {}
            : {
                filter: {
                  ...(args.filter.kind === undefined ? {} : { kind: args.filter.kind }),
                  ...(args.filter.section_prefix === undefined
                    ? {}
                    : { sectionPrefix: args.filter.section_prefix }),
                  ...(args.filter.page_range === undefined
                    ? {}
                    : { pageRange: args.filter.page_range }),
                },
              }),
        });

        // Search only covers finished documents, so a document still indexing
        // is a hole in the corpus. Saying so is the half that matters: without
        // it, "no matches" is indistinguishable from "the library does not
        // cover this", which is exactly the confusion the PDF probe refuses to
        // create at ingest time.
        const processing = listProcessing(ctx.db);
        const payload = {
          hits: hits.map((h) => ({
            ...toChunkRef(h.row),
            document_title: h.row.document_title,
            source_path: h.row.source_path,
            score: h.score,
            snippet: h.snippet,
          })),
          processing_documents: processing.map((d) => ({
            document_id: d.id,
            title: d.title,
            chunk_count: d.chunk_count,
            locator_count: d.locator_count,
          })),
        };

        const caveat =
          processing.length === 0
            ? ""
            : `\n\n_Not searched — still indexing, so this result is incomplete. ` +
              `Call again shortly._\n` +
              processing
                .map(
                  (d) =>
                    `  - "${d.title}" (${d.chunk_count} chunks so far, ~${d.locator_count} ${d.locator_scheme}s expected) — ${d.id}`,
                )
                .join("\n");

        if (payload.hits.length === 0) {
          return okStructured(
            `No matches for "${args.query}".` +
              (args.document_id ? " Try omitting document_id to search the whole library." : "") +
              caveat,
            payload,
          );
        }

        const lines = payload.hits.map(
          (h, i) =>
            `${i + 1}. ${h.document_title} — ${describeLocation(h)}\n   ${h.snippet}\n   chunk_id: ${h.chunk_id} (seq ${h.seq})`,
        );
        return okStructured(
          `${payload.hits.length} hit(s). Read one with get_chunk_context.\n\n${lines.join("\n\n")}${caveat}`,
          payload,
        );
      } catch (err) {
        return fail(`search_document failed: ${describeError(err)}`);
      }
    },
  );
}
