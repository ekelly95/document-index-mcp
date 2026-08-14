# Roadmap and known limitations

What is built, what was cut, and what is still wrong. The phase numbers record the order things were
promised in, not the order they landed.

## Cut on 2026-08-13: EPUB and PowerPoint

Both had working, tested parsers. Both were deleted rather than finished — the most consequential
decision in the project's history, so the reasoning belongs at the top.

**The evidence that decided it.** The real library then held 71 documents and 961 passages: 41
Markdown, 25 PDF, 2 scanned PDF via OCR, 3 Word. Zero EPUB. Zero PowerPoint. Markdown and PDF were
97% of every indexed passage. The two formats being carried were the two that had never read a file,
and they were a third of the parser surface — 1,718 lines of parser, test and fixture code.

**Why a cut and not a deferral.** Both could produce a citation that was confident and wrong, the one
failure this whole design exists to prevent:

- An EPUB `part` locator was a spine file. Project Gutenberg packs Moby-Dick's 135 chapters into 12
  files, so a passage from Chapter 8 cited as `part-02`. Renaming `chapter` to `part` made the
  locator honest about what it was, and no more useful. Deriving real chapter locators from the
  book's navigation was future work that never came.
- A PowerPoint deck's chart categories and values live in `ppt/charts/chartN.xml`, which the reader
  never opened. Measured on a real seven-slide deck: five slides were built around a chart, so what
  got indexed was the title and a one-line summary. The chart warning added in August made that
  visible rather than silent — it did not make the deck searchable.

Three further defects were recorded and never fixed: an EPUB `<h2>` chapter title matching the toc
entry duplicated itself as its own child, an illustration caption could fuse onto the next part's
title, and every `<pre>` became `kind: "code"`, so a novel's verse was excluded from a `kind: "text"`
search.

A format that is absent is a clear answer. A format that misleads costs more than it returns. Both
are now recognised by content sniffing and refused **by name** — `src/pipeline/router.ts`'s `NOT_YET`
table — because "this is an EPUB and I do not read EPUBs" is usable and "this file appears to be
binary" is not. `.epub`, `.pptx` and `.ppt` are also off the extension allowlist, so the common case
is refused before the file is read.

**What was kept from the work.** EPUB was the phase that proved the architecture: the chunker, the
outline builder and the retrieval layer took no changes to absorb an entirely new format shape. That
lesson is banked in `docs/design.md` and did not require keeping the code. The shared zip and XML
kit (`src/pipeline/zip.ts`, `src/pipeline/parsers/xml.ts`) stays — DOCX uses it, and the format
sniffer still walks any zip's central directory to tell docx, pptx and epub apart.

**What was lost.** The chunker's *second* boundary rule — never cross an H1/H2 **inside** one
locator — existed only for `part`, where a single spine file could run for dozens of pages and
several chapters. It went with the format. `boundaryKey` in `src/pipeline/chunker.ts` records why,
because any future locator that can span many headings needs it back.

**Retrieval improved, and not for the reason it looks like.** The eval set lost its 5 EPUB/PPTX
questions and the corpus 4 documents, including three novels, one Spanish against an English-only
model. Every mode scored higher. **That is a smaller and easier corpus, not a better ranker** — the
numbers are under *Retrieval is now measured* below, with the caveat that matters.

**Phase 4 — hardening.** Landed ahead of EPUB, because an audit found most of what was open was not
polish. One library path holds one document, and a superseded version now survives a replacement
that fails halfway. A document is read from disk **once** and hashed from those same bytes, so its
sha256 cannot describe a revision its chunks do not — previously a PDF was read and parsed three
times per ingest and the hash came from a fourth, earlier read. Ingests are bounded by a
process-wide queue, default concurrency 1. Shutdown drains in-flight indexing rather than discarding
it, triggered by stdin close as well as signals: on Windows SIGTERM is not delivered and SIGINT
reaches only console-attached processes, so under a GUI host like Claude Desktop the signal handlers
may never fire. Lifecycle events and failures go to stderr, since a failed background ingest used to
leave no trace anywhere a person would look.

