# Third-party notices

This project is MIT licensed; see [LICENSE](LICENSE). The dependency choices
below are what keep it that way, and they are recorded here rather than in the
licence file so that automated licence detection sees a clean MIT text.

## Why PDF parsing uses pdfjs-dist

The source specification called for `mupdf` (MuPDF.js WASM). `mupdf@1.28.0` is
AGPL-3.0-or-later, which is viral over a whole server that links it. This build
uses `pdfjs-dist` (Apache-2.0) instead, which covers every requirement:
`getTextContent()` transforms for bounding boxes and font size, `getPageLabels()`
for printed page labels, and `getOutline()` for embedded bookmarks.

Keeping this project permissively licensed depends on that substitution. Any
future PDF, OCR or layout-analysis dependency should be checked against the same
bar before it is added.

## Test fixtures

There are no binary test fixtures and no captured third-party content. PDFs are
hand-assembled at test time, scanned pages are drawn onto a canvas, and the
transcript fixture is an invented lecture. Nothing in `src/` carries anyone
else's licensed text, which is why the published package needs no notice beyond
this one.

The stress corpus is a separate matter: it is not in this repository, and
[corpus/manifest.json](corpus/manifest.json) records the source, licence and
SHA-256 of every file in it. Everything there is open access, public domain, or
a licensed sample.
