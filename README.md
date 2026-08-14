# Document Index MCP

Indexes documents on your computer so AI agents can retrieve only the relevant, source-located
passages.

Point it at a folder of PDFs, Word files and Markdown. It builds one SQLite index on your machine.
After that an agent can search that library and read short, bounded passages — each one carrying the
page or section it came from, so a quotation can be checked against the original.

Uploading a folder of course PDFs into an AI chat can be slow, unreliable, and expensive in context.
This does the retrieval locally instead: the embedding work runs on your CPU, search returns snippets
rather than documents, and a body read is hard-capped. Nothing about your library leaves the machine.

**Status: beta.** Four formats, all of them load-bearing: Markdown, plain text, PDF — including
scanned PDFs, via automatic in-process OCR — and Word.

EPUB and PowerPoint readers existed and were **removed** in August 2026 rather than finished. Both
could cite confidently and wrongly: an EPUB locator named a spine file while calling it a chapter,
and a deck built around charts indexed its titles and none of its data. Neither had read a single
file in real use. A format that can mislead is worse than a format that is absent, and the code that
supported them was a third of the parser surface. See [docs/roadmap.md](docs/roadmap.md) for the
full reasoning.

For a slide deck, run `scripts/convert-for-ingest.ps1` on it and ingest what comes out — a PDF of the
slides, one page each, and a markdown file of the speaker notes:

```bash
pwsh scripts/convert-for-ingest.ps1 "C:\Users\you\Library\Lectures" -Recurse
```

Both files matter. A PDF export drops speaker notes, and measured on a real 28-slide deck, 22 slides
carried notes holding figures that appear nowhere in the slide text — the slides were artwork.

---

## Install

Requires **Node 22 or newer** (developed on 24).

```bash
git clone https://github.com/ekelly95/document-index-mcp.git
cd document-index-mcp
pnpm install
pnpm build
```

Then choose a **library root** — one folder containing the documents you want indexed. This is a
security boundary as well as a convenience: the server refuses to read anything outside it, including
through a symlink that lexically passes but physically escapes.

Pick it before you ingest anything. `source_path` is stored relative to the root and there is no
rebase command, so moving the root later silently stops every existing row resolving.

### Register with Claude Desktop

Merge this into `claude_desktop_config.json` — never overwrite it, the file also holds your
preferences. On Windows it is at `%APPDATA%\Claude\claude_desktop_config.json`; on macOS,
`~/Library/Application Support/Claude/claude_desktop_config.json`.

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

Use the **absolute** path to the Node binary. A GUI-launched application does not reliably inherit
your shell PATH.

Then quit Claude Desktop completely and reopen it. On Windows it persists in the system tray —
closing the window is not enough.

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
`<library>/.document-index/models`. That is the only outbound network call the server ever makes;
searching is entirely local.

For a whole library at once, use the bulk CLI rather than ingesting file by file in chat:

```bash
pnpm ingest --library=/path/to/your/library "Papers" --recursive
```

⚠️ **Name a subdirectory rather than `.` unless you are certain what is under the root.**
`--recursive` walks the entire tree, skipping only dot-directories. A root with an application-data
directory beneath it turns one command into a multi-hour sweep that fills the index with junk. This
is the main argument for a dedicated library folder rather than your home directory.

---

## Formats

| Format | Locators | Structure comes from | Known limits |
|---|---|---|---|
| `.md` | `section` (`sec-N`, advancing at each H1/H2) | ATX headings | Block text is sliced from the source, never re-serialized |
| `.txt` | `section` | Setext underlines, numbered sections, ALL-CAPS lines, named divisions | A flat outline may be correct rather than a failure |
| `.pdf` | `page`, plus `printed_label` where the printed number differs | Embedded bookmarks refined by font-size tiers | Sideways margin text is dropped as furniture; scans and mojibake escalate to OCR, or are refused under `--ocr=off` |
| `.docx` | `section` | Heading styles (`Heading1`–`6`, `Title`) | Headers, footers, comments and tracked-change machinery are never read. Deletions cannot leak: only `w:t` is read, never `w:delText` |
| `.epub` | — | — | Removed, not deferred. Recognised by content sniffing and refused by name, with the reason |
| `.pptx` / `.ppt` | — | — | Removed. Run `scripts/convert-for-ingest.ps1` to get a PDF plus a speaker-notes file, and ingest both |
| `.html` | — | — | Recognised by content sniffing and refused with a reason |
| `.doc` | — | — | Legacy binary Word: refused, with a pointer to `scripts/convert-for-ingest.ps1`, which drives the installed Word through COM to convert it |

Format is decided by content, not by file extension.

### Scanned PDFs

A PDF whose sampled pages are essentially imagery — or whose text layer decodes to noise — is routed
through in-process OCR (tesseract.js, WASM, nothing to install). The decision is re-made per page, so
a scanned book's digitally typeset title page keeps its real text and only the scanned pages pay for
recognition.

It is slow and visibly so: roughly 1–5 seconds per page per worker, so a 400-page scan is tens of
minutes. `get_document_outline` reports `chunk_count` rising against `locator_count` throughout.

| Flag | Environment variable | Default |
|---|---|---|
| `--ocr=auto\|off` | `DOCUMENT_INDEX_OCR` | `auto` |
| `--ocr-lang=` | `DOCUMENT_INDEX_OCR_LANG` | `eng` |
| `--ocr-workers=` | `DOCUMENT_INDEX_OCR_WORKERS` | `2` |

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