Still open, in value order: startup reconciliation of chunk/FTS/vector counts (`indexCounts()`
already exists and is called only by the CLI), a `search_fts` rebuild command, schema-migration
scaffolding (the v1→v2 bump for `ts-ocr` shipped without it — the index is derived data, so the
migration is delete-and-re-ingest, and `openDatabase` says so). None of them block EPUB.

**The fast/real-model test split is done.** The end-to-end file was the only thing loading the
130MB ONNX model, and at 11.1 of the suite's 12 seconds it was most of what a test run cost — paid
by everyone, on every run, to assert things that are not claims about embedding quality. It now uses
a hashing bag-of-words stub (`src/testing/stubEmbedder.ts`), which is deliberately not noise: real
word-overlap similarity keeps the semantic leg sane, so the fused ordering stays stable and the
assertions still mean what they say. That file went 11.1s to 1.7s and the suite 10.8s to 7.6s, where
the long pole is now real OCR, which is worth what it costs.

`DOCUMENT_INDEX_TEST_REAL_MODEL=1` runs it against the real model. CI does that on one job rather
than six, and the release workflow always does — a stub cannot stand in for the download, the tar
extract the fastembed patch touches, or ONNX loading, and those breaking means every new user's
first ingest fails.

**Cross-process is now closed** — it used to be the one real gap. `recoverInterrupted` reset *every*
`processing` row at startup, so running `pnpm ingest` while the server was mid-ingest cleared the
server's claim and deleted its chunks, and the server then finalised the document as `ready` with a
`chunk_count` that no longer matched the table. The lease closed it: recovery reaps only claims whose
lease has expired, so `processing` means owned *while `updated_at` is fresh* — a rule `claimForIngest`
applies too, inside a `BEGIN IMMEDIATE` transaction. A live writer's work is untouchable from another
process, and one crash can no longer make a file permanently un-ingestable.

`src/db/processLock.ts` sits alongside that as a `<db>.lock` naming one process, reclaimed
automatically when its owner is no longer running. It no longer decides who may *open* the index,
because it cannot: Claude Desktop starts **two** processes for every MCP server, and refusing the
second killed it on every launch. It still decides which process runs startup recovery, and whether
`pnpm ingest` may run — the CLI wants the index to itself, a resource judgement rather than a safety
one.

**Deferred:** the `html` parser, then the Tasks extension. `docx` jumped the original queue in August
2026 and earned its place; `pptx` jumped with it on the theory that lecture slides would be a primary
input, and that theory was wrong — see the cut at the top. In-process tesseract.js took the Docling
sidecar's slot; Docling remains the upgrade path if scans ever need real layout analysis (tables,
reading order) rather than paragraph recovery, and the `docling-ocr` engine value is reserved for it.
None block anything above.

**The conversion route, `scripts/convert-for-ingest.ps1`.** Drives the installed Word and PowerPoint
through COM — the highest-fidelity converter there is, being the program that wrote the files.
Output lands beside the original, an existing target is never overwritten, originals are never
modified. Run it against a file or a folder (`-Recurse` for a tree), then ingest what it produced.
`.doc` becomes `.docx`; `.ppt` and `.pptx` become a PDF **plus** a `-notes.md` of the speaker notes.
It force-disables macros before opening anything — see `SECURITY.md`.

The notes file is the half that is easy to forget. Measured on the 28-slide NASA deck: the PDF gives
one page per slide, a bookmark naming each, and chart and SmartArt labels surviving as real text
because they were rendered rather than parsed — but it discards speaker notes entirely, and 22 of
those 28 slides carried notes holding temperature and orbital figures appearing **nowhere** in the
slide text, because the slides are artwork. PDF alone would have indexed the captions of a lecture
and none of its content.

