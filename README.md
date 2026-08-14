# Document Index MCP

Indexes documents on your computer so AI agents can retrieve only the relevant, source-located
passages.

Point it at a folder of PDFs, Word files and Markdown. It builds one SQLite index on your machine.
An agent can then search that library and read short, bounded passages — each carrying the page or
section it came from, so a quotation can be checked against the original.

Uploading a folder of course PDFs into an AI chat is slow, unreliable and expensive in context. This
retrieves locally instead: embedding runs on your CPU, search returns snippets rather than documents,
and a body read is hard-capped.

**Status: beta.** Four formats, all load-bearing: Markdown, plain text, PDF — including scanned PDFs,
via automatic in-process OCR — and Word.

EPUB and PowerPoint readers existed and were **removed** in August 2026 rather than finished. Both
could cite confidently and wrongly — an EPUB locator named a spine file while calling it a chapter, a
chart-built deck indexed its titles and none of its data — and neither had read a file in real use. A
format that can mislead is worse than one that is absent. [docs/roadmap.md](docs/roadmap.md) has the
full reasoning.

For a slide deck, convert it first and ingest both outputs — a PDF of the slides, one page each, and a
Markdown file of the speaker notes:

```bash
pwsh scripts/convert-for-ingest.ps1 "C:\Users\you\Library\Lectures" -Recurse
```

Both matter. A PDF export drops speaker notes entirely, and on a real 28-slide deck 22 slides carried
notes holding figures that appear nowhere in the slide text — the slides were artwork.

⚠️ **That script is Windows-only.** It drives your installed Word and PowerPoint through COM, so it
needs Microsoft Office. On macOS and Linux a deck has no route in at all: convert it to PDF by
whatever means you already have and ingest that, knowing the notes are lost.

---

## Install

Requires **Node 22 or newer** (developed on 24), on **Windows x64, Linux x64 or macOS**. That limit is
inherited rather than chosen — the embedding model's tokenizer ships binaries for exactly those
targets. On Linux arm64, Alpine or Windows-on-ARM the install succeeds and the first search then fails
from inside a dependency, which is a miserable way to find out.

```bash
git clone https://github.com/ekelly95/document-index-mcp.git
cd document-index-mcp
pnpm install
pnpm build
```

Then choose a **library root**: one folder holding the documents you want indexed. It is a security
boundary as well as a convenience — the server refuses to read anything outside it, including through
a symlink that lexically passes but physically escapes.

Pick it before you ingest anything. `source_path` is stored relative to the root and there is no
rebase command, so moving the root later silently stops every existing row resolving.

### Register with Claude Desktop

Merge this into `claude_desktop_config.json` — never overwrite it, the file also holds your
preferences. It lives at `%APPDATA%\Claude\claude_desktop_config.json` on Windows, and
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

```json
{
  "mcpServers": {
    "document-index": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/document-index-mcp/dist/index.js"],
      "env": {
        "DOCUMENT_INDEX_LIBRARY_PATH": "/absolute/path/to/your/library"
      }
    }
  }
}
```

Use the **absolute** path to the Node binary: a GUI-launched application does not reliably inherit
your shell PATH. Then quit Claude Desktop completely and reopen it — on Windows it persists in the
system tray, so closing the window is not enough.

### Register with Codex

```toml
[mcp_servers.document-index]
command = '/absolute/path/to/node'
args = ['/absolute/path/to/document-index-mcp/dist/index.js']
startup_timeout_sec = 30

[mcp_servers.document-index.env]
DOCUMENT_INDEX_LIBRARY_PATH = '/absolute/path/to/your/library'
```

### First run

