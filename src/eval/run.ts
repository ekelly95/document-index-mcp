import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { hybridSearch, DEFAULT_FUSION, type FusionTuning } from "../retrieval/hybrid.js";
import { installProcessHandlers } from "../log.js";
import {
  loadQuestionSet,
  resolveGroundTruth,
  type Question,
  type ResolvedQuestion,
} from "./groundTruth.js";
import { report, type ModeScore, type QuestionResult } from "./report.js";

/**
 * Retrieval relevance evaluation.
 *
 *   pnpm eval --library=<corpus> --questions=eval/questions.json
 *
 * This exists because the test suite proves the machinery is deterministic and
 * correctly filtered, which is a different claim from the ranking being good.
 * Nothing in `src/**\/*.test.ts` would notice hybrid search getting steadily
 * worse at answering real questions, and a hand-run spot check on 2026-08-13
 * found exactly that: the shipped hybrid default scored below its own semantic
 * leg at ranks 1 and 3.
 *
 * The numbers this prints are the only defensible basis for tuning fusion, and
 * freezing them is what stops a later change quietly undoing the tuning.
 */

const MODES = ["lexical", "semantic", "hybrid"] as const;
type Mode = (typeof MODES)[number];

/**
 * How deep to search. Recall is reported at 1, 3 and 5; the extra depth exists
 * so mean reciprocal rank can distinguish "ranked 7th" from "absent", which
 * matters when judging whether a tuning change is moving in the right
 * direction before it starts winning outright.
 */
const DEFAULT_K = 10;

interface Options {
  questionsPath: string;
  k: number;
  modes: Mode[];
  json: boolean;
  /** Grid-search the fusion constants instead of scoring the shipped default. */
  sweep: boolean;
  /** Print every miss with the hits that beat the answer. */
  verbose: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    if (key) flags.set(key, value ?? "true");
  }

  const rawK = flags.get("k");
  const k = rawK === undefined ? DEFAULT_K : Number(rawK);
  if (!Number.isInteger(k) || k < 5) {
    throw new Error(`Invalid --k ${JSON.stringify(rawK)}: expected an integer >= 5.`);
  }

  const rawModes = flags.get("modes");
  const modes = rawModes === undefined ? [...MODES] : rawModes.split(",").map((m) => m.trim());
  for (const m of modes) {
    if (!MODES.includes(m as Mode)) {
      throw new Error(`Unknown mode ${JSON.stringify(m)}: expected ${MODES.join(", ")}.`);
    }
  }

  return {
    questionsPath: path.resolve(flags.get("questions") ?? "eval/questions.json"),
    k,
    modes: modes as Mode[],
    json: flags.has("json"),
    sweep: flags.has("sweep"),
    verbose: flags.has("verbose"),
  };
}

/**
 * Score one mode over every resolved question.
 *
 * Rank is 1-based and counts the first acceptable chunk. A question whose
 * answer never appears contributes 0 to every recall figure and 0 to MRR,
 * which is the standard convention and the reason `k` is larger than the
 * deepest reported recall.
 */
async function scoreMode(
  ctx: ReturnType<typeof createContext>,
  questions: readonly ResolvedQuestion[],
  mode: Mode,
  k: number,
  fusion?: FusionTuning,
): Promise<{ score: ModeScore; results: QuestionResult[] }> {
  const results: QuestionResult[] = [];

  for (const q of questions) {
    const hits = await hybridSearch(ctx.db, ctx.embedder, {
      query: q.question.question,
      k,
      mode,
      ...(fusion ? { fusion } : {}),
    });

    const rank = hits.findIndex((h) => q.acceptableChunkIds.has(h.row.id)) + 1;
    results.push({
      id: q.question.id,
      type: q.question.type,
      rank: rank === 0 ? null : rank,
      topHit:
        hits[0] === undefined
          ? null
          : `${hits[0].row.source_path} — ${hits[0].row.locator_value}`,
    });
  }

  const found = (n: number) => results.filter((r) => r.rank !== null && r.rank <= n).length;
  const total = results.length || 1;

  return {
    score: {
      mode,
      questions: results.length,
      recallAt1: found(1) / total,
      recallAt3: found(3) / total,
      recallAt5: found(5) / total,
      mrr: results.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / total,
    },
    results,
  };
}

/**
 * Grid-search the fusion constants against the question set.
 *
 * The semantic-only score is printed first and is the bar to clear: hybrid
 * beating lexical proves nothing, because it contains the lexical leg. The
 * shipped default has to beat the better of the two legs it fuses, or fusing
 * is costing accuracy for no reason.
 */