Two smaller costs, recorded so nobody rediscovers them. A table stops being a table (everything
renders as prose, so `filter.kind: table` will not find it). And slide footers re-enter the text,
since a rendered page cannot distinguish chrome from content — on that deck 27 of 28 chunks carry a
date-and-URL footer worth roughly a tenth of each chunk. That footer date is a live field, so
re-converting the same deck in a different month changes every page and its sha256, and the index
treats it as a new document rather than a no-op re-ingest.

**The chart gap is closed, by conversion rather than by a parser.** This was the whole reason the
PPTX reader counted as incomplete, and a corpus of six decks retired it. Measured on a 51-slide
survey report, 30 of whose slides are built around a chart: converted to PDF it yields 94 chunks
averaging 182 tokens, and the chart data arrives as text —

```
Are you a member of, or participate in:    % of respondents (314)
Relative Hills Society (111) 35%
The Relative Hills of Britain Facebook group (104) 33%
```

— because PowerPoint draws chart labels as real text runs when it renders. That is *better* than
reading `c:cat` and `c:val` out of the chart parts, since the labels arrive in reading order beside
their categories rather than as bare parallel arrays. Anyone weighing a restored PPTX reader should
start here: its one open defect is already answered, and what remains of the case is table `kind` and
footer chrome.

Those six decks also found two **PDF** reader defects, both fixed and tested: `usableTitle` rejected
placeholder titles only in English, so a Spanish deck indexed as `Presentación de PowerPoint`; and a
bookmark's internal whitespace reached the section path, making a centred slide title a
`section_prefix` segment no caller could reproduce.

Hidden slides are excluded from **both** outputs, because PowerPoint leaves them out of the PDF and
including their notes would make the two files disagree about what the deck contains. Both keep the
deck's own numbering, so they skip the same numbers and the PDF's page numbers run behind them; the
script says so when it happens.

**Where the corpus came from.** Everything above about real PDFs was measured against a separate
stress corpus — open-access, public-domain or sample documents, each chosen because it breaks a
different assumption, with its own index so it can never pollute a real library. Fourteen documents
originally; the three EPUBs and the slide deck left with their readers, leaving ten. Its
`FINDINGS.md` records ten defects: the five in the PDF reader are fixed, the five in the EPUB and
PowerPoint readers were closed by deletion. That file lives with the corpus — 175 MB of binaries,
outside this repository — not here.

Too large for git, so `corpus/manifest.json` records every source, licence and SHA-256, and
`scripts/corpus.mjs verify --dir=<corpus>/docs` confirms the folder in front of you is the one those
findings were measured against. Alongside it, `probe.mjs` walks one file through
`openSource → routeDocument → chunkBlocks → OutlineBuilder` and prints the outline and locators
without touching a database — the fastest way to see what a parser did to a file.

**The incomplete-document channel outlived its only user.** `ingest_warning` on the document row —
surfaced in the `ingest_document` reply, `get_document_outline`'s detail view, and as an "indexed
incomplete" flag in the library listing — existed so a chart-bearing deck could never look fully
indexed while its main evidence was absent. Nothing sets it now. It stays because it is the general
way a parser admits partial coverage, and because dropping a nullable column would need a schema
bump, which costs a full re-ingest of every library including its OCR. See `DocumentMetadata.warning`
in `src/pipeline/ir.ts`.

**Retrieval is now measured, and the default was wrong.** Until 2026-08-13 nothing in the test suite
would have noticed the ranking getting worse — the tests prove filters and determinism, which is a
different claim. `eval/questions.json` fixes that: questions over the stress corpus, spanning
prose, tables, exact identifiers, paraphrases and multi-document ambiguity, with recall@1/3/5 and MRR
reported per mode by `pnpm eval`.

The first run found the shipped default losing to a mode it already contains. Two changes fixed it —
the fusion constants, and putting the document title into the embedded text (schema v4). Measured on
the original 56 questions over 14 documents:

| Mode | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|
| lexical only | 27% | 38% | 45% | 0.333 |
| semantic only | 39% | 57% | 64% | 0.501 |
| hybrid, `k = 60` unweighted (old) | 32% | 59% | 68% | 0.465 |
| hybrid, `k = 2`, semantic ×1.5 (now) | **43%** | **64%** | 66% | **0.548** |

