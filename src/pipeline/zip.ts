import { unzipSync } from "fflate";

/**
 * A read-only view over one zip archive, decompressed selectively.
 *
 * An OOXML file is a zip whose bulk is usually imagery and embedded fonts,
 * none of which this server reads. The `keep` filter runs against the central
 * directory before anything is inflated, so an illustrated document costs only
 * its XML — and two size caps bound what a hostile archive can make this
 * allocate: one per entry, and one across the archive. Both are needed, for the
 * reason written above MAX_TOTAL_BYTES.
 *
 * Only DOCX uses this now. It is kept general (rather than folded into
 * docx.ts) because the format sniffer still walks the central directory of any
 * zip to tell docx, pptx and epub apart, and because a filtered reader is the
 * part of zip handling that is easy to get dangerously wrong.
 */

export interface ZipArchive {
  names(): string[];
  has(name: string): boolean;
  /** Throws with the entry name when it is missing or was filtered out. */
  bytes(name: string): Uint8Array;
  /** As `bytes`, decoded as UTF-8. */
  text(name: string): string;
}

/** Entries larger than this uncompressed are never inflated. */
export const MAX_ENTRY_BYTES = 20_000_000;

/**
 * And this much across the archive as a whole.
 *
 * The per-entry cap does not compose into an archive bound, which is the trap:
 * a zip may repeat an entry name as often as it likes, and fflate walks the
 * central directory without deduplicating. Every record passing the filter gets
 * a buffer of its DECLARED size allocated and inflated into, and only the last
 * copy of a name survives in the returned map — so 65,535 records all called
 * `word/document.xml` all pass `keepEntry`'s four-name test, and 65,534 of them
 * are inflated purely to be thrown away.
 *
 * Measured before this existed, against the real `openZip` and the real
 * `keepEntry`: a 3.7 MB file built that way inflated 4.0 GB and held the thread
 * for 8.9 seconds, at a flat 0.45 GB/s with nothing to stop it — 37 MB would
 * have bought ninety seconds. `unzipSync` is synchronous and this server is one
 * thread, so for that whole window it answers nothing: no search, no outline,
 * not even the shutdown drain.
 *
 * Four times the entry cap, because four fixed names is what the one real
 * caller keeps. A legitimate DOCX cannot reach it.
 */
export const MAX_TOTAL_BYTES = 4 * MAX_ENTRY_BYTES;

export class ZipBudgetError extends Error {
  override readonly name = "ZipBudgetError";
}

export function openZip(
  bytes: Uint8Array,
  keep: (name: string, size: number) => boolean = () => true,
): ZipArchive {
  let remaining = MAX_TOTAL_BYTES;
  const taken = new Set<string>();

  const entries = unzipSync(bytes, {
    filter: (file) => {
      // Order matters and matches what this always did: an oversized entry is
      // dropped without consulting `keep`, because sniffFormat's keep has a
      // side effect and the sniffer has never counted entries it would refuse.
      if (file.originalSize > MAX_ENTRY_BYTES) return false;
      if (!keep(file.name, file.originalSize)) return false;

      // A repeated name is not a legitimate OOXML part, and only the last copy
      // would survive in the map in any case. Skipping the earlier ones is what
      // makes the duplicate-name archive harmless rather than merely bounded —
      // the budget below is then a backstop for a caller keeping many distinct
      // names, not the thing standing between this and the measurement above.
      if (taken.has(file.name)) return false;

      if (file.originalSize > remaining) {
        throw new ZipBudgetError(
          `Archive asks to inflate more than ${MAX_TOTAL_BYTES} bytes in total; refusing at "${file.name}".`,
        );
      }
      taken.add(file.name);
      remaining -= file.originalSize;
      return true;
    },
  });
  const decoder = new TextDecoder("utf-8");

  return {
    names: () => Object.keys(entries),
    has: (name) => name in entries,
    bytes: (name) => {
      const data = entries[name];
      if (!data) {
        throw new Error(`zip entry not found (missing, oversized, or filtered): ${name}`);
      }
      return data;
    },
    text(name) {
      return decoder.decode(this.bytes(name));
    },
  };
}

// resolveHref and entryDir lived here to turn an EPUB's relative, percent-
// encoded, fragment-carrying hrefs into zip entry names. They went out with
// that reader: DOCX addresses its parts by fixed, absolute names and never
// needed either. Restore them from git if a format that follows internal links
// ever comes back.
