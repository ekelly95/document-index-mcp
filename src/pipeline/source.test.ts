import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceFromBytes } from "./source.js";

/**
 * The memoisation that collapses three reads and three parses into one.
 *
 * These are the guarantees `runner.ts` and `pdfCommon.ts` rely on. Asserting
 * them here rather than only through a PDF keeps the contract visible when the
 * next format arrives.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

test("derive builds a resource once, however many callers ask", async () => {
  const src = sourceFromBytes("a.bin", bytesOf("payload"));
  let builds = 0;
  const build = async () => {
    builds++;
    return { id: builds };
  };

  const first = await src.derive("thing", build);
  const second = await src.derive("thing", build);

  assert.equal(builds, 1, "the resource was rebuilt");
  assert.equal(first, second, "callers got different instances");
});

test("concurrent callers share one build rather than racing it", async () => {
  const src = sourceFromBytes("a.bin", bytesOf("payload"));
  let builds = 0;
  const build = async () => {
    builds++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { id: builds };
  };

  // The promise is memoised, not the resolved value — otherwise the probe and
  // the metadata pass, which start within microseconds of each other, would
  // both begin parsing the same PDF.
  const [a, b, c] = await Promise.all([
    src.derive("thing", build),
    src.derive("thing", build),
    src.derive("thing", build),
  ]);

  assert.equal(builds, 1, "a concurrent caller started a second build");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("distinct keys are distinct resources", async () => {
  const src = sourceFromBytes("a.bin", bytesOf("payload"));
  const one = await src.derive("one", async () => ({}));
  const two = await src.derive("two", async () => ({}));
  assert.notEqual(one, two);
});

test("close disposes what was derived, once", async () => {
  const src = sourceFromBytes("a.bin", bytesOf("payload"));
  let disposed = 0;
  await src.derive("thing", async () => ({}), async () => {
    disposed++;
  });

  await src.close();
  assert.equal(disposed, 1);

  // Idempotent: shutdown paths call this alongside the ingest's own cleanup.
  await src.close();
  assert.equal(disposed, 1);
});

test("a failed build does not break close", async () => {
  const src = sourceFromBytes("a.bin", bytesOf("payload"));
  const attempt = src.derive("thing", async () => {
    throw new Error("could not parse");
  });
  await assert.rejects(attempt, /could not parse/);

  // A resource that never existed has nothing to dispose, and tearing down
  // must not mask whatever error got the ingest here.
  await src.close();
});

test("head survives a consumer that detaches the byte buffer", async () => {
  const src = sourceFromBytes("a.pdf", bytesOf("%PDF-1.7 and then some payload"));
  const before = [...src.head];

  // Exactly what pdfjs does to the array it is handed. The cast is only
  // because `.buffer` is typed ArrayBufferLike, which admits SharedArrayBuffer;
  // a source's bytes are never shared.
  const buffer = src.bytes.buffer as ArrayBuffer;
  structuredClone(buffer, { transfer: [buffer] });

  assert.deepEqual([...src.head], before, "sniffing broke after the bytes were taken");
});

test("text is decoded once and reused", () => {
  const src = sourceFromBytes("a.md", bytesOf("# Heading\n\nBody.\n"));
  assert.equal(src.text(), "# Heading\n\nBody.\n");
  assert.equal(src.text(), src.text());
});
