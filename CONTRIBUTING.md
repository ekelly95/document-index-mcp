# Contributing

Thank you for looking. This is a small project maintained by one person in spare
time, so please read the two sections below before opening anything — they will
save you the most effort.

## Before you open an issue

**Say which platform you are on.** Supported platforms are Windows x64, Linux
x64 and macOS, and nothing else. The embedding model's tokenizer ships binaries
for exactly those three, so on Linux arm64, on Alpine, or on Windows-on-ARM the
install succeeds and the first *search* then fails from inside a dependency.
That failure looks like a bug in this project and is not one. Please include
your operating system, processor architecture and `node --version`.

The slide-deck converter (`scripts/convert-for-ingest.ps1`) is narrower still:
it drives Word and PowerPoint through COM, so it needs Windows with Microsoft
Office installed. There is no macOS or Linux equivalent and none is planned.

**Retrieval quality is not a bug report.** The fusion score orders results
without measuring relevance, so a search of a library that does not cover your
question still returns a confident-looking five. That is a known defect,
recorded in [docs/roadmap.md](docs/roadmap.md). A report that a particular query
ranks badly is welcome as evidence, but the general shape of the problem is
already understood.

**Suspected vulnerabilities go to [SECURITY.md](SECURITY.md)**, not to a public
issue.

## Before you open a pull request

```bash
pnpm install
pnpm build
pnpm test
```

Four things about that suite are worth knowing in advance.

**Never pipe the test run.** A `| tail` once masked a failing test in this
project, which is why the instruction appears in the README, in both CI
workflows and here. Let it print.

**One test skips on Windows.** The symlink-escape case in
`src/security/paths.test.ts` needs Developer Mode or an elevated shell, because
Windows will not let an ordinary user create a symlink. It reports itself as
skipped rather than passing quietly. That test is the only thing proving the
path jail cannot be escaped, so if you are changing anything under
`src/security/`, get a Linux run before you trust a green result — CI does this
for you on every pull request.

**`pnpm test` builds first, and the build cleans `dist/` first.** Both are
deliberate. Stale compiler output from deleted source files once kept tests
alive after the code under them was gone.

**The first run downloads about 130 MB.** That is the embedding model, fetched
once from Google Cloud Storage and cached. If you are also touching OCR, the
first scanned page fetches roughly 3 MB more of language data from a CDN;
`--ocr-lang-path` points that at a local copy instead.

### Things that will fail review

- **Raw control characters in source.** Several separators here are control
  characters on purpose, but they must be written as escapes. A literal NUL byte
  makes the whole file look binary to git, ripgrep and every packing tool, which
  has silently hidden files from review twice. `src/sources.test.ts` enforces
  this; [docs/gotchas.md](docs/gotchas.md) explains why.
- **Changes to ranking without re-running the evaluation.** `pnpm eval` scores a
  checked-in set of questions over an open-access corpus. The optimum moves when
  the embedded text changes, and it is a command you run, not a test that fails
  on its own. See [docs/roadmap.md](docs/roadmap.md).
- **A citation that can point at the wrong place.** A chunk may never span two
  pages or two sections. Most of the odd-looking constraints in the chunker
  exist to hold that line, and [docs/design.md](docs/design.md) records why.

### Where to read first

[docs/design.md](docs/design.md) for the three architectural ideas and every
deliberate deviation from the original specification;
[docs/gotchas.md](docs/gotchas.md) for the sharp edges, most of which are
ex-bugs; [docs/roadmap.md](docs/roadmap.md) for what is built, what was cut and
what is still wrong.

## Licence

By contributing you agree that your contributions are licensed under the MIT
Licence, as in [LICENSE](LICENSE).
