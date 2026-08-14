# Security

## Reporting a vulnerability

Open a [private security advisory][advisory]. Do not open a public issue for a
suspected vulnerability.

[advisory]: https://github.com/ekelly95/document-index-mcp/security/advisories/new

This project has no bug bounty. The maintainer aims to reply within two weeks.

## Security model

This is a local MCP server that talks over stdio. It has no network listener, no
account, no hosted API, no database server, and no application secret. It reads
files beneath one directory the user chooses, and writes one SQLite index inside
it. The only outbound request it ever makes is downloading the embedding model
on first run.

The documents are untrusted. A PDF, a Word file or a Markdown note may have come
from anywhere, and the parsers are the attack surface. The server therefore:

- treats the library root as a jail. Containment is checked with
  `path.relative`, never `resolved.startsWith(base)` — a sibling directory named
  `library-secrets` shares the `library` prefix and would pass the `startsWith`
  form while sitting outside the root;
- refuses symlinks that pass the lexical check but physically escape, and uses
  the canonical real path afterwards so one file cannot enter the index under
  two names;
- gates on an extension allowlist, so that pointing the server at a directory
  which also happens to hold `.env` or `id_rsa` does not make those addressable
  at all — the allowlist is a guard, not the format decision, which is made from
  magic bytes downstream;
- reads `.docx` archive entries by fixed name, into memory, never onto disk, and
  never inflates an entry larger than 20 MB uncompressed;
- reads only a Word document's `w:t` runs, so tracked deletions, comments,
  headers and footers cannot reach the index and cannot be searched out of it;
- never lets query text become query syntax: search terms are extracted and
  quoted individually before reaching FTS5, and every SQL statement is
  parameterised;
- returns no document bodies from search. The output schema for a search hit has
  no text field, so a refactor cannot quietly regress it. `get_chunk_context` is
  the only tool that returns body text, hard-capped at 24,000 characters;
- exposes library-relative paths, never absolute ones.

Two limits of that model, stated rather than left implicit:

- **The real-path check does not close a race.** A hostile local user could
  replace a file with a symlink between the check and the read. That requires an
  account on the machine, which is already outside this model, but the guard is
  not atomic and should not be described as though it were.
- **The allowlist stops secrets being addressable; it does not stop a private
  notes tree inside the root being addressable.** Choose a library root wide
  enough to hold your documents and no wider.

Please report any bypass of these controls, any way to read or write outside the
chosen root, and any input that causes code execution or unbounded resource use.

## Out of scope

- Vulnerabilities in `pdfjs-dist`, `tesseract.js`, `better-sqlite3`,
  `sqlite-vec` or `fastembed`, which should be reported to those projects.
- Retrieval quality. The fusion score orders results without measuring
  relevance, so a search of a library that does not cover the question still
  returns a confident-looking five. That is a known defect, recorded in
  `docs/roadmap.md`, not a vulnerability.
- OCR errors, and text a parser cannot recover from a malformed file.
- Anything the MCP client does with what this server hands it. Passage text is
  document content and should be treated as untrusted by whatever reads it.
- Attacks that require prior control of the machine, the library root, or the
  files being indexed.

## Supported versions

Only the latest release is supported.
