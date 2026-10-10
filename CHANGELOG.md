# Changelog

Notable changes are listed newest first. Versions follow
[semantic versioning][semver]; releases before `1.0.0` may include breaking
changes.

[semver]: https://semver.org/spec/v2.0.0.html

## Unreleased

### October 2026 code audit

Fixes to chunking and PDF structure apply to documents indexed after them:
run `pnpm reindex` to rebuild an existing index (titles are kept). The
retrieval evaluation has not been re-run on these changes.

- **A filtered search on a large library no longer errors.** Overfetch
  escalation asked sqlite-vec for more than its 4,096-neighbour ceiling; the
  vector leg is now clamped there.
- **No chunk is unbounded, and the 24k read cap holds.** A unit with nothing to
  split at — a minified line, a blob, one long table row — is cut by token
  budget. An oversized chunk in an older index is cut on read and marked
  `truncated`.
- **A short subsection opener stays in its own section.** Fragment merging no
  longer crosses section paths, so "### B" and its first sentence are not cited
  under A.
- **PDF bookmarks:** named destinations are resolved (LaTeX/hyperref files had
  no bookmark trail), a positioned bookmark starts its section where it points
  rather than at the top of the page, and a second section starting on the same
  page is kept.
- **Pages that yielded no text are named in `ingest_warning`:** image-only pages
  in an otherwise digital PDF, and OCR'd pages whose every line scored too low.
- **Document text is labelled as content.** Titles and section names render on
  one line, passages are fenced, and the reading tools say the text is not
  instructions.
- **DOCX:** text inside a tracked move is indexed once, not twice.
- **Smaller fixes:** snippets are held to 300 characters; `search_document`
  names an unknown `document_id`; ingesting a byte-identical copy says the
  document moved, and from where (`moved_from`); `.epub`/`.pptx`/`.ppt` refusals
  name the remedy; `pnpm ingest` warns about unreadable folders and exits 2 when
  no target exists; the outline reports progress in pages for a PDF; the unused
  `pending` status is gone from the tool schemas.
- **Tests** for the CLIs' target walk and reindex hand-over, format sniffing,
  and, on the real-model job, the confidence calibration.
- `pnpm audit` reports one moderate advisory (GHSA-hp3w-g68c-fv3c), in
  `sprintf-js` ≤ 1.1.3 via `onnxruntime-node` › `global-agent` › `roarr`. A
  patched 1.1.4 exists; no override has been added.

### October 2026 retrieval audit

Measured against a real library of eleven textbook PDFs; the before/after
table is in [docs/roadmap.md](docs/roadmap.md).

- **Search says when the library does not cover a question.** Hits carry a
  cosine `similarity` and `lexical_match`; `search_document` reports
  `confidence: "high" | "low"`, calibrated at 0.65 (on-topic 0.73–0.85,
  off-topic 0.40–0.58).
- **Reference lists are tagged `references`** and left out of search unless
  `filter.kind` asks for them.
- **PDF headings are recognised by style** (size and font), not by "bigger than
  body text". Six of eleven chapters had no structure before; none do now.
  The OCR-noise guard that caused it is gone.
- **Running headers, page numbers and citation markers are furniture**, and
  fragments under 24 tokens merge into a neighbour on the same page.
- **No chunk is truncated before embedding.** 19% were; chunks are re-split
  against the model's own tokenizer and context gives way to text.
- **`pnpm reindex`** rebuilds an index from the library, keeping titles.
  Schema v5 (`references` kind, tightened constraints) requires it.
- **The model is pinned by SHA-256.** fastembed 3 downloads it from Hugging
  Face (identical weights); the `tar` override, patch and CI check are gone.
- **A scanned PDF can no longer hang the ingest queue** when OCR language data
  cannot load, a failed OCR pool build is retried, and OCR workers are released
  after five idle minutes.
- **docx:** text in content controls is read; heading levels resolve through
  `styles.xml`, so localized and custom heading styles work.
- **Fixed:** case-folded supersede evicting a different file on Linux;
  `delete_document` refusing a crashed ingest forever; `--flag=` values
  containing `=` truncated; the FTS count check could never disagree.
- **Tool annotations** (read-only, destructive, idempotent), `source_path` in
  the library listing, version from package.json. MCP SDK 2.3.1, pdfjs 6.4.

### Earlier

A security pass over everything since the initial release. The reasoning and the
measurements are in [SECURITY.md](SECURITY.md); what changed is here.

- **A crafted `.docx` can no longer stall the server.** Zip entry names are not
  unique, so the 20 MB per-entry cap never bounded the archive: thousands of
  records sharing one name all passed the DOCX reader's four-name filter and
  were all inflated, each overwriting the last. Measured at 4.0 GB and 8.9
  seconds from 3.7 MB of input, during which the synchronous unzip answered
  nothing. Repeated names are now skipped, with 80 MB per archive as a hard stop.
- **Files above 512 MB are refused before being read** (`--max-file-mb`,
  `DOCUMENT_INDEX_MAX_FILE_MB`). A document is read whole into memory and text
  formats decoded on top of that; the only prior ceiling was Node's own, which
  is a crash rather than a refusal.
- **No error reply carries an absolute path.** Scrubbing moved from the four
  filesystem errors with a written message to every reply that leaves — an
  allowlist of error codes is always one short, and `ELOOP` was the one missing.
- **The conversion script disables macros before opening anything.**
  `scripts/convert-for-ingest.ps1` is where this project hands an untrusted
  document to a program that will run what is inside it. It now forces
  `AutomationSecurity` off rather than inheriting the Trust Center's setting,
  stops links and DDE fields updating on open, and suppresses the alert that hung
  an invisible application on a password-protected file.