async function sweep(
  ctx: ReturnType<typeof createContext>,
  questions: readonly ResolvedQuestion[],
  k: number,
): Promise<void> {
  const out = process.stdout;
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(6);

  for (const mode of ["lexical", "semantic"] as const) {
    const { score } = await scoreMode(ctx, questions, mode, k);
    out.write(
      `${(`${mode} only`).padEnd(26)}${pct(score.recallAt1)}${pct(score.recallAt3)}${pct(score.recallAt5)}   ${score.mrr.toFixed(3)}\n`,
    );
  }
  out.write(`${"-".repeat(58)}\n`);
  out.write(`${"fusion (k, lex, sem)".padEnd(26)}${"R@1".padStart(6)}${"R@3".padStart(6)}${"R@5".padStart(6)}      MRR\n`);

  const grid: FusionTuning[] = [];
  for (const fk of [0, 2, 5, 10, 20, 60]) {
    for (const [lex, sem] of [
      [1, 1],
      [1, 1.5],
      [1, 2],
      [0.5, 1],
    ] as const) {
      grid.push({ k: fk, lexicalWeight: lex, semanticWeight: sem });
    }
  }

  let best: { tuning: FusionTuning; score: ModeScore } | null = null;
  for (const tuning of grid) {
    const { score } = await scoreMode(ctx, questions, "hybrid", k, tuning);
    const label = `k=${tuning.k} lex=${tuning.lexicalWeight} sem=${tuning.semanticWeight}`;
    const isDefault =
      tuning.k === DEFAULT_FUSION.k &&
      tuning.lexicalWeight === DEFAULT_FUSION.lexicalWeight &&
      tuning.semanticWeight === DEFAULT_FUSION.semanticWeight;
    out.write(
      `${(label + (isDefault ? "  <- shipped" : "")).padEnd(26)}${pct(score.recallAt1)}${pct(score.recallAt3)}${pct(score.recallAt5)}   ${score.mrr.toFixed(3)}\n`,
    );
    // Ranked by MRR rather than by any single recall figure: recall@1 alone
    // rewards a configuration that gets a handful of questions exactly right
    // and buries the rest.
    if (best === null || score.mrr > best.score.mrr) best = { tuning, score };
  }

  if (best) {
    out.write(
      `\nbest by MRR: k=${best.tuning.k} lex=${best.tuning.lexicalWeight} sem=${best.tuning.semanticWeight}` +
        ` (R@1 ${pct(best.score.recallAt1).trim()}, R@3 ${pct(best.score.recallAt3).trim()}, MRR ${best.score.mrr.toFixed(3)})\n`,
    );
  }
}

async function main(): Promise<void> {
  installProcessHandlers();
  const argv = process.argv.slice(2);
  const opts = parseOptions(argv);
  const config = loadConfig(argv);

  if (!fs.existsSync(opts.questionsPath)) {
    throw new Error(`No question set at ${opts.questionsPath}. Pass --questions=<path>.`);
  }
  const set = loadQuestionSet(opts.questionsPath);

  // Not requireIndexLock: an evaluation only reads, and refusing to run while
  // a server is up would make this unusable for the thing it is for — checking
  // a tuning change against the index you already have.
  const ctx = createContext(config);

  try {
    const { resolved, unresolvable } = resolveGroundTruth(ctx.db, set.questions);

    // Loudly, and before any score is printed. An anchor that no longer matches
    // any chunk scores as a miss in every mode, so a re-ingest that changed
    // chunking would otherwise read as a catastrophic retrieval regression
    // rather than as a question set needing its anchors refreshed.
    if (unresolvable.length > 0) {
      process.stderr.write(
        `\n${unresolvable.length} question(s) have no matching chunk and were EXCLUDED from scoring:\n`,
      );
      for (const u of unresolvable) {
        process.stderr.write(`  ${u.question.id}  ${u.reason}\n`);
      }
      process.stderr.write(
        "\nRefresh their anchors against the current index before trusting a comparison.\n\n",
      );
    }

    if (resolved.length === 0) {
      throw new Error("No question resolved to a chunk. Is this the right index?");
    }

    if (opts.sweep) {
      await sweep(ctx, resolved, opts.k);
      return;
    }

    const scores: ModeScore[] = [];
    const byMode = new Map<Mode, QuestionResult[]>();
    for (const mode of opts.modes) {
      const { score, results } = await scoreMode(ctx, resolved, mode, opts.k);
      scores.push(score);
      byMode.set(mode, results);
    }

    report({
      set,
      scores,
      byMode,
      resolved,
      unresolvable,
      json: opts.json,
      verbose: opts.verbose,
      k: opts.k,
    });
  } finally {
    ctx.db.close();
    ctx.lock.release();
  }

  // Explicit, as the bulk CLI does: the ONNX runtime behind the embedder keeps
  // handles open that would otherwise leave the process alive after the report
  // has been printed.
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

export type { Question, Mode };