The current baseline, after EPUB and PowerPoint left — 51 questions over 10 documents. **Not
comparable to the table above:** the corpus lost three novels, one of them Spanish against an
English-only model, so it is easier as well as smaller. Recorded so a future regression has a line
to cross.

| Mode | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|
| lexical only | 29% | 43% | 47% | 0.365 |
| semantic only | 43% | 61% | 67% | 0.536 |
| hybrid, `k = 2`, semantic ×1.5 | **51%** | **69%** | **71%** | **0.607** |

A re-sweep on the reduced corpus still picks `k = 2, ×1.5` as the winner by both MRR and R@1, which
is the useful finding: the tuning was not fitted to the documents that left.

The cause was in the arithmetic, not the embeddings. At `k = 60` with ten candidates a leg, every
rank from 1 to 10 scores within 14% of every other, so two legs each ranking a chunk tenth outscored
either leg ranking one first: the fusion was voting on agreement rather than ranking on conviction.
Harmless when both legs are competent, and the lexical leg answers 12% of paraphrased questions
inside the top three. Per type, `paraphrase` (n=25) went from **32% to 60%** at recall@3, matching
the semantic leg it had been dragging down, while `identifier` (n=4) held at 75% against
semantic-only's 50% — which was the risk in reweighting.

**The optimum moved when the embedding input changed**, which is the kind of thing that gets
forgotten. Adding the title to the embedded text shifted the best setting from `k = 10, ×2` to
`k = 2, ×1.5`, and briefly cost `identifier` 25 points at the old constants before the re-sweep.
Anything changing what goes into the vector invalidates the tuning, not just the constants.

Two honest caveats. The questions were written after reading the passages that answer them, so this
measures ranking rather than discovery. And the winning configuration was chosen by MRR on the same
questions it is scored against, so the exact peak is fitted — what justifies the change is the
plateau around it, every setting with `k <= 5` and semantic weight `>= 1.5` clearing both the old
default and semantic-only on either corpus. A held-out set is the obvious next improvement.

**Schema v4 also stopped the index scaling with file count.** vec0 allocates vector storage a block
at a time and `vec_chunks` is partitioned per document, so the default `chunk_size = 1024` cost every
document 1.5 MB whether it held three chunks or a thousand — the mechanism and the arithmetic are in
`docs/gotchas.md`. At `chunk_size = 64` the stress corpus went from 47.3 MB to 33.1 MB, padding
falling from 14.5 MB to 0.7 MB. A small-document library improves by far more, since the waste was
per file.

**The largest known defect: search cannot say it found nothing.** `search_document`'s `score` is an
RRF fusion value — it orders results and does not measure relevance — so `k` hits come back whatever
was asked. Demonstrated on the real library: the query `zzzq purple elephant tractor lambda` returned
five ranked passages with page numbers, indistinguishable in shape from five right answers. An agent
asking about a topic the library does not cover gets confident-looking material and no signal to
distrust it, which is precisely the failure the PDF probe and the empty-document refusal exist to
prevent everywhere else in the pipeline. A threshold needs a measure that is comparable across
queries, so it needs either a calibrated score or a second-stage reranker. This should be the next
thing built.

**Other loose ends.** There is still no schema migration: every bump is delete-and-re-ingest, which
has now been paid twice and costs an OCR re-run each time. The embedding model is downloaded on first
run with no integrity check, and `bge-small-en-v1.5` is English-only, so a multilingual library
retrieves poorly. Two intentional copies of one file cannot coexist as separate library entries,
because sha256 is the document identity — which also means the same note held as both `.md` and
`.pdf` indexes twice and halves the diversity of a top-5.
Embedding runs ~50ms/chunk on CPU, so a 400-page book takes ~105s to index; acceptable for
fire-and-forget, and the ceiling is `MAX_TOKENS`, not batch size.
