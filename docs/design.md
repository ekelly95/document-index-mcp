# Design notes

Why this is built the way it is. Moved out of the README when the project got a public
front page; none of it has been thinned, because the reasoning is the part that stops a
later change undoing a deliberate decision.

## The three ideas that matter

**Progressive disclosure is structural, not conventional.** Search returns snippets, the outline returns
no body text, and exactly one tool returns body text with a hard cap. Whole-document dumps are impossible
by construction rather than by discipline. The output schemas enforce it — `search_document`'s hit shape
has no `text` field, so a refactor cannot quietly regress it.

**The boundary law.** A chunk never crosses a page or section boundary. Most RAG pipelines
chunk by token window and then attribute the chunk to whichever page it mostly came from, which produces
citations that are subtly wrong. Here page-purity is a chunker invariant, asserted directly in
`src/pipeline/chunker.test.ts`. A page-42 chunk contains only page-42 text.

**The Block IR.** Every parser compiles its format into a stream of `DocBlock`s (`src/pipeline/ir.ts`).
The chunker, the outline builder and the retrieval layer never learn what format a document came from,
so adding a format is one file in `parsers/` plus one branch in `router.ts`.

That claim was tested rather than asserted, and the test is worth keeping even though the format is
gone. EPUB was the hardest shape the pipeline ever met — a locator that is a file rather than a page,
structure coming from a separate navigation document, and content spread across an archive — and it
was absorbed with **no change** to the chunker, the outline builder or the retrieval layer. When EPUB
and PowerPoint were removed in August 2026 the same boundary held in reverse: two parsers came out
and nothing downstream needed touching. An abstraction that survives both adding and removing a
format is load-bearing. See `docs/roadmap.md` for why they were removed.

## Deviations from the source spec

Built from a v3 universal ingestion and retrieval specification, written before any of this existed.
That document is no longer on disk — it was pasted into a chat and never saved — so this table is all
that survives of it, which makes it worth more than the usual changelog. Where the build differs from
what was specified, it is deliberate, and the reason is here.

| Spec said | Built | Why |
|---|---|---|
| v1's `safeResolve`, `locks.ts`, task store/router and mojibake heuristics "carry forward verbatim" | `paths.ts` + `locks.ts` ported from `obsidian-mcp`; the rest written fresh | There is no v1 codebase. The spec budgeted two of its hardest pieces at zero. |
| Async Tasks extension (`io.modelcontextprotocol/tasks`) | Dropped. `ingest_document` returns immediately and `get_document_outline` reports progress | The spec itself calls the extension experimental with naming drift. Fire-and-forget needs no protocol extension and has no timeout at any file size. |
| 40-token overlap between chunks sharing a `sectionPath` | Overlap requires the same locator **and** the same section path | As specified this breaks the boundary law: consecutive pages routinely share a section path, so overlap would splice page-41 text into a page-42 chunk. |
| Overlap folded into the chunk text | Overlap is embedded, never stored | It exists to help the vector index; left in stored text it also makes `get_chunk_context` repeat sentences across every adjacent chunk. Mirrors what the spec already does for section paths. |
| `char_start` / `char_end` "within the locator's markdown" | Dropped | The spec makes blocks transient IR that is never persisted, so those offsets index a string that cannot be reconstructed from the database. |
| `MAX_TOTAL_CHARS` truncation via `.filter()` | Trim from the edges, never past the anchor | `.filter()` drops an oversized chunk then keeps a later small one, returning a **non-contiguous** window whose seq numbers silently skip. |
| `sha256 UNIQUE` *and* "unless a different engine is forced" | `UNIQUE` kept; a matching hash returns the existing id, a failed one is re-ingested in place | The two clauses are mutually exclusive. |
| `OVERFETCH = 4`, all filters applied after fusion | Overfetch is **per leg and per filter**: 2× when a leg can push every filter into its own SQL, 32× when it cannot, then doubled up to three times if that leg comes back saturated and the result is still short of `k` | The vector leg pre-filters on `document_id` and nothing else, so at 2× a `kind: table` query (tables are ~2% of a corpus) got essentially no tables and hybrid degraded to lexical-only. `section_prefix` is the case that needs *both* legs widened — section paths are JSON, so neither leg can push it down — and widening only the vector leg degraded the same query to semantic-only. A vec0 scan costs the scan, not `k`. |
| `proper-lockfile` around ingest | Three layers: the `documents` row is the per-document claim, `ingest_status = 'processing'` meaning owned and believed only while its lease is fresh; `<db>.lock` (`db/processLock.ts`) names which process runs startup recovery, and is the one thing `pnpm ingest` insists on; `async-mutex` stays around `indexDocument` as an in-process backstop | The original reasoning — "one server process, and SQLite WAL handles cross-process" — was wrong, and the shipped `pnpm ingest` is the second process that proves it. WAL prevents page corruption and says nothing about ingest ownership. The lease is what carries that, and it is atomic across processes; the file lock never was. A mutex still cannot make a better-sqlite3 transaction more atomic than it already is, and holding one across a 105-second index would time out every contending call, so that part stands. See the gotcha below. |
| `mupdf` (MuPDF.js WASM) | `pdfjs-dist` (Apache-2.0) | `mupdf@1.28.0` is AGPL-3.0-or-later — viral over the whole server. pdfjs-dist covers every requirement: `getTextContent()` transforms for bbox and font size, `getPageLabels()` for printed labels, `getOutline()` for bookmarks. |
| PDF probe routes to a Docling sidecar | The probe escalates to **in-process OCR** (tesseract.js), or refuses under `--ocr=off` | There is no sidecar in this build and no Python environment to host one; WASM OCR keeps the install story at `pnpm install && pnpm build`. The refusal half survives as the `--ocr=off` behaviour, because a scan ingested with neither succeeds as a document containing nothing — and a later search finding nothing is indistinguishable from a topic the book does not cover. |
| `probePdf` detects mojibake, image-only, multi-column, table-dense | The probe detects mojibake and image-only. Multi-column is detected in `assembleLines` and **fixed** rather than reported; table-dense is still not detected | Detection was dismissed as dead code without a Docling route to select, which was true of table-dense and wrong about columns. Baseline grouping interleaved the two columns of a paper line by line, and because locators stayed page-true the citation pointed confidently at the right page of nonsense. Refusing them, as the spec's route implies, would refuse most academic papers — so the reading order is repaired instead: bands split at full-width rows and large vertical gaps, gutters found from individual runs, each band emitted column by column. |
| PDF outline from bookmarks *or* synthetic font-size heuristics | Both, composed | Bookmarks are authoritative but resolve only to a page, so they cannot see a subsection starting halfway down one. A bookmark re-bases the section trail; detected headings extend it. Front matter, which sits before the first bookmark, still gets a path from its headings. |
| Tables indivisible | Tables and code get their own chunk | Indivisible is weaker than isolated. Merged into a mixed chunk a table's `kind` degrades to `"text"`, so `filter.kind` matches nothing and the embedding is diluted by adjacent prose. Measured: isolating them moved the correct hit from #2 to #1 on the fixture corpus. |
| 512-token chunk ceiling | 400 | fastembed pads every input to `maxLength`, so this is a cost lever. Measured on this machine: 512 → ~140s to embed a 400-page book, 400 → ~105s, 256 → ~64s. |
| "No outbound network calls remain anywhere" | True at query time only | `fastembed` depends directly on `@huggingface/hub` and downloads ~130MB on first run. |
| `schema.sql` | `src/db/schema.ts` | `tsc` does not copy `.sql` into `dist/`, which would need a build step or runtime path resolution that differs between `pnpm start` and `node dist/index.js`. |
