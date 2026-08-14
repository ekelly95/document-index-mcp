# Gotchas worth knowing

Most of these were bugs first. They are recorded here rather than in a commit message
because each one is a trap that a reasonable change would walk straight back into.

- **`ingest_status = 'processing'` is the ingest lock, and better-sqlite3 is why that works.** It is
  synchronous, so a `db.transaction(...)` wrapping the whole check-then-write preamble has no await
  inside it for the event loop to switch on: check-then-write is atomic by construction. A
  `processing` row therefore has exactly one writer, and every other caller must leave it strictly
  alone. An earlier version ran that preamble unlocked and held a mutex only around indexing, which
  let a second ingest of the same file call `deleteChunksOf` on a live one, re-index from `seq 0`,
  collide on `UNIQUE(document_id, seq)`, and then have its own error handler delete the first
  ingest's *finished* index and mark the document failed — two concurrent ingests destroying a good
  index. If it is `processing`, it is not yours.
- **`recoverInterrupted` is load-bearing, not just tidy.** Because `processing` is the claim, a
  row left behind by a crash would refuse every future ingest of that file. Clearing it at
  startup (`context.ts`) is what releases the claim. It clears only claims whose **lease** has
  expired — `updated_at` older than five minutes, where a live writer refreshes it every
  64-chunk batch — because clearing every `processing` row unconditionally is safe exactly when
  this process is the only writer, and catastrophic when that assumption is wrong.
  `claimForIngest` applies the same rule, which is not optional: without it one crash makes that
  file permanently un-ingestable, since every retry politely joins an ingest that will never
  progress.
- **A failed ingest must not cost you the version it was replacing.** Re-ingesting an edited file
  is a new document (the sha changed), and the old one is evicted by `finalizeDocument`, inside
  the transaction that publishes the replacement — never at claim time. In between, the path
  legitimately carries two rows: the old one `ready` and still answering searches, the new one
  `processing` and invisible to them. `source_path` has no `UNIQUE` constraint precisely so that
  state is representable.
- **Search only covers `ingest_status = 'ready'`.** A half-indexed book answering queries is
  indistinguishable from a finished one, so the lexical leg joins `documents` and the vector
  leg's candidates are filtered during hydration. `search_document` names any document still
  indexing in its response, because otherwise "no matches" is indistinguishable from "the
  library does not cover this" — the same failure the PDF probe refuses to create at ingest.
- **Never write a control character as a literal byte — use the `\uXXXX` escape.** Two separators
  here are control characters on purpose — `pdfFast.ts` joins a bookmark trail with `\u0000`, and
  `ocrPool.ts` builds its OCR pool key the same way — because a heading or a path can never
  contain one, so two different trails can never collide. Written as a raw byte, though, a single
  NUL makes every binary-sniffing tool treat the whole file as binary: `git diff` stops showing it,
  ripgrep skips it, repomix drops it from a pack **silently**. That has now happened twice —
  `chunker.ts`, `outline.ts` and `pdfFast.ts` were invisible in a review pack, leaving the reviewer
  to work from their tests, and later `ocrPool.ts` did it again and shipped that way until a
  pre-release review caught it. The escapes compile to identical strings. No longer advice you have
  to remember: `src/sources.test.ts` scans `src/**/*.ts` and `scripts/**/*.mjs` for bytes below
  `0x20` other than tab, LF and CR, naming the file, line and column of anything it finds.
- **vec0 rejects plain JS numbers as primary keys.** better-sqlite3 binds them as SQLite REAL; sqlite-vec
  needs a true INTEGER and fails with `Only integers are allows for primary key values`. Every rowid
  crossing into `vec_chunks` goes through `vecRowid()`, which returns a `BigInt`.
- **`vec_chunks` is a virtual table and no foreign key cascade reaches it.** Deleting a document must
  delete its vectors explicitly or the index accumulates orphans that still answer KNN queries.
  `deleteDocument()` does this, and a test asserts all three indexes stay in agreement.
- **A vec0 `PARTITION KEY` costs a whole storage block per partition value, and the default block is
  1024 vectors.** This is the single most expensive default in the schema and it is invisible until
  you measure it. vec0 allocates vector storage a block at a time —
  `chunk_size × dimensions × 4` bytes, so 1024 × 384 × 4 = exactly 1,572,864 — and partitioning by
  `document_id` gives every document its own blocks. A one-paragraph note therefore costs the same
  1.5 MB as a 1000-chunk book. Measured on a real library of 71 mostly-small Markdown files: a 113 MB
  index holding **1.48 MB** of actual vectors, 94% of the file empty padding, and growing with the
  number of files rather than the amount of content — the worst possible shape for a library fed by
  transcript and paper intake. Fixed in schema v4 with `chunk_size=64`. If you ever reach for a second
  partition key, price it first: `SELECT DISTINCT length(vectors) FROM vec_chunks_vector_chunks00`
  times the row count of `vec_chunks_chunks` is the real cost.
