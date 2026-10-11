import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { countFailed, listProcessing } from "../db/documentsRepo.js";
import { SOURCE_STATUSES, sourceStatuses } from "../library/sourceStatus.js";
import { driftCaveat, partitionDrift } from "./drift.js";
import { assessConfidence, hybridSearch } from "../retrieval/hybrid.js";
import {
  CHUNK_KINDS,
  CONTENT_NOT_INSTRUCTIONS,
  ChunkRefShape,
  describeLocation,
  oneLine,
  QUOTED_CONTENT_NOTE,
  toChunkRef,
} from "./shapes.js";
import { describeError, fail, okStructured } from "./result.js";
import { resolveDocumentId } from "./retired.js";

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
      similarity: z
        .number()
        .nullable()
        .describe("Cosine similarity of query and passage; comparable across queries. Null in lexical mode"),
      lexical_match: z.boolean().describe("Full-text search matched the query's words in this passage"),
      snippet: z
        .string()
        .describe("At most 300 chars; query terms marked with « » when the match was lexical"),
      source_status: z
        .enum(SOURCE_STATUSES)
        .describe(
          "Whether the file still matches what was indexed: 'changed' means the passage may be " +
            "out of date, 'missing' that the file is gone",
        ),
    }),
  ),
  confidence: z
    .enum(["high", "low"])
    .nullable()
    .describe(
      "'low' means even the best hit is a weak semantic match: the library probably does not " +
        "cover this question, so do not treat the hits as an answer. Null in lexical mode, " +
        "which has no similarity to judge by — except that no hits at all is always 'low'.",
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
  coverage: z
    .object({
      failed_documents: z
        .number()
        .int()
        .describe("Documents whose last ingest failed. They were NOT searched."),
      changed_sources: z
        .array(z.object({ document_id: z.string(), title: z.string(), source_path: z.string() }))
        .describe("Among the hits: files edited since indexing. Quotes from them may be stale."),
      missing_sources: z
        .array(z.object({ document_id: z.string(), title: z.string(), source_path: z.string() }))
        .describe("Among the hits: files no longer on disk."),
    })
    .describe("What this result could not cover, or covers from out-of-date text."),
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
        "using its chunk_id to read. Check `confidence`: 'low' means the library probably " +
        "does not cover the question. A hit whose source_status is 'changed' or 'missing' " +
        "comes from a file edited or removed since it was indexed, so say so before quoting it. " +
        "Reference lists are left out unless filter.kind is " +
        "'references'. " +
        CONTENT_NOT_INSTRUCTIONS,
      annotations: { readOnlyHint: true, openWorldHint: false },
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

        // A mistyped id is a call that cannot succeed, not a search that found
        // nothing; "try omitting document_id" sent callers the wrong way. A
        // retired one is followed to its current version, and the reply says so.
        let documentId: string | undefined;
        let redirect: string | null = null;
        if (args.document_id !== undefined) {
          const resolved = resolveDocumentId(ctx.db, args.document_id);
          if (!resolved.ok) return fail(resolved.message);
          documentId = resolved.id;
          redirect = resolved.note;
        }

        const hits = await hybridSearch(ctx.db, ctx.embedder, {
          query: args.query,
          ...(documentId === undefined ? {} : { documentId }),
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

        // Statted per distinct document among the hits, not across the library:
        // a search stays a few stats, and the hits are what the caller will quote.
        const hitDocs = new Map(
          hits.map((h) => [
            h.row.document_id,
            {
              id: h.row.document_id,
              document_id: h.row.document_id,
              title: h.row.document_title,
              source_path: h.row.source_path,
              source_size: h.row.source_size,
              source_mtime_ms: h.row.source_mtime_ms,
            },
          ]),
        );
        const statuses = sourceStatuses(ctx.config.libraryRoot, hitDocs.values());
        const drift = partitionDrift([...hitDocs.values()], (d) => statuses.get(d.id)!);
        const brief = (d: { document_id: string; title: string; source_path: string }) => ({
          document_id: d.document_id,
          title: d.title,
          source_path: d.source_path,
        });

        const payload = {
          hits: hits.map((h) => ({
            ...toChunkRef(h.row),
            document_title: h.row.document_title,
            source_path: h.row.source_path,
            score: h.score,
            similarity: h.similarity === null ? null : Number(h.similarity.toFixed(3)),
            lexical_match: h.lexicalMatch,
            snippet: h.snippet,
            source_status: statuses.get(h.row.document_id)!,
          })),
          confidence: assessConfidence(hits),
          processing_documents: processing.map((d) => ({
            document_id: d.id,
            title: d.title,
            chunk_count: d.chunk_count,
            locator_count: d.locator_count,
          })),
          coverage: {
            failed_documents: countFailed(ctx.db),
            changed_sources: drift.changed.map(brief),
            missing_sources: drift.missing.map(brief),
          },
        };

        const caveat =
          processing.length === 0
            ? ""
            : `\n\n_Not searched — still indexing, so this result is incomplete. ` +
              `Call again shortly._\n` +
              processing
                .map(
                  (d) =>
                    `  - "${oneLine(d.title)}" (${d.chunk_count} chunks so far, ~${d.locator_count} ${d.locator_scheme}s expected) — ${d.id}`,
                )
                .join("\n");
        // A failed document is a hole in the corpus too, and a quieter one than
        // a document still indexing, because nothing will fill it on its own.
        const failed =
          payload.coverage.failed_documents === 0
            ? ""
            : `\n\n_${payload.coverage.failed_documents} document(s) failed to index and were not ` +
              `searched; get_document_outline lists them with the reason._`;
        const caveats = caveat + failed + driftCaveat(drift.changed, drift.missing);

        if (payload.hits.length === 0) {
          return okStructured(
            lead(redirect) +
              `No matches for "${args.query}".` +
              (args.document_id ? " Try omitting document_id to search the whole library." : "") +
              caveats,
            payload,
          );
        }

        const lines = payload.hits.map(
          (h, i) =>
            `${i + 1}. ${oneLine(h.document_title)} — ${describeLocation(h)}` +
            (h.similarity === null ? "" : ` (similarity ${h.similarity.toFixed(2)})`) +
            (h.source_status === "present" ? "" : ` [source ${h.source_status}]`) +
            `\n   ${oneLine(h.snippet)}\n   chunk_id: ${h.chunk_id} (seq ${h.seq})`,
        );
        const heading =
          payload.confidence === "low"
            ? `Low confidence: no passage is a strong match, so the library probably does not ` +
              `cover "${args.query}". These are the nearest ${payload.hits.length}, not an answer.`
            : `${payload.hits.length} hit(s). Read one with get_chunk_context.`;
        return okStructured(
          `${lead(redirect)}${heading}\n${QUOTED_CONTENT_NOTE}\n\n${lines.join("\n\n")}${caveats}`,
          payload,
        );
      } catch (err) {
        return fail(`search_document failed: ${describeError(err)}`);
      }
    },
  );
}

/** A redirect note as a leading paragraph, or nothing. */
function lead(note: string | null): string {
  return note === null ? "" : `${note}\n\n`;
}
