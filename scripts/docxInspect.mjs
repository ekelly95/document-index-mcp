// What is actually inside these .docx files, independent of the parser.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Resolved against this file rather than an absolute path, so the harness works
// from any checkout. It reads the BUILD, not the source, because what needs
// probing is what the parsers actually do after tsc — run `pnpm build` first.
const dist = (mod) =>
  pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", mod)).href;

const {openZip} = await import(dist("pipeline/zip.js"));
const {parseXml,
  findFirst,
  findAll,
  elements,
  local,
  collapse,} = await import(dist("pipeline/parsers/xml.js"));

import { readFileSync } from "node:fs";

for (const f of process.argv.slice(2)) {
  console.log("\n" + "=".repeat(78));
  console.log(f);
  console.log("=".repeat(78));

  const bytes = new Uint8Array(readFileSync(f));

  // Full listing of the zip, so we can see what the parser chooses not to read.
  const names = [];
  openZip(bytes, (n) => {
    names.push(n);
    return false;
  });
  console.log("zip entries:", names.join(", "));

  const archive = openZip(
    bytes,
    (n) => n === "word/document.xml" || n === "docProps/core.xml" || n === "word/styles.xml",
  );
  const doc = parseXml(archive.text("word/document.xml"));
  const body = findFirst(doc, "body");

  // Direct children of w:body — this is exactly what DocxParser iterates.
  const direct = {};
  for (const el of elements(body)) direct[local(el)] = (direct[local(el)] ?? 0) + 1;
  console.log("direct children of w:body:", JSON.stringify(direct));

  // Every paragraph anywhere, including ones nested inside wrappers.
  const allP = findAll(body, "p");
  const directP = elements(body).filter((el) => local(el) === "p");
  console.log(`paragraphs: ${allP.length} total, ${directP.length} as direct children of body`);

  // Every pStyle actually used.
  const styles = {};
  for (const p of allP) {
    const pPr = findFirst(p, "pPr");
    const st = pPr ? (findFirst(pPr, "pStyle")?.getAttribute("w:val") ?? "(none)") : "(none)";
    styles[st] = (styles[st] ?? 0) + 1;
  }
  console.log("paragraph styles used:", JSON.stringify(styles));

  // Does the styles part define heading styles at all?
  if (archive.has("word/styles.xml")) {
    const st = parseXml(archive.text("word/styles.xml"));
    const defined = findAll(st, "style")
      .map((s) => s.getAttribute("w:styleId"))
      .filter((id) => id && /heading|title|subtitle/i.test(id));
    console.log("heading-ish styles defined:", defined.join(", ") || "(none)");
  }

  // How much text the parser sees vs how much is in the file.
  const bodyText = collapse(body.textContent).length;
  let directText = 0;
  for (const el of elements(body)) {
    const n = local(el);
    if (n === "p" || n === "tbl") directText += collapse(el.textContent).length;
  }
  console.log(`body text: ${bodyText} chars; reachable from direct p/tbl children: ${directText}`);

  const core = archive.has("docProps/core.xml") ? parseXml(archive.text("docProps/core.xml")) : null;
  console.log("core title:", core ? JSON.stringify(collapse(findFirst(core, "title")?.textContent)) : "(no core.xml)");
}