- **The library root must be resolved with `fs.realpathSync.native`, never plain `realpathSync`.**
  `beginIngest` asks `libraryRelative` for a file's path relative to `config.libraryRoot`, and that
  file has been through `assertRealPathInside`, which uses the `fs/promises` `realpath`. If the two
  ends resolve differently they are two spellings of one place, `path.relative` climbs out and back,
  and `source_path` becomes `../../../../../runneradmin/AppData/.../note.md` instead of `note.md` —
  so a file stops matching itself, an edited document is never superseded, and one library path
  holds two rows. On Windows the two forms genuinely differ:
  `fs.realpathSync("C:/PROGRA~1")` returns `C:\PROGRA~1` unchanged, while `fs.realpathSync.native`
  and the promises form both return `C:\Program Files`. Linux never shows any of this, because
  `/tmp` is already canonical; macOS shows it via `/var` → `/private/var`; Windows shows it via 8.3
  short names, which is what a GitHub Actions temp directory is. Fixing it with the plain form
  repaired macOS and left Windows untouched, and that is how the distinction was found. There is a
  test pinning `config.libraryRoot` against the promises `realpath` directly, so the two cannot
  drift apart again.
- **A per-entry zip cap is not an archive cap, and raising `MAX_ENTRY_BYTES` will not make one.**
  Zip entry names are not unique. fflate walks the central directory without deduplicating,
  allocates each kept entry's **declared** uncompressed size, inflates into it, and lets a later
  record of the same name overwrite the earlier one — every copy is paid for and only the last is
  kept. `keepEntry` in `docx.ts` matches four exact names, so 65,535 records all called
  `word/document.xml` all pass. Measured against the real reader: 3.7 MB of input inflated 4.0 GB
  in 8.9 seconds, flat at 0.45 GB/s, and `unzipSync` is synchronous — for that whole window the
  server answers nothing, not even its shutdown drain. `openZip` now skips a name already taken
  and holds a running total (`MAX_TOTAL_BYTES`). The test asserts that a thousand-duplicate
  archive **opens**, which is not the obvious assertion: `names()` reads identically either way,
  so the only proof the duplicates were skipped is that they did not consume the budget.
- **fastembed's `passageEmbed` / `queryEmbed` apply E5 prefixes**, not BGE's. `embedder.ts` calls
  `embed()` directly and applies the correct BGE query instruction itself.
- **pnpm 10+ blocks postinstall scripts**, and the allowlist lives in `pnpm-workspace.yaml` — the
  `pnpm.onlyBuiltDependencies` field in `package.json` is silently ignored. `better-sqlite3` is set to
  `false` deliberately: its install script falls back to node-gyp and needs Visual Studio, while the
  shipped prebuilt binary works fine.
- **pdfjs cannot load its own bundled fonts under Node.** It fetches them with `fetch()` /
  `XMLHttpRequest`, neither of which handles `file://` in Node, and v6 exposes no factory override. The
  consequence is small — embedded fonts come from the PDF itself and the standard 14 have built-in
  metrics — but it warns once per font per document, so verbosity is pinned to `ERRORS`.
- **`standardFontDataUrl` must be a `file://` URL with a literal trailing `/`.** pdfjs validates for that
  character, so a Windows path ending in a backslash is rejected outright.
- **PDF chunks tend to be one per page.** The boundary law forbids crossing a page, so a typical page of
  prose lands under the 350-token target and emits a single chunk. That is the design working, not a
  sizing bug.
- **A heading is whatever is bigger than the body, and the section trail is a size-ordered stack.**
  Not a tier index used as a tree depth — that was the bug. Popping every open section opened at a size
  no larger than this heading makes equal-sized headings siblings; a bigger one closes everything
  smaller. Requiring a size to appear in the sampled tier list was also wrong: chapter headings that
  occupy 5% of a 585-page book can miss a 20-page sample entirely and were silently demoted to body
  text, so the tier list now only *ranks* a heading and never gates one.
- **Font size is a signal that can be absent, and a signal that can lie.** A scan carrying an OCR text
  layer decodes fine, so it takes the fast route, where OCR's near-continuum of font sizes made almost
  every line a heading. Above six heading tiers *and* three heading lines per sampled page, the sizes
  are discarded and structure comes from bookmarks alone — the rule the OCR route always had. Measured
  on a 408-page scan: 2,824 headings and 2,766 chunks averaging 65 tokens became 0 headings and 782
  chunks averaging 228. The decision is logged, so a flat outline is never a mystery.