The normal workflow is three steps, and it is deliberately cheap at each one:

1. **`search_document`** — ask a question, get ranked snippets. Each hit names its source document
   and its locator, so you can already tell *where* the answer lives.
2. **`get_document_outline`** — orient inside the document that looks right, if you need to.
3. **`get_chunk_context`** — read the passage and its neighbours, addressed by `chunk_id` from the
   search hit or by `document_id` + `seq` from the outline.

Search never returns full document bodies. That is structural rather than conventional: the output
schema for a search hit has no text field at all, so a refactor cannot quietly regress it.

### With YouTube Transcript Notes

The companion project captures a YouTube video as faithful, timestamped Markdown. Ingest that
Markdown here and the whole chain stays checkable:

```text
YouTube video
  → YouTube Transcript Notes  → timestamped Markdown
  → Document Index MCP        → bounded passages with source locations
  → your agent                → notes or synthesis you can verify
```

The transcript's wording and its clickable timestamps survive ingestion unchanged, so a claim in the
final synthesis can be traced back to the second of video it came from.

---

## Privacy

- Documents are read from your disk and indexed into one SQLite file under your library root.
- Search, ranking and passage retrieval are entirely local. No document text is sent anywhere except
  to the AI client you deliberately connected.
- The only outbound request the server ever makes is downloading the embedding model on first run.
- The library root is a jail. Paths outside it are refused, symlinks that escape it are refused, and
  the extension allowlist keeps files like `.env` from being addressable at all.
- Search results expose a library-relative path, never an absolute one.

A caveat worth stating: the allowlist stops secrets being addressable, but it does not stop a private
notes tree inside the root being addressable. Choose a root wide enough to hold your documents and no
wider.

---

## Development

```bash
pnpm install
pnpm build
pnpm test      # tsc, then the full suite
pnpm inspect   # MCP Inspector
```

The suite covers the boundary law, overlap containment, printed-page citation, the path jail, index
agreement across chunks/FTS/vectors, PDF probe refusals and OCR escalation, real OCR over generated
scan imagery, two-column reading order, Word note extraction, refusal of the formats this build does
not read, concurrent-ingest safety, failed-replacement survival, lease recovery, shutdown drain,
hybrid fusion and filter pushdown, and the five tools end to end over a real MCP client.

Never pipe the test run. A `| tail` once masked a failure here.

One test skips on Windows: the symlink-escape case in `paths.test.ts` cannot run without Developer
Mode or an elevated shell, because Windows will not let an ordinary user create a symlink. CI runs it
on Linux.

There are **no binary test fixtures**. PDFs are hand-assembled at test time, cross-reference table and
all; scanned pages are drawn onto a canvas and embedded as a JPEG XObject, so OCR is tested against
genuine imagery without a single blob in the repository.

### Retrieval evaluation

```bash
pnpm eval --library=/path/to/corpus --questions=eval/questions.json
```

Reports recall@1/3/5 and mean reciprocal rank separately for lexical, semantic and hybrid search. The
test suite proves the machinery is correct and deterministic, which is a different claim from the
ranking being good — this is what measures the second one, and what stops a tuning change quietly
regressing.

### The stress corpus

Parser behaviour is measured against a corpus of ten open-access documents, each chosen because
it breaks a different assumption. (It was fourteen; the three EPUBs and the slide deck went with
their readers.) The files are too large for git, but
[corpus/manifest.json](corpus/manifest.json) records every source, licence and SHA-256:

```bash
node scripts/corpus.mjs list                           # sources and re-download URLs
node scripts/corpus.mjs verify --dir=<corpus>/docs     # confirm nothing has drifted
```

A second set of six openly licensed slide decks tests the conversion route instead of a parser, since
no reader opens a deck any more:

```bash
node scripts/corpus.mjs verify --dir=<corpus>/decks --set=decks
```

They found two defects in the PDF reader, both fixed: a placeholder title was only rejected in
English, so a Spanish deck indexed as `Presentación de PowerPoint`; and a bookmark's internal
whitespace reached the section path, putting a run of spaces inside a `section_prefix` no caller could
type. They also confirmed the thing worth knowing about decks — a 51-slide survey report whose charts
carry all their categories and percentages straight through conversion into searchable text.

---

## Design notes and limitations

The engineering record lives in `docs/`, and is worth reading before changing anything:

- **[docs/design.md](docs/design.md)** — the three ideas the architecture rests on (structural
  progressive disclosure, the boundary law, the Block IR), and every deliberate deviation from the
  original specification with the reasoning for it.
- **[docs/gotchas.md](docs/gotchas.md)** — the accumulated sharp edges. Ingest ownership and why
  `processing` is the lock, vec0's BigInt rowids, why fastembed's own query helper is not used, why
  control characters must be written as escapes. Most of these were bugs first.
- **[docs/roadmap.md](docs/roadmap.md)** — what is built, what was cut and why, and the known loose
  ends stated honestly: the English-only embedding model, no schema migration, and the fact that the
  fusion score orders results but does not measure relevance — so a search of a library that does not
  cover your question still returns a confident-looking five.

## Licence

MIT. See [LICENSE](LICENSE).
