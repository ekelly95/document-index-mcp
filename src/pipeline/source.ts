import fs from "node:fs/promises";
import type { DocumentSource } from "./ir.js";

/**
 * One opened source, read once, shared by everything that inspects it.
 *
 * Ingesting a PDF used to read the whole file into memory three separate times
 * — once for the probe, once for metadata, once for the parse — and build
 * three independent pdfjs documents from it, each re-importing pdfjs and
 * re-resolving its font directory. On a 200MB book that is ~600MB of transient
 * reads and three full parses to produce one index.
 *
 * The deeper problem was correctness, not waste. The sha256 was computed from
 * its own separate read, before any of those, so the identity stored against a
 * document described bytes that nothing downstream ever saw. A file edited
 * during the seconds between those reads produced an index whose contents and
 * whose hash came from different revisions — silently, and self-healing only
 * on the next re-ingest.
 *
 * Reading once and hashing THOSE bytes closes it by construction: there is no
 * window between the hash and the parse because they are the same bytes.
 *
 * A note on the one thing this made slightly worse. `sniffFormat` used to read
 * 512 bytes and could refuse an unsupported format without touching the rest
 * of the file; now the whole file is in memory by then. That only matters for
 * a format the router recognises and refuses — pptx, epub, html — and the path
 * jail already restricts what is addressable to a short extension allowlist,
 * so the realistic cost is reading a few tens of megabytes to say no. Worth it
 * for a single, obviously-correct read path.
 */

interface Derived {
  value: Promise<unknown>;
  dispose: ((value: unknown) => Promise<void>) | undefined;
}

class FileSource implements DocumentSource {
  readonly #derived = new Map<string, Derived>();
  readonly head: Uint8Array;
  #text: string | null = null;

  constructor(
    readonly absPath: string,
    readonly bytes: Uint8Array,
  ) {
    // Copied out up front rather than exposed as a live subarray. Format
    // libraries can take ownership of a buffer handed to them and detach it —
    // pdfjs does — and sniffing must not be the thing that discovers this.
    this.head = new Uint8Array(bytes.subarray(0, 512));
  }

  text(): string {
    // Decoded once. The markdown parser slices this string for block text and
    // the txt parser splits it into lines, so it is read many times per ingest.
    this.#text ??= new TextDecoder("utf-8").decode(this.bytes);
    return this.#text;
  }

  async derive<T>(
    key: string,
    make: () => Promise<T>,
    dispose?: (value: T) => Promise<void>,
  ): Promise<T> {
    const existing = this.#derived.get(key);
    if (existing) return existing.value as Promise<T>;

    // The PROMISE is memoised, not the resolved value, so two concurrent
    // callers cannot both start the expensive build. Same reasoning as
    // Embedder.ready().
    const value = make();
    this.#derived.set(key, { value, dispose: dispose as Derived["dispose"] });
    return value;
  }

  async close(): Promise<void> {
    for (const [key, entry] of [...this.#derived]) {
      this.#derived.delete(key);
      if (!entry.dispose) continue;
      try {
        await entry.dispose(await entry.value);
      } catch {
        // A resource that failed to build has nothing to dispose, and a
        // failure to tear one down must not mask the error that got us here.
      }
    }
  }
}

/**
 * A plain Uint8Array over the same memory.
 *
 * `fs.readFile` returns a Buffer, and pdfjs rejects one outright — "Please
 * provide binary data as `Uint8Array`, rather than `Buffer`" — even though
 * Buffer extends Uint8Array. A view rather than `new Uint8Array(buf)` because
 * the latter copies, and these are whole documents.
 */
function asPlainBytes(buf: Uint8Array): Uint8Array {
  if (buf.constructor === Uint8Array) return buf;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError";
}

/** Bytes as something a person reads, at both ends of the range. */
const describeSize = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${n} bytes`;

/**
 * Read a file once. The caller must `close()` it.
 *
 * `maxBytes` is checked with a stat first, because everything this function
 * does after it is unbounded: the whole file becomes resident, and for
 * Markdown and text `text()` then decodes it into a JS string as well, so the
 * real peak is a multiple of the file rather than the file. SECURITY.md invites
 * reports of "any input that causes unbounded resource use", and until this
 * existed the only ceiling was Node's own ~2 GiB readFile limit — which is a
 * crash, not a refusal.
 *
 * Omitting it means unbounded, which is right for the probe scripts and the
 * tests and wrong for the server. `runner.ts` passes the configured ceiling.
 */
export async function openSource(absPath: string, maxBytes?: number): Promise<DocumentSource> {
  if (maxBytes !== undefined) {
    const { size } = await fs.stat(absPath);
    if (size > maxBytes) {
      // Names both numbers, because "too large" without the limit leaves the
      // caller unable to tell whether the file or the setting is the problem.
      throw new FileTooLargeError(
        `File is ${describeSize(size)}, over the ${describeSize(maxBytes)} limit. ` +
          `Raise --max-file-mb (or DOCUMENT_INDEX_MAX_FILE_MB) to index it.`,
      );
    }
  }
  return new FileSource(absPath, asPlainBytes(await fs.readFile(absPath)));
}

/** An in-memory source, for tests and for callers that already hold the bytes. */
export function sourceFromBytes(absPath: string, bytes: Uint8Array): DocumentSource {
  return new FileSource(absPath, asPlainBytes(bytes));
}