- **Sideways text is furniture.** A rotated run's `transform[0]` is ≈0, so its size fell back to the
  glyph box's *width*: arXiv's margin stamp measured 20pt on a paper whose title is 14.5pt, outranking
  it and filing the whole paper under a submission identifier. It also claimed its 300pt vertical
  extent as horizontal width, inflating the page's text extent and erasing the gutter two-column
  detection depends on. Runs turned more than 45° off horizontal are dropped in `assembleLines`.
- **An embedded document title can be worse than the filename.** The 9/11 Commission Report ships with
  `Title (201-635.job)`, the print shop's job name; a PDF exported from an unrenamed deck ships with
  `PowerPoint Presentation`. `usableTitle` rejects placeholders and filename-shaped titles, and PDF
  falls through it to the document's own first heading, as docx does.
- **`tsc` does not delete the `.js` of a source file you removed, and `pnpm test` globs `dist/`.**
  A deleted module's compiled output stays behind and keeps running — so the tests of a parser that
  no longer exists went on passing, and then failing, against a build no source could reproduce.
  This is why `build` now runs `clean` first. Never diagnose a test failure in `dist/` without
  checking that its `.ts` still exists.

## Scanned PDFs and OCR

The probe that used to refuse scans now escalates them. A PDF whose sampled pages are essentially
imagery — or whose text layer decodes to noise — routes to `src/pipeline/parsers/pdfOcr.ts`:
tesseract.js in-process, WASM, no external installs, recorded as `engine_used = 'ts-ocr'`. The
decision is then re-made **per page**: a scanned book's digitally generated title page keeps its real
text layer verbatim, and only pages without a usable layer pay for recognition. Structure comes from
embedded bookmarks alone (font-size tiers learned from a scan's few digital pages would be noise), so
a scan without bookmarks legitimately has a flat outline.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--ocr=auto\|off` | `DOCUMENT_INDEX_OCR` | `auto` | `off` restores the loud refusal |
| `--ocr-lang=` | `DOCUMENT_INDEX_OCR_LANG` | `eng` | Tesseract language(s), e.g. `deu+eng` |
| `--ocr-workers=` | `DOCUMENT_INDEX_OCR_WORKERS` | `2` | Pages recognised concurrently |
| `--ocr-lang-path=` | `DOCUMENT_INDEX_OCR_LANG_PATH` | the CDN | Local traineddata directory |

Worth knowing before the first scan goes in:

- **It is slow, deliberately visibly so.** Pages rasterise at 300 DPI and recognise at roughly 1–5s
  per page per worker; a 400-page scan is tens of minutes. Progress is honest the whole way —
  `get_document_outline` reports `chunk_count` rising against `locator_count`. `--ocr-workers` is the
  throughput lever; each worker holds a WASM heap of 150–300MB once pages are in flight, which is why
  the default is 2.
- **First use downloads ~3MB per language** (`eng.traineddata` from jsDelivr) into
  `<models>/tesseract/`, next to the embedding model, and never again. This is the second of the
  server's two outbound requests, and the one most easily forgotten — the README and `SECURITY.md`
  both claimed for a while that the embedding model was the only one.
- **`--ocr-lang-path` avoids that download**, for an offline machine or a pinned copy. Two things
  decide whether it works. It is consulted **only on a cache miss**, so once `<models>/tesseract/`
  holds the file the flag does nothing and looks broken. And the filename must match what is there:
  tesseract.js asks for `<lang>.traineddata.gz` or `<lang>.traineddata` depending on its `gzip`
  option, and it does not sniff. The npm `@tesseract.js-data` packages ship the gzipped form;
  everything under `tesseract-ocr/tessdata_fast` and `tessdata_best` is plain. `buildScheduler`
  looks in the directory and sets `gzip` accordingly, so either layout works — but only one form
  per directory, and with `deu+eng` every language must use the same form.
- **A shutdown mid-OCR abandons the run** after the 10s drain; the lease expires, the next start
  marks it failed, and re-ingesting starts the OCR over. Nothing already `ready` is affected.
- **Mojibake books are OCR'd wholesale.** A wrong-encoding text layer looks printable page by page,
  so when the probe's verdict is mojibake the per-page vote is not trusted (`forceOcr`).
- **The lease renews on a timer now** (`LEASE_RENEW_INTERVAL_MS`, once a minute), not only per
  64-chunk batch — a batch of scanned pages can legitimately outlast the whole five-minute lease,
  and before this a live OCR ingest could be reaped and handed to a second writer.
