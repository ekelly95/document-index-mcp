// Structural properties of each PDF, straight from pdfjs — what the corpus
// actually covers, rather than what its filename claims.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Resolved against this file rather than an absolute path, so the harness works
// from any checkout. It reads the BUILD, not the source, because what needs
// probing is what the parsers actually do after tsc — run `pnpm build` first.
const dist = (mod) =>
  pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", mod)).href;

const {openSource} = await import(dist("pipeline/source.js"));
const {loadPdf} = await import(dist("pipeline/parsers/pdfCommon.js"));
const {probePdf} = await import(dist("pipeline/parsers/pdfProbe.js"));

import { readdirSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
for (const name of readdirSync(dir).filter((n) => n.endsWith(".pdf"))) {
  const src = await openSource(path.join(dir, name));
  try {
    const { doc: pdf } = await loadPdf(src);
    const labels = await pdf.getPageLabels();
    const outline = await pdf.getOutline();
    const probe = await probePdf(src);

    const differing = labels
      ? labels.filter((l, i) => l !== String(i + 1)).slice(0, 4)
      : null;

    console.log(`\n${name}`);
    console.log(`  pages          : ${pdf.numPages}`);
    console.log(
      `  page labels    : ${
        labels === null
          ? "none"
          : differing.length === 0
            ? "present but identical to the physical index"
            : `DIFFER, e.g. ${JSON.stringify(differing)}`
      }`,
    );
    console.log(`  bookmarks      : ${outline ? `${outline.length} top-level` : "none"}`);
    console.log(`  probe verdict  : ${JSON.stringify(probe)}`);
  } catch (e) {
    console.log(`\n${name}\n  FAILED: ${e?.message}`);
  } finally {
    await src.close();
  }
}