- **Releases no longer attach an installable archive.** `npm install`ing it
  resolved `fastembed`'s own `tar` range rather than the pinned one, and that tar
  unpacks a model downloaded without an integrity check. `pnpm pack` still runs
  in CI as a test. Distribution is by cloning, as SECURITY.md already said.
- **The `tar` override is asserted, not assumed.** CI asks the resolver what
  `fastembed` loads and fails on a `tar` 6, since a regenerated lockfile would
  otherwise drop the override silently — and npm Dependabot updates, which
  regenerate exactly that file, are now on. The model cache key changed once too:
  a permanently warm cache meant the patched extract path had never run in CI.
- **Workflow checkouts no longer persist the GitHub token**, including the
  release job, which holds `contents: write` and then runs the test suite.
- **The test suite no longer loads the embedding model.** The end-to-end file
  was the only thing that did, at 11.1 of the suite's 12 seconds, to assert
  things that are not claims about embedding quality. It uses a hashing
  bag-of-words stub — real word-overlap similarity, not noise, so the fused
  ranking stays stable and the assertions still mean what they say. That file
  went 11.1s to 1.7s. `DOCUMENT_INDEX_TEST_REAL_MODEL=1` runs against the real
  model; CI does that on one job and every release does it, since no stub covers
  the download, the patched tar extract or ONNX loading.

## 0.1.0

Initial release, developed privately under the name Scholar MCP.

- Indexes a folder of documents into one SQLite file and answers queries through
  five MCP tools: `search_document`, `get_document_outline`, `get_chunk_context`,
  `ingest_document`, `delete_document`.
- Reads Markdown, plain text, PDF — including scanned PDF, through in-process
  OCR that decides per page — and Word. Format is decided by content, not by
  file extension.
- Every result carries where it came from: a page number, the printed page label
  where it differs from the physical one, or a section path built from headings
  and embedded bookmarks. A quotation can be checked against the original file.
- Search returns snippets and never document bodies. That is structural rather
  than conventional — the output schema for a search hit has no text field at
  all. `get_chunk_context` is the only tool that returns body text, hard-capped
  at 24,000 characters, trimmed from the edges of the window so the passages it
  does return are always contiguous.
- A chunk never spans two pages or two sections, so a citation cannot point at a
  page that only holds part of what it quotes.
- Hybrid search fuses BM25 and semantic ranking. The fusion is tuned against a
  checked-in set of 51 questions over ten open-access documents, reported by
  `pnpm eval` as recall@1/3/5 and mean reciprocal rank for lexical, semantic and
  hybrid separately. The tuning moved recall@1 from 32% to 43% and recall@3 from
  52% to 64%.
- The library root is a security boundary. Paths outside it are refused, so are
  symlinks that lexically pass but physically escape, and an extension allowlist
  keeps files like `.env` from being addressable at all.
- Makes exactly two outbound requests, both one-time downloads of its own
  machinery and neither carrying any document text: the ~130 MB embedding model
  from Google Cloud Storage on first ingest, and ~3 MB of OCR language data from
  a CDN on the first scanned PDF. Both are cached and neither repeats.
  `--ocr-lang-path` points OCR at a local copy and removes the second. A library
  with no scanned PDFs never makes it in the first place.
- Concurrent ingests are safe across processes, and an interrupted one is
  recovered rather than left half-indexed. Claude Desktop starts two processes
  per server, which is why this is a lease on a row rather than a lock on a file.
- The EPUB and PowerPoint readers were removed before release rather than
  finished. Both could cite confidently and wrongly — an EPUB locator named a
  spine file while calling it a chapter, and a chart-built deck indexed its
  titles and none of its data. Neither had read a single file in real use. Run
  `scripts/convert-for-ingest.ps1` on a deck to get a slide PDF plus a
  speaker-notes file, and ingest both.
- A vector-index fix cut a real 71-document library from 113 MB to 9.2 MB. The
  default block allocation was costing 1.5 MB per document whether it held three
  chunks or a thousand, so the index scaled with file count rather than content.
- `--ocr-lang-path` / `DOCUMENT_INDEX_OCR_LANG_PATH` points OCR at a local
  directory of tesseract language data instead of the CDN. It accepts either the
  gzipped form the npm packages ship or the plain files `tessdata_fast` and
  `tessdata_best` publish, since tesseract.js asks for one filename or the other
  and does not sniff.
- `tar` is pinned ahead of what `fastembed` asks for. Its declared range ends at
  a version with twelve advisories against it and no patched successor, so
  `pnpm-workspace.yaml` overrides it and patches the single import that would
  otherwise stop the server starting. `pnpm audit` reports nothing.

**Corrections made just before this release, recorded because the documents were
wrong rather than merely incomplete.** Four documents claimed the embedding model
was the only outbound request, which overlooked the OCR language download, and
several comments attributed the model to HuggingFace when it comes from Google
Cloud Storage. A literal NUL byte in `ocrPool.ts` had made that one file look
binary to git and to every search tool since it was written; `src/sources.test.ts`
now fails the build on any raw control character, which is the check
`docs/gotchas.md` had asked for and nobody had written.

**Supported platforms are Windows x64, Linux x64 and macOS.** The embedding
model's tokenizer ships binaries for exactly those three, so on Linux arm64, on
Alpine, or on Windows-on-ARM the install succeeds and the first search then
fails from inside a dependency. The slide-deck converter is narrower still: it
drives Word and PowerPoint through COM, so it needs Windows with Microsoft
Office installed and has no macOS or Linux equivalent.

There is no schema migration — a version bump means deleting the index and
re-ingesting, which the error message says. Embeddings are English-only, so a
multilingual library retrieves poorly. And the fusion score orders results
without measuring relevance, so a search of a library that does not cover your
question still returns a confident-looking five.
