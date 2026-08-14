# Changelog

Notable changes are listed newest first. Versions follow
[semantic versioning][semver]; releases before `1.0.0` may include breaking
changes.

[semver]: https://semver.org/spec/v2.0.0.html

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
- Runs entirely offline after the first ingest, which downloads the ~130 MB
  embedding model. That is the only outbound request the server ever makes.
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
