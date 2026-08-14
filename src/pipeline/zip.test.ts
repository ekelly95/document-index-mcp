import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, strToU8, zipSync } from "fflate";
import { MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, ZipBudgetError, openZip } from "./zip.js";
import { routeDocument, sniffFormat } from "./router.js";
import { sourceFromBytes } from "./source.js";
import { buildDocx } from "../testing/docxFixture.js";

test("entries round-trip by name, bytes and text", () => {
  const zip = openZip(
    zipSync({
      "a.txt": strToU8("alpha"),
      "dir/b.txt": strToU8("beta"),
    }),
  );
  assert.deepEqual(zip.names().sort(), ["a.txt", "dir/b.txt"]);
  assert.equal(zip.has("a.txt"), true);
  assert.equal(zip.has("missing.txt"), false);
  assert.equal(zip.text("dir/b.txt"), "beta");
  assert.deepEqual([...zip.bytes("a.txt")], [...strToU8("alpha")]);
});

test("the keep filter stops entries from ever being inflated", () => {
  const zip = openZip(
    zipSync({
      "keep.xhtml": strToU8("<p>kept</p>"),
      "art/plate.jpg": strToU8("not really a jpeg but heavy in spirit"),
    }),
    (name) => name.endsWith(".xhtml"),
  );
  assert.deepEqual(zip.names(), ["keep.xhtml"]);
  assert.throws(() => zip.bytes("art/plate.jpg"), /filtered/);
});

/**
 * A zip whose entries are named exactly as given — repeats included — each
 * declaring `declared` bytes uncompressed while carrying a few real ones.
 *
 * Hand-assembled because fflate's `zipSync` takes an object keyed by name and
 * therefore cannot express a duplicate, which is the entire point. Generated
 * rather than committed because a fixture big enough to be interesting is too
 * big to keep in the repository: this is the shape that inflated 4.0 GB out of
 * 3.7 MB before the caps below existed.
 */
function craftedZip(names: readonly string[], declared: number): Uint8Array {
  const payload = deflateSync(strToU8("<w:document><w:body/></w:document>"));
  const u16 = (a: Uint8Array, o: number, v: number): void => {
    a[o] = v & 0xff;
    a[o + 1] = (v >>> 8) & 0xff;
  };
  const u32 = (a: Uint8Array, o: number, v: number): void => {
    u16(a, o, v & 0xffff);
    u16(a, o + 2, (v >>> 16) & 0xffff);
  };

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;

  for (const name of names) {
    const nb = strToU8(name);
    const local = new Uint8Array(30 + nb.length);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 8, 8); // deflate
    u32(local, 18, payload.length);
    u32(local, 22, declared);
    u16(local, 26, nb.length);
    local.set(nb, 30);
    offsets.push(pos);
    parts.push(local, payload);
    pos += local.length + payload.length;
  }

  const centralStart = pos;
  names.forEach((name, i) => {
    const nb = strToU8(name);
    const central = new Uint8Array(46 + nb.length);
    u32(central, 0, 0x02014b50);
    u16(central, 4, 20);
    u16(central, 6, 20);
    u16(central, 10, 8);
    u32(central, 20, payload.length);
    u32(central, 24, declared);
    u16(central, 28, nb.length);
    u32(central, 42, offsets[i]!);
    central.set(nb, 46);
    parts.push(central);
    pos += central.length;
  });

  const eocd = new Uint8Array(22);
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 8, names.length);
  u16(eocd, 10, names.length);
  u32(eocd, 12, pos - centralStart);
  u32(eocd, 16, centralStart);
  parts.push(eocd);

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The four fixed names docx.ts admits, restated so this test stands alone. */
const docxEntries = (name: string): boolean =>
  name === "word/document.xml" ||
  name === "docProps/core.xml" ||
  name === "word/footnotes.xml" ||
  name === "word/endnotes.xml";

test("the total budget stops an archive spread across distinct names", () => {
  // Five distinct entries, each inside the per-entry cap and so each acceptable
  // on its own, are 100 MB between them. The per-entry cap alone passes all
  // five; the archive budget is what refuses the fifth.
  const crafted = craftedZip(
    ["a", "b", "c", "d", "e"].map((n) => `word/${n}.xml`),
    MAX_ENTRY_BYTES,
  );
  assert.equal(MAX_TOTAL_BYTES, 4 * MAX_ENTRY_BYTES);
  assert.throws(() => openZip(crafted), ZipBudgetError);
});

test("a name repeated across a thousand records is inflated once", () => {
  // That this OPENS is the assertion, and it is deliberately not a timing one.
  // A repeat costs nothing only if it is skipped before being counted: were
  // these inflated, the five records above would have exhausted the budget and
  // this would throw at the fifth of a thousand. Succeeding is therefore proof
  // that 999 of them were never touched — which names() cannot show, since
  // fflate overwrites the map entry and only the last copy survives either way.
  const crafted = craftedZip(
    Array.from({ length: 1000 }, () => "word/document.xml"),
    MAX_ENTRY_BYTES,
  );
  const zip = openZip(crafted, docxEntries);
  assert.deepEqual(zip.names(), ["word/document.xml"]);
});

test("the caps do not disturb a legitimate document", () => {
  const zip = openZip(
    buildDocx({
      blocks: [
        { heading: "Methods", level: 1 },
        { paragraph: "Prose with a footnote.", note: { kind: "footnote", text: "The note." } },
      ],
    }),
    docxEntries,
  );
  assert.ok(zip.has("word/document.xml"));
  assert.match(zip.text("word/document.xml"), /Methods/);
});

/**
 * An EPUB's first zip entry is an uncompressed `mimetype` file at a fixed
 * offset, which is what sniffFormat matches on. Built inline rather than in a
 * fixture module because the only thing left to prove is that the format is
 * still RECOGNISED — the parser is gone, and being recognised is what earns a
 * refusal naming the format instead of "this file appears to be binary".
 */
function epubShapedZip(): Buffer {
  return Buffer.from(
    zipSync({
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8("<container/>"),
    }),
  );
}

test("an EPUB is still sniffed from the fixed offset, without unzipping", () => {
  const epub = epubShapedZip();
  assert.equal(
    epub.subarray(30, 58).toString("latin1"),
    "mimetypeapplication/epub+zip",
    "the mimetype entry is not at the fixed offset",
  );
  assert.equal(sniffFormat(sourceFromBytes("/lib/book.epub", epub)), "epub");
});

test("a recognised EPUB is refused by name, not as unidentifiable binary", async () => {
  const src = sourceFromBytes("/lib/book.epub", epubShapedZip());
  await assert.rejects(() => routeDocument(src), /EPUB is not read/);
});

test("a recognised PPTX is refused by name, not as unidentifiable binary", async () => {
  const pptx = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
    }),
  );
  const src = sourceFromBytes("/lib/deck.pptx", pptx);
  assert.equal(sniffFormat(src), "pptx");
  await assert.rejects(() => routeDocument(src), /Slide decks are not read/);
});
