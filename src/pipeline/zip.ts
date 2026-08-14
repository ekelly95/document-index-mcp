import { unzipSync } from "fflate";

/**
 * A read-only view over one zip archive, decompressed selectively.
 *
 * An OOXML file is a zip whose bulk is usually imagery and embedded fonts,
 * none of which this server reads. The `keep` filter runs against the central
 * directory before anything is inflated, so an illustrated document costs only
 * its XML — and the per-entry size cap bounds what a hostile archive can make
 * one `bytes()` call allocate.
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

export function openZip(
  bytes: Uint8Array,
  keep: (name: string, size: number) => boolean = () => true,
): ZipArchive {
  const entries = unzipSync(bytes, {
    filter: (file) => file.originalSize <= MAX_ENTRY_BYTES && keep(file.name, file.originalSize),
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
