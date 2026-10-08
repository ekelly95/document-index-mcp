import { test } from "node:test";
import assert from "node:assert/strict";
import type { DraftChunk } from "./chunker.js";
import { looksLikeReferenceList, markReferences } from "./references.js";

const REFS =
  "13. Burd NA and De Lisio M. Skeletal muscle remodeling: interconnections between stem cells " +
  "and protein turnover. Exercise and sport sciences reviews 45: 187-191, 2017. 14. Burke LM, " +
  "Hawley JA, Wong SH, and Jeukendrup AE. Carbohydrates for training and competition. Journal of " +
  "sports sciences 29: S17-S27, 2011. 15. Cermak NM et al. Protein supplementation augments the " +
  "adaptive response. The American journal of clinical nutrition 96: 1454-1464, 2012.";

const PROSE =
  "Endurance athletes need between 1.2 and 1.4 g/kg of protein per day, with higher intakes " +
  "recommended during periods of high volume training, as shown by Larson et al., 2018.";

const chunk = (text: string, sectionPath: string[] = ["Protein"], kind: DraftChunk["kind"] = "text"): DraftChunk => ({
  kind,
  locator: { type: "page", value: "30", ordinal: 29 },
  sectionPath,
  bbox: null,
  text,
  overlapPrefix: null,
  tokenCount: 50,
});

async function run(chunks: DraftChunk[]): Promise<string[]> {
  const out: string[] = [];
  for await (const c of markReferences((async function* () { yield* chunks; })())) out.push(c.kind);
  return out;
}

test("a citation-dense passage is a reference list; prose citing one source is not", () => {
  assert.ok(looksLikeReferenceList(REFS));
  assert.ok(!looksLikeReferenceList(PROSE));
});

test("chunks are retyped by density, by heading, and when sandwiched between references", async () => {
  const weak = "A long title-heavy entry with no volume or year on this line of the list at all, continuing.";
  assert.deepEqual(
    await run([
      chunk(PROSE),
      chunk(REFS),
      chunk(weak), // sandwiched
      chunk(REFS),
      chunk(PROSE, ["References"]), // under the heading
      chunk("| a | b |", ["References"], "table"), // tables keep their kind
      chunk(PROSE, ["Appendix"]),
    ]),
    ["text", "references", "references", "references", "references", "table", "text"],
  );
});

test("a weak chunk after the last reference stays what it was", async () => {
  assert.deepEqual(await run([chunk(REFS), chunk(PROSE)]), ["references", "text"]);
});
