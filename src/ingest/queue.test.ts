import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { createIngestQueue, DEFAULT_INGEST_CONCURRENCY } from "./queue.js";
import os from "node:os";

/** A promise plus the handle to settle it, so a test can control timing exactly. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("the default is serial, which is what one CPU-bound embedder wants", () => {
  assert.equal(DEFAULT_INGEST_CONCURRENCY, 1);
});

test("a second document waits rather than contending for the model", async () => {
  const queue = createIngestQueue(1);
  const first = deferred();
  const order: string[] = [];

  const a = queue.run(async () => {
    order.push("a:start");
    await first.promise;
    order.push("a:end");
  });

  // Give b every opportunity to start early if the queue were not bounding it.
  const b = queue.run(async () => {
    order.push("b:start");
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(order, ["a:start"], "a second ingest started while the first held the slot");
  assert.equal(queue.active(), 1);
  assert.equal(queue.waiting(), 1);

  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
  assert.equal(queue.active(), 0);
  assert.equal(queue.waiting(), 0);
});

test("a higher limit really does admit that many at once", async () => {
  const queue = createIngestQueue(3);
  const gate = deferred();
  let peak = 0;

  const runs = Array.from({ length: 6 }, () =>
    queue.run(async () => {
      peak = Math.max(peak, queue.active());
      await gate.promise;
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(queue.active(), 3, "the limit was not honoured");
  assert.equal(queue.waiting(), 3);

  gate.resolve();
  await Promise.all(runs);
  assert.equal(peak, 3);
});

test("a failing document releases its slot", async () => {
  const queue = createIngestQueue(1);
  await assert.rejects(
    queue.run(async () => {
      throw new Error("parser gave up");
    }),
    /parser gave up/,
  );

  // Without the finally, one failed ingest would wedge every later one.
  assert.equal(queue.active(), 0);
  await queue.run(async () => {});
});

test("concurrency is configurable, and nonsense is refused rather than coerced", () => {
  const lib = os.tmpdir();
  assert.equal(loadConfig([`--library=${lib}`]).ingestConcurrency, DEFAULT_INGEST_CONCURRENCY);
  assert.equal(loadConfig([`--library=${lib}`, "--ingest-concurrency=4"]).ingestConcurrency, 4);

  for (const bad of ["0", "-2", "many", "1.5"]) {
    assert.throws(
      () => loadConfig([`--library=${lib}`, `--ingest-concurrency=${bad}`]),
      /ingest concurrency/i,
      `${bad} was accepted`,
    );
  }
});
