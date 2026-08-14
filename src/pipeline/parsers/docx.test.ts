import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocx, type DocxFixtureSpec } from "../../testing/docxFixture.js";
import { DocxParser } from "./docx.js";
import { routeDocument } from "../router.js";
import { sourceFromBytes } from "../source.js";
import { UnsupportedFormatError, type DocBlock, type DocumentSource } from "../ir.js";

const open = (spec: DocxFixtureSpec, name = "paper.docx"): DocumentSource =>
  sourceFromBytes(`/lib/${name}`, buildDocx(spec));

const collect = async (src: DocumentSource): Promise<DocBlock[]> => {
  const out: DocBlock[] = [];
  for await (const b of new DocxParser().parse(src)) out.push(b);
  return out;
};

test("a DOCX routes to its parser on the pure-TS engine", async () => {
  const route = await routeDocument(open({ blocks: [{ paragraph: "body" }] }));
  assert.equal(route.format, "docx");
  assert.equal(route.engine, "ts-fast");
  assert.ok(route.parser instanceof DocxParser);
});

test("the central directory outranks a misleading extension", async () => {
  const route = await routeDocument(open({ blocks: [{ paragraph: "x" }] }, "mislabelled.pptx"));
  assert.equal(route.format, "docx");
  assert.ok(route.parser instanceof DocxParser);
});

test("styles translate to their DocBlock kinds", async () => {
  const blocks = await collect(
    open({
      blocks: [
        { heading: "Top", level: 1 },
        { paragraph: "Prose." },
        { bullets: ["alpha", { text: "nested", level: 1 }, "beta"] },
        { table: [["K", "V"], ["a", "1|2"]] },
        { quote: "Quoted words." },
      ],
    }),
  );

  const byKind = new Map(blocks.map((b) => [b.kind, b]));
  assert.equal(byKind.get("heading")?.text, "Top");
  assert.equal(byKind.get("heading")?.level, 1);
  assert.equal(byKind.get("paragraph")?.text, "Prose.");
  assert.equal(byKind.get("list")?.text, "- alpha\n  - nested\n- beta");
  assert.equal(byKind.get("table")?.text, "| K | V |\n| --- | --- |\n| a | 1\\|2 |");
  assert.equal(byKind.get("quote")?.text, "> Quoted words.");
});

test("headings advance the section locator and nest the trail", async () => {
  const blocks = await collect(
    open({
      blocks: [
        { paragraph: "Preamble." },
        { heading: "One", level: 1 },
        { paragraph: "Inside one." },
        { heading: "One point one", level: 2 },
        { paragraph: "Deeper." },
        { heading: "Two", level: 1 },
        { paragraph: "Inside two." },
      ],
    }),
  );

  const byText = new Map(blocks.map((b) => [b.text, b]));
  assert.equal(byText.get("Preamble.")!.locator.value, "sec-0");
  assert.deepEqual(byText.get("Preamble.")!.sectionPath, []);
  assert.equal(byText.get("Inside one.")!.locator.value, "sec-1");
  assert.deepEqual(byText.get("Inside one.")!.sectionPath, ["One"]);
  assert.deepEqual(byText.get("Deeper.")!.sectionPath, ["One", "One point one"]);
  assert.deepEqual(byText.get("Inside two.")!.sectionPath, ["Two"]);
  const two = byText.get("Two")!;
  assert.deepEqual(two.sectionPath, [], "a heading must carry ancestors only");
});

test("metadata prefers dc:title, then the first Heading 1, then the filename", async () => {
  const dc = await new DocxParser().metadata(
    open({ dcTitle: "The Proper Title", blocks: [{ heading: "H", level: 1 }] }),
  );
  assert.equal(dc.title, "The Proper Title");
  assert.equal(dc.locatorScheme, "section");

  const h1 = await new DocxParser().metadata(
    open({ blocks: [{ heading: "From The Heading", level: 1 }, { paragraph: "x" }] }),
  );
  assert.equal(h1.title, "From The Heading");

  const file = await new DocxParser().metadata(
    open({ blocks: [{ paragraph: "just prose" }] }, "field-notes.docx"),
  );
  assert.equal(file.title, "field-notes");

  const emptyDc = await new DocxParser().metadata(
    open({ dcTitle: "", blocks: [{ paragraph: "x" }] }, "field-notes.docx"),
  );
  assert.equal(emptyDc.title, "field-notes");
});

test("footnotes and endnotes are read, and Word's separator notes are not", async () => {
  const blocks = await collect(
    open({
      blocks: [
        { heading: "Argument", level: 1 },
        {
          paragraph: "Time in the novel is palimpsestic.",
          note: { kind: "endnote", text: "Singer, “A Slightly Different Sense Of Time,” 388." },
        },
        { paragraph: "A second claim.", note: { kind: "footnote", text: "But see Ellison." } },
      ],
    }),
  );

  const notes = blocks.filter((b) => b.kind === "caption");
  assert.deepEqual(
    notes.map((b) => b.text),
    [
      "[endnote 1] Singer, “A Slightly Different Sense Of Time,” 388.",
      "[footnote 1] But see Ellison.",
    ],
    "each kind is numbered by order of reference, and the separator notes Word " +
      "writes into every file contribute nothing",
  );

  // A citation must be findable under the section that makes the claim, and in
  // the same chunk as it — which needs the citing block's locator, not its own.
  const citing = blocks.find((b) => b.text.startsWith("Time in the novel"))!;
  assert.equal(notes[0]!.locator.value, citing.locator.value);
  assert.deepEqual(notes[0]!.sectionPath, ["Argument"]);
});

test("a note on a list item is emitted after the list, not inside it", async () => {
  const blocks = await collect(
    open({
      blocks: [
        { bullets: ["plain", { text: "cited", level: 0, note: { kind: "footnote", text: "Source." } }] },
        { paragraph: "After." },
      ],
    }),
  );

  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["list", "caption", "paragraph"],
  );
  assert.equal(blocks[0]!.text, "- plain\n- cited", "the marker never lands in the list text");
  assert.equal(blocks[1]!.text, "[footnote 1] Source.");
});

test("an empty body is refused, never a silently empty document", async () => {
  await assert.rejects(
    new DocxParser().metadata(open({ blocks: [] })),
    (err: unknown) => err instanceof UnsupportedFormatError && /no body text/.test(err.message),
  );
});