The first ingest downloads the embedding model (`bge-small-en-v1.5`, ~130 MB) into
`<library>/.document-index/models`, once. Searching is entirely local. [Privacy](#privacy) has the
whole network story — it is two downloads and nothing else.

For a whole library at once, use the bulk CLI rather than ingesting file by file in chat:

```bash
pnpm ingest --library=/path/to/your/library "Papers" --recursive
```

⚠️ **Name a subdirectory rather than `.` unless you are certain what is under the root.**
`--recursive` walks the entire tree, skipping only dot-directories, so a root with an application-data
directory beneath it turns one command into a multi-hour sweep that fills the index with junk. This is
the main argument for a dedicated library folder rather than your home directory.

A document is read whole into memory, so files above 512 MB are refused rather than attempted. Raise
it with `--max-file-mb=` or `DOCUMENT_INDEX_MAX_FILE_MB`; the refusal names both the file's size and
the limit, so you know which to change.

---

## Formats

| Format | Locators | Structure comes from | Known limits |
|---|---|---|---|
| `.md` | `section` (`sec-N`, advancing at each H1/H2) | ATX headings | Block text is sliced from the source, never re-serialized |
| `.txt` | `section` | Setext underlines, numbered sections, ALL-CAPS lines, named divisions | A flat outline may be correct rather than a failure |
| `.pdf` | `page`, plus `printed_label` where the printed number differs | Embedded bookmarks refined by font-size tiers | Sideways margin text is dropped as furniture; scans and mojibake escalate to OCR, or are refused under `--ocr=off` |
| `.docx` | `section` | Heading styles (`Heading1`–`6`, `Title`) | Headers, footers, comments and tracked-change machinery are never read. Deletions cannot leak: only `w:t` is read, never `w:delText` |
| `.epub` | — | — | Removed, not deferred. Recognised by content sniffing and refused by name, with the reason |
| `.pptx` / `.ppt` | — | — | Removed. Run `scripts/convert-for-ingest.ps1` for a PDF plus a speaker-notes file, and ingest both |
| `.html` | — | — | Recognised by content sniffing and refused with a reason |
| `.doc` | — | — | Legacy binary Word: refused, pointing at `scripts/convert-for-ingest.ps1`, which converts it through Word itself |

Format is decided by content, not by file extension.

### Scanned PDFs

A PDF whose sampled pages are essentially imagery — or whose text layer decodes to noise — is routed
through in-process OCR (tesseract.js, WASM, nothing to install). The decision is re-made per page, so
a scanned book's digitally typeset title page keeps its real text and only the scanned pages pay for
recognition.

It is slow and visibly so: roughly 1–5 seconds per page per worker, making a 400-page scan tens of
minutes. `get_document_outline` reports `chunk_count` rising against `locator_count` throughout.

| Flag | Environment variable | Default |
|---|---|---|
| `--ocr=auto\|off` | `DOCUMENT_INDEX_OCR` | `auto` |
| `--ocr-lang=` | `DOCUMENT_INDEX_OCR_LANG` | `eng` |
| `--ocr-workers=` | `DOCUMENT_INDEX_OCR_WORKERS` | `2` |
| `--ocr-lang-path=` | `DOCUMENT_INDEX_OCR_LANG_PATH` | the CDN |

The embedding model is English-only, so a multilingual library retrieves poorly. See
[docs/roadmap.md](docs/roadmap.md).

---

## The five tools

| Tool | What it does |
|---|---|
| `search_document` | Hybrid BM25 + semantic search. Ranked snippets with locators. The usual starting point. |
| `get_document_outline` | Heading tree with chunk ranges. Also lists the library, and reports ingest progress. |
| `get_chunk_context` | The only tool that returns body text, hard-capped at 24,000 characters. |
| `ingest_document` | Index a file. Returns immediately; indexing continues in the background. |
| `delete_document` | Drop a document from the index. Never touches the file on disk. |

The normal workflow is three cheap steps: **`search_document`** for ranked snippets, each already
naming its document and locator; **`get_document_outline`** to orient inside the one that looks right,
if needed; **`get_chunk_context`** to read the passage and its neighbours, addressed by `chunk_id`
from the hit or `document_id` + `seq` from the outline.

Search never returns full document bodies. That is structural rather than conventional: the output
schema for a search hit has no text field at all, so a refactor cannot quietly regress it.

### With YouTube Transcript Notes

[YouTube Transcript Notes](https://github.com/ekelly95/youtube-transcript-notes) captures a video as
faithful, timestamped Markdown. Ingest that here and the whole chain stays checkable:

```text
YouTube video
  → YouTube Transcript Notes  → timestamped Markdown
  → Document Index MCP        → bounded passages with source locations
  → your agent                → notes or synthesis you can verify
```

The transcript's wording and clickable timestamps survive ingestion unchanged, so a claim in the final
synthesis traces back to the second of video it came from.

---

## Privacy

Documents are read from your disk and indexed into one SQLite file under your library root. Search,
ranking and passage retrieval are entirely local: no document text is sent anywhere except to the AI
client you deliberately connected.

The server makes exactly two outbound requests, both one-time downloads of its own machinery, neither
carrying any part of your documents:

- the embedding model (~130 MB) from `storage.googleapis.com/qdrant-fastembed`, on first ingest;
- OCR language data (~3 MB per language) from `cdn.jsdelivr.net`, on the first *scanned* PDF only. A
  library with no scans never makes this one, and `--ocr-lang-path=<dir>` removes it entirely by
  pointing at your own copy from
  [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast).

Both are cached and neither repeats. **Neither is integrity-checked** — no checksum, no signature, on
either one; only the transport is trusted. That is recorded in [SECURITY.md](SECURITY.md) alongside
what it does and does not imply.

The library root is a jail: paths outside it are refused, symlinks that escape it are refused, and an
extension allowlist keeps files like `.env` from being addressable at all. Results expose a
library-relative path, never an absolute one — including in error messages.

One caveat worth stating plainly. The allowlist stops secrets being addressable; it does not stop a
private notes tree *inside* the root being addressable. Choose a root wide enough to hold your
documents and no wider.

---

## Development

```bash
pnpm install
pnpm build
pnpm test      # tsc, then the full suite
pnpm inspect   # MCP Inspector
```

The suite covers the chunker's boundary law, the path jail, index agreement across chunks/FTS/vectors,
PDF probe refusals and real OCR over generated scan imagery, concurrent-ingest safety and lease
recovery, hybrid fusion, and the five tools end to end over a real MCP client.

Three things to know. **Never pipe the test run** — a `| tail` once masked a failure here. **One test
skips on Windows**: the symlink-escape case in `paths.test.ts` needs Developer Mode or an elevated
shell, and CI runs it on Linux. And there are **no binary test fixtures** — PDFs are hand-assembled at
test time, cross-reference table and all, and scanned pages are drawn onto a canvas and embedded as a
JPEG XObject, so OCR is tested against genuine imagery without a blob in the repository.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest, including what will fail review.

### Retrieval evaluation

```bash
pnpm eval --library=/path/to/corpus --questions=eval/questions.json
```

Reports recall@1/3/5 and mean reciprocal rank for lexical, semantic and hybrid search separately. The
test suite proves the machinery is correct and deterministic, which is a different claim from the
ranking being good; this measures the second one, and stops a tuning change quietly regressing it.

### The stress corpus

Parser behaviour is measured against ten open-access documents, each chosen because it breaks a
different assumption. They are too large for git, so
[corpus/manifest.json](corpus/manifest.json) records every source, licence and SHA-256:

```bash
node scripts/corpus.mjs list                           # sources and re-download URLs
node scripts/corpus.mjs verify --dir=<corpus>/docs     # confirm nothing has drifted
```

A second set of six openly licensed slide decks tests the conversion route rather than a parser
(`--dir=<corpus>/decks --set=decks`). Those found two PDF-reader defects, both fixed, and confirmed
the thing worth knowing about decks: a 51-slide survey report whose chart categories and percentages
pass straight through conversion into searchable text.

---

## Design notes and limitations

The engineering record lives in `docs/`, and is worth reading before changing anything:

- **[docs/design.md](docs/design.md)** — the three ideas the architecture rests on, and every
  deliberate deviation from the original specification with its reasoning.
- **[docs/gotchas.md](docs/gotchas.md)** — the accumulated sharp edges, most of them bugs first. Each
  is a trap a reasonable change would walk straight back into.
- **[docs/roadmap.md](docs/roadmap.md)** — what is built, what was cut and why, and the loose ends
  stated honestly. The largest: the fusion score orders results without measuring relevance, so a
  search of a library that does not cover your question still returns a confident-looking five.

## Licence

MIT. See [LICENSE](LICENSE), and [NOTICE.md](NOTICE.md) for the dependency choices that keep it
permissive — chiefly why PDF parsing uses `pdfjs-dist` rather than the AGPL library the specification
named.

Changes are in [CHANGELOG.md](CHANGELOG.md); the security model and how to report a vulnerability are
in [SECURITY.md](SECURITY.md).
