import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FUSION,
  fuseRankings,
  sectionPathMatches,
  semanticSnippet,
  toFtsQuery,
} from "./hybrid.js";

/**
 * The pure parts of retrieval: query sanitisation, the section-path filter and
 * snippet selection. All three are exported precisely so they can be pinned
 * here without standing up a database and a 130MB embedding model.
 */

const METHODS = ["Part II — Methods", "3.2 Sampling"];
const RESULTS = ["Part III — Results"];

test("section_prefix does not leak across a segment boundary", () => {
  // The regression this filter was rewritten for. Joined with " › " and
  // compared with startsWith, "Part III — Results" begins with "Part II", so a
  // filter naming Part II returned the whole of Part III as well.
  assert.equal(sectionPathMatches(METHODS, "Part II"), true);
  assert.equal(sectionPathMatches(RESULTS, "Part II"), false);
  assert.equal(sectionPathMatches(RESULTS, "Part III"), true);
});

test("section_prefix matches a heading by its opening words", () => {
  assert.equal(sectionPathMatches(METHODS, "Part II — Methods"), true);
  assert.equal(sectionPathMatches(METHODS, "Part"), true);
  // ...but only up to a word boundary, so numbering cannot bleed.
  assert.equal(sectionPathMatches(["3.25 Weighting"], "3.2"), false);
  assert.equal(sectionPathMatches(["3.2 Sampling"], "3.2"), true);
});

test("section_prefix descends level by level", () => {
  assert.equal(sectionPathMatches(METHODS, "Part II › 3.2"), true);
  assert.equal(sectionPathMatches(METHODS, "Part II › 3.1"), false);
  assert.equal(sectionPathMatches(METHODS, "Part III › 3.2"), false);
  // A filter deeper than the path cannot match it.
  assert.equal(sectionPathMatches(["Part II — Methods"], "Part II › 3.2"), false);
});

test("section_prefix accepts a plain > and is case-insensitive", () => {
  assert.equal(sectionPathMatches(METHODS, "part ii > 3.2 sampling"), true);
  assert.equal(sectionPathMatches(METHODS, "PART II"), true);
});

test("an empty section_prefix filters nothing out", () => {
  assert.equal(sectionPathMatches(METHODS, ""), true);
  assert.equal(sectionPathMatches([], ""), true);
  // A chunk before the first heading has no path, so it can only match nothing.
  assert.equal(sectionPathMatches([], "Part II"), false);
});

test("toFtsQuery quotes every term and never emits bare operators", () => {
  assert.equal(toFtsQuery("stratified sampling"), '"stratified" OR "sampling"');
  // NEAR, quotes, hyphens and apostrophes are FTS5 syntax; raw text would be a
  // parse error rather than a search.
  assert.equal(toFtsQuery("NEAR(a b)"), '"NEAR" OR "a" OR "b"');
  assert.equal(toFtsQuery(`the author's "framing"`), '"the" OR "author\'s" OR "framing"');
  assert.equal(toFtsQuery("!!!"), "");
});

test("semanticSnippet centres on the most query-relevant sentence", () => {
  const filler = "This sentence is about something else entirely. ".repeat(12);
  const target = "The stratified sampling frame came from the enrolment register. ";
  const text = `${filler}${target}${filler}`;

  const snippet = semanticSnippet(text, "stratified sampling frame");
  assert.ok(snippet.includes("stratified sampling frame"), snippet);
  assert.ok(snippet.length <= 302, `snippet was ${snippet.length} chars`);
});

test("semanticSnippet survives text that opens with punctuation", () => {
  // The sentence pattern needs a non-terminator to start a match, so a leading
  // run of ".!?" is not part of any sentence. The old running-offset version
  // never counted those characters, and every offset after them was short by
  // that much — sliding the window off the sentence it had just chosen. The
  // run is long here only to make the miss unambiguous; any length drifts.
  const lead = "?!.".repeat(60);
  const filler = "This sentence is about something else entirely. ".repeat(12);
  const target = "The stratified sampling frame came from the enrolment register. ";
  const text = `${lead}${filler}${target}${filler}`;

  const snippet = semanticSnippet(text, "stratified sampling frame");
  assert.ok(snippet.includes("stratified sampling frame"), snippet);
});

test("semanticSnippet falls back to the passage head when nothing matches", () => {
  const text = "Nothing here relates to the question at all. ".repeat(20);
  const snippet = semanticSnippet(text, "photosynthesis chlorophyll");
  assert.ok(snippet.startsWith("Nothing here relates"), snippet);
  assert.ok(snippet.endsWith("…"));
});

test("semanticSnippet returns short passages untouched", () => {
  assert.equal(semanticSnippet("Short enough.", "anything"), "Short enough.");
});

/**
 * Fusion. These pin the *property* the tuning was chosen for rather than the
 * constants themselves, so a future retune is free to move the numbers as long
 * as it does not reintroduce the failure.
 */

/** Ranked first by the semantic leg, absent from the lexical one. */
const CONVICTION = 100;
/** Ranked eighth by both legs. */
const AGREEMENT = 200;

test("a leg's top hit outranks a chunk both legs merely noticed", () => {
  // The regression that made hybrid search worse than the semantic leg it
  // contains. At the textbook k = 60, ranks 1 and 8 differ by under 8%, so any
  // chunk appearing in both lists outscored any chunk either list was certain
  // about — fusion voting on agreement rather than ranking on conviction. With
  // the lexical leg answering 12% of paraphrased questions, that vote was
  // mostly noise, and it dragged hybrid from 60% down to 32% on those.
  const lexical = [1, 2, 3, 4, 5, 6, 7, AGREEMENT];
  const semantic = [CONVICTION, 11, 12, 13, 14, 15, 16, AGREEMENT];

  const ranked = fuseRankings(lexical, semantic, DEFAULT_FUSION);
  assert.equal(ranked[0]?.[0], CONVICTION, "agreement outvoted conviction again");

  // And the failure itself, so the test is demonstrably testing something.
  const old = fuseRankings(lexical, semantic, { k: 60, lexicalWeight: 1, semanticWeight: 1 });
  assert.equal(old[0]?.[0], AGREEMENT);
});

test("the lexical leg still wins outright when only it finds a match", () => {
  // Weighting the semantic leg up must not silence the lexical one: exact
  // identifiers and quoted phrases are the case it is better at, and the
  // evaluation set holds recall@3 for those at 75% against semantic's 50%.
  const ranked = fuseRankings([42, 43], [], DEFAULT_FUSION);
  assert.deepEqual(ranked.map(([id]) => id), [42, 43]);
});

test("fusion is stable and order-independent for equal scores", () => {
  // Same score, so the rowid tiebreak decides — a fixed query over a fixed
  // corpus must not reorder between runs.
  const ranked = fuseRankings([7, 3], [3, 7], { k: 10, lexicalWeight: 1, semanticWeight: 1 });
  assert.deepEqual(ranked.map(([id]) => id), [3, 7]);
});

test("a zero-weighted leg contributes nothing", () => {
  const ranked = fuseRankings([1, 2], [9], { k: 10, lexicalWeight: 0, semanticWeight: 1 });
  assert.deepEqual(ranked.map(([id]) => id), [9]);
});
