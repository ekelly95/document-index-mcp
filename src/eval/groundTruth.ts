import fs from "node:fs";
import { z } from "zod";
import type { Db } from "../db/sqlite.js";

/**
 * Ground truth that survives a re-ingest.
 *
 * The obvious way to record "this chunk answers that question" is to write the
 * chunk_id down. It does not work here: chunk ids are ULIDs minted at ingest,
 * so every re-ingest invalidates the whole question set — and this project
 * re-ingests on every schema bump by design, because it has no migration
 * machinery.
 *
 * So a question names a document by its library-relative path, which is stable,
 * and a distinctive phrase that must appear in the answering chunk. Resolution
 * happens at run time against whatever index is in front of us. If the chunker
 * changes and splits a phrase across two chunks, the anchor simply stops
 * matching and the question is reported as unresolvable rather than silently
 * scoring zero.
 */

const AcceptSchema = z.object({
  /** Library-relative path, exactly as `documents.source_path` stores it. */
  source_path: z.string().min(1),
  /**
   * A verbatim phrase from the answering chunk. Matched after collapsing
   * whitespace and lowercasing, because a chunker is free to re-wrap lines
   * without changing what the passage says.
   */
  anchor: z.string().min(8),
});

const QuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  /**
   * What this question is testing. Reported as a breakdown, because the whole
   * point of the exercise is that the modes fail differently: the lexical leg
   * is strong on identifiers and weak on paraphrase, and an aggregate hides it.
   */
  type: z.enum(["prose", "table", "identifier", "paraphrase", "navigational", "ambiguous"]),
  accept: z.array(AcceptSchema).min(1),
  note: z.string().optional(),
});

const QuestionSetSchema = z.object({
  corpus: z.string(),
  notes: z.string().optional(),
  questions: z.array(QuestionSchema).min(1),
});

export type Accept = z.infer<typeof AcceptSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionSet = z.infer<typeof QuestionSetSchema>;

export interface ResolvedQuestion {
  question: Question;
  /** `document_chunks.id` values, any one of which counts as a correct hit. */
  acceptableChunkIds: Set<number>;
}

export interface UnresolvableQuestion {
  question: Question;
  reason: string;
}

export function loadQuestionSet(file: string): QuestionSet {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = QuestionSetSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${file} is not a valid question set:\n${z.prettifyError(result.error)}`);
  }

  const seen = new Set<string>();
  for (const q of result.data.questions) {
    if (seen.has(q.id)) throw new Error(`Duplicate question id ${JSON.stringify(q.id)}.`);
    seen.add(q.id);
  }
  return result.data;
}

/** Lowercase and collapse every run of whitespace to one space. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

interface ChunkTextRow {
  id: number;
  text: string;
}

export function resolveGroundTruth(
  db: Db,
  questions: readonly Question[],
): { resolved: ResolvedQuestion[]; unresolvable: UnresolvableQuestion[] } {
  // One query per distinct document rather than per question: several questions
  // routinely share a source, and the alternative re-reads a book's chunk text
  // once per question asked about it.
  const chunkCache = new Map<string, ChunkTextRow[] | null>();
  const selectChunks = db.prepare(
    `SELECT c.id AS id, c.text AS text
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE d.source_path = ? AND d.ingest_status = 'ready'
      ORDER BY c.seq`,
  );

  const chunksFor = (sourcePath: string): ChunkTextRow[] | null => {
    const cached = chunkCache.get(sourcePath);
    if (cached !== undefined) return cached;
    const rows = selectChunks.all(sourcePath) as ChunkTextRow[];
    const value = rows.length === 0 ? null : rows;
    chunkCache.set(sourcePath, value);
    return value;
  };

  const resolved: ResolvedQuestion[] = [];
  const unresolvable: UnresolvableQuestion[] = [];

  for (const question of questions) {
    const acceptableChunkIds = new Set<number>();
    const problems: string[] = [];

    for (const accept of question.accept) {
      const rows = chunksFor(accept.source_path);
      if (rows === null) {
        problems.push(`no ready document at ${accept.source_path}`);
        continue;
      }
      const needle = normalise(accept.anchor);
      const matches = rows.filter((r) => normalise(r.text).includes(needle));
      if (matches.length === 0) {
        problems.push(
          `anchor ${JSON.stringify(accept.anchor.slice(0, 40))} matches no chunk in ${accept.source_path}`,
        );
        continue;
      }
      for (const m of matches) acceptableChunkIds.add(m.id);
    }

    if (acceptableChunkIds.size === 0) {
      unresolvable.push({ question, reason: problems.join("; ") });
    } else {
      resolved.push({ question, acceptableChunkIds });
    }
  }

  return { resolved, unresolvable };
}
