// Run real files through the ingest pipeline WITHOUT touching the index:
// openSource -> routeDocument -> parser.parse -> chunkBlocks -> OutlineBuilder.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Resolved against this file rather than an absolute path, so the harness works
// from any checkout. It reads the BUILD, not the source, because what needs
// probing is what the parsers actually do after tsc — run `pnpm build` first.
const dist = (mod) =>
  pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", mod)).href;

const {openSource} = await import(dist("pipeline/source.js"));
const {routeDocument} = await import(dist("pipeline/router.js"));
const {chunkBlocks} = await import(dist("pipeline/chunker.js"));
const {OutlineBuilder} = await import(dist("pipeline/outline.js"));

const files = process.argv.slice(2);
const MODE = process.env.PROBE_MODE ?? "summary"; // summary | blocks | chunks

function tree(nodes, depth = 0) {
  const out = [];
  for (const n of nodes) {
    out.push(
      `${"  ".repeat(depth)}${"#".repeat(n.level)} ${n.title}` +
        `   [${n.locator.type} ${n.locator.value}` +
        (n.locator.printed_label ? ` p.${n.locator.printed_label}` : "") +
        `, chunks ${n.chunk_seq_start}-${n.chunk_seq_end}]`,
    );
    out.push(...tree(n.children, depth + 1));
  }
  return out;
}

for (const f of files) {
  console.log("\n" + "=".repeat(78));
  console.log(f);
  console.log("=".repeat(78));
  let src;
  try {
    src = await openSource(f);
    const route = await routeDocument(src);
    const meta = await route.parser.metadata(src);
    console.log(
      `format=${route.format} engine=${route.engine} scheme=${meta.locatorScheme} ` +
        `locators=${meta.locatorCount} title=${JSON.stringify(meta.title ?? null)}`,
    );

    const blocks = [];
    const outline = new OutlineBuilder();
    const chunks = [];
    let seq = 0;

    // Tee the block stream so we can report on the IR as well as the chunks.
    async function* tee() {
      for await (const b of route.parser.parse(src)) {
        blocks.push(b);
        yield b;
      }
    }

    for await (const c of chunkBlocks(tee(), { scheme: meta.locatorScheme })) {
      outline.add(seq, c.sectionPath, c.locator);
      chunks.push({ seq, ...c });
      seq++;
    }

    const byKind = {};
    for (const b of blocks) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
    console.log(`blocks=${blocks.length} ${JSON.stringify(byKind)}`);

    const chunkKind = {};
    for (const c of chunks) chunkKind[c.kind] = (chunkKind[c.kind] ?? 0) + 1;
    const toks = chunks.map((c) => c.tokenCount);
    console.log(
      `chunks=${chunks.length} ${JSON.stringify(chunkKind)} ` +
        `tokens min=${Math.min(...toks)} max=${Math.max(...toks)} ` +
        `mean=${Math.round(toks.reduce((a, b) => a + b, 0) / (toks.length || 1))}`,
    );

    // The boundary law, checked directly: no chunk may mix locators.
    const spans = new Map();
    for (const c of chunks) {
      const k = c.locator.value;
      spans.set(k, (spans.get(k) ?? 0) + 1);
    }
    console.log(`distinct locators used by chunks: ${spans.size}`);

    const t = tree(outline.build());
    console.log(`\n--- outline (${t.length} nodes) ---`);
    console.log(t.length ? t.join("\n") : "(empty — no headings detected)");

    if (MODE === "blocks") {
      console.log("\n--- blocks ---");
      for (const [i, b] of blocks.entries()) {
        console.log(
          `\n[${i}] ${b.kind}${b.level ? ` h${b.level}` : ""} ` +
            `@${b.locator.type}:${b.locator.value} path=${JSON.stringify(b.sectionPath)}`,
        );
        console.log(b.text.length > 600 ? b.text.slice(0, 600) + " …" : b.text);
      }
    }

    if (MODE === "chunks") {
      console.log("\n--- chunks ---");
      for (const c of chunks) {
        console.log(
          `\n[${c.seq}] ${c.kind} @${c.locator.type}:${c.locator.value} ` +
            `${c.tokenCount}tok path=${JSON.stringify(c.sectionPath)}`,
        );
        console.log(c.text.length > 700 ? c.text.slice(0, 700) + " …" : c.text);
      }
    }
  } catch (e) {
    console.log(`FAILED: ${e?.name}: ${e?.message}`);
    if (process.env.PROBE_STACK) console.log(e?.stack);
  } finally {
    await src?.close();
  }
}
