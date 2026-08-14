import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { openZip } from "./zip.js";
import { routeDocument, sniffFormat } from "./router.js";
import { sourceFromBytes } from "./source.js";

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
  assert.equal(sniffFormat(sourceFromBytes("C:\\lib\\book.epub", epub)), "epub");
});

test("a recognised EPUB is refused by name, not as unidentifiable binary", async () => {
  const src = sourceFromBytes("C:\\lib\\book.epub", epubShapedZip());
  await assert.rejects(() => routeDocument(src), /EPUB is not read/);
});

test("a recognised PPTX is refused by name, not as unidentifiable binary", async () => {
  const pptx = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
    }),
  );
  const src = sourceFromBytes("C:\\lib\\deck.pptx", pptx);
  assert.equal(sniffFormat(src), "pptx");
  await assert.rejects(() => routeDocument(src), /Slide decks are not read/);
});
