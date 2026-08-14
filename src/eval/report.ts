import type { QuestionSet, ResolvedQuestion, UnresolvableQuestion } from "./groundTruth.js";

export interface ModeScore {
  mode: string;
  questions: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
}

export interface QuestionResult {
  id: string;
  type: string;
  /** 1-based rank of the first acceptable chunk, or null if it never appeared. */
  rank: number | null;
  topHit: string | null;
}

export interface ReportInput {
  set: QuestionSet;
  scores: readonly ModeScore[];
  byMode: ReadonlyMap<string, QuestionResult[]>;
  resolved: readonly ResolvedQuestion[];
  unresolvable: readonly UnresolvableQuestion[];
  json: boolean;
  verbose: boolean;
  k: number;
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const pad = (s: string, width: number): string => s.padEnd(width);
const padStart = (s: string, width: number): string => s.padStart(width);

export function report(input: ReportInput): void {
  if (input.json) {
    // Machine-readable, for the regression test and for diffing two runs.
    // `unresolvable` is included deliberately: a comparison between two runs is
    // only meaningful when both resolved the same questions.
    process.stdout.write(
      `${JSON.stringify(
        {
          corpus: input.set.corpus,
          k: input.k,
          scored: input.resolved.length,
          unresolvable: input.unresolvable.map((u) => u.question.id),
          scores: input.scores,
          byType: byTypeTable(input),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const out = process.stdout;
  out.write(`\nCorpus: ${input.set.corpus}\n`);
  out.write(
    `Scored ${input.resolved.length} question(s) at k=${input.k}` +
      (input.unresolvable.length > 0 ? `, ${input.unresolvable.length} excluded` : "") +
      "\n\n",
  );

  out.write(`${pad("Mode", 10)}${padStart("R@1", 7)}${padStart("R@3", 7)}${padStart("R@5", 7)}${padStart("MRR", 8)}\n`);
  out.write(`${"-".repeat(39)}\n`);
  for (const s of input.scores) {
    out.write(
      pad(s.mode, 10) +
        padStart(pct(s.recallAt1), 7) +
        padStart(pct(s.recallAt3), 7) +
        padStart(pct(s.recallAt5), 7) +
        padStart(s.mrr.toFixed(3), 8) +
        "\n",
    );
  }

  // The comparison the tuning work actually turns on. Hybrid is the shipped
  // default, so it losing to a mode it already contains is the finding, not a
  // footnote.
  const hybrid = input.scores.find((s) => s.mode === "hybrid");
  const semantic = input.scores.find((s) => s.mode === "semantic");
  if (hybrid && semantic) {
    const d1 = hybrid.recallAt1 - semantic.recallAt1;
    const d3 = hybrid.recallAt3 - semantic.recallAt3;
    const verdict =
      d1 >= 0 && d3 >= 0
        ? "hybrid is at or above semantic-only at both ranks"
        : "HYBRID LOSES TO ITS OWN SEMANTIC LEG";
    out.write(`\n${verdict} (R@1 ${d1 >= 0 ? "+" : ""}${pct(d1)}, R@3 ${d3 >= 0 ? "+" : ""}${pct(d3)})\n`);
  }

  const byType = byTypeTable(input);
  const types = Object.keys(byType).sort();
  if (types.length > 1) {
    out.write("\nRecall@3 by question type\n");
    out.write(`${pad("Type", 14)}${padStart("n", 4)}`);
    for (const s of input.scores) out.write(padStart(s.mode, 10));
    out.write("\n");
    out.write(`${"-".repeat(18 + input.scores.length * 10)}\n`);
    for (const type of types) {
      const row = byType[type]!;
      out.write(pad(type, 14) + padStart(String(row.n), 4));
      for (const s of input.scores) out.write(padStart(pct(row.recallAt3[s.mode] ?? 0), 10));
      out.write("\n");
    }
  }

  if (input.verbose) {
    for (const s of input.scores) {
      const results = input.byMode.get(s.mode) ?? [];
      const misses = results.filter((r) => r.rank === null || r.rank > 3);
      if (misses.length === 0) continue;
      out.write(`\n${s.mode}: ${misses.length} question(s) outside the top 3\n`);
      for (const m of misses) {
        out.write(
          `  ${pad(m.id, 8)}${pad(m.type, 14)}${m.rank === null ? "absent" : `rank ${m.rank}`}` +
            (m.topHit ? `  (top hit: ${m.topHit})` : "") +
            "\n",
        );
      }
    }
  }
  out.write("\n");
}

interface TypeRow {
  n: number;
  recallAt3: Record<string, number>;
}

function byTypeTable(input: ReportInput): Record<string, TypeRow> {
  const table: Record<string, TypeRow> = {};
  for (const [mode, results] of input.byMode) {
    for (const r of results) {
      const row = (table[r.type] ??= { n: 0, recallAt3: {} });
      if (!(mode in row.recallAt3)) row.recallAt3[mode] = 0;
    }
  }
  for (const [mode, results] of input.byMode) {
    const counts = new Map<string, { hit: number; total: number }>();
    for (const r of results) {
      const c = counts.get(r.type) ?? { hit: 0, total: 0 };
      c.total += 1;
      if (r.rank !== null && r.rank <= 3) c.hit += 1;
      counts.set(r.type, c);
    }
    for (const [type, c] of counts) {
      const row = (table[type] ??= { n: 0, recallAt3: {} });
      row.n = c.total;
      row.recallAt3[mode] = c.hit / c.total;
    }
  }
  return table;
}
