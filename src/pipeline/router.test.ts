import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { sniffFormat } from "./router.js";
import { UnsupportedFormatError, type DocumentSource, type Format } from "./ir.js";
import { openSource } from "./source.js";

/**
 * Format detection by content, with the extension as a hint only. Covered
 * until now only through the PDF and DOCX parser tests, which never hand it a
 * file whose name lies.
 */

let dir: string;
const opened: DocumentSource[] = [];

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "document-index-mcp-router-"));
});
after(async () => {
  await Promise.all(opened.map((src) => src.close()));
  await fs.rm(dir, { recursive: true, force: true });
});

async function sniff(name: string, bytes: Uint8Array | string): Promise<Format> {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  const src = await openSource(file);
  opened.push(src);
  return sniffFormat(src);
}

test("a .txt that is really a PDF is read as a PDF", async () => {
  assert.equal(await sniff("disguised.txt", "%PDF-1.7\n%stub"), "pdf");
});

test("markdown is recognised by extension, or by frontmatter under any name", async () => {
  assert.equal(await sniff("plain.md", "Just a paragraph, no frontmatter, no heading."), "md");
  assert.equal(await sniff("notes.txt", "---\ntitle: Notes\n---\n\nBody."), "md");
  assert.equal(await sniff("windows.txt", "---\r\ntitle: Notes\r\n---\r\n"), "md");
  assert.equal(await sniff("plain.txt", "Nothing but text."), "txt");
});

test("HTML is recognised by its doctype even under a .txt name", async () => {
  assert.equal(await sniff("page.txt", "  <!DOCTYPE html><html></html>"), "html");
});

test("a zip is told apart by its central directory, not its name", async () => {
  const docx = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w/>") });
  assert.equal(await sniff("misnamed.pptx", docx), "docx");
  const pptx = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": strToU8("<p/>") });
  assert.equal(await sniff("misnamed.docx", pptx), "pptx");
});

test("a corrupt zip falls back to the extension, and without one is refused", async () => {
  const corrupt = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(64, 0x41)]);
  assert.equal(await sniff("damaged.docx", corrupt), "docx");
  await assert.rejects(
    async () => sniff("damaged.bin", corrupt),
    (err: unknown) => err instanceof UnsupportedFormatError && /could not be identified/.test(err.message),
  );
});

test("legacy binary Office is refused with the converter named", async () => {
  const cfb = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await assert.rejects(
    async () => sniff("old.doc", cfb),
    (err: unknown) => err instanceof UnsupportedFormatError && /convert-for-ingest\.ps1/.test(err.message),
  );
});

test("binary that matches no signature is refused rather than indexed as text", async () => {
  await assert.rejects(
    async () => sniff("mystery.txt", Buffer.from([0x01, 0x02, 0x00, 0x03])),
    (err: unknown) => err instanceof UnsupportedFormatError && /binary/.test(err.message),
  );
});
