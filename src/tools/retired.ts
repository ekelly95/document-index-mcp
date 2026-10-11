import type { Db } from "../db/sqlite.js";
import {
  findSupersededChunk,
  findSupersededDocument,
  getDocument,
  type RetireReason,
} from "../db/documentsRepo.js";
import { oneLine } from "./shapes.js";

/**
 * What the reading tools say about an id that no longer resolves.
 *
 * "Unknown" is the right answer for a typo and the wrong one for a citation
 * made before the file was edited: the caller then has no way to tell a bad id
 * from a stale one, or to find where the passage went. The tombstones written by
 * `retireDocument` carry enough to say which.
 */

const BECAUSE: Record<RetireReason, string> = {
  edited: "the file was edited and re-ingested",
  reindexed: "the index was rebuilt",
  deleted: "the document was deleted from the index",
};

function when(iso: string): string {
  return iso.slice(0, 10);
}

/** Where the replacement lives, or why there is none. */
function successor(db: Db, replacedBy: string | null): string {
  if (replacedBy === null) return "It has no current version in the index.";
  const current = getDocument(db, replacedBy);
  if (!current) return "It has no current version in the index.";
  return `The current version is "${oneLine(current.title)}", document_id ${current.id}.`;
}

/** An explanation for a retired chunk_id, or null when it was never one. */
export function explainRetiredChunk(db: Db, chunkId: string): string | null {
  const chunk = findSupersededChunk(db, chunkId);
  if (!chunk) return null;
  const doc = findSupersededDocument(db, chunk.document_id);
  const what = doc
    ? `an earlier version of "${oneLine(doc.title)}" (${doc.source_path})`
    : `an earlier version of document ${chunk.document_id}`;
  const where =
    chunk.page_number !== null
      ? `page ${chunk.page_number}${chunk.printed_label && chunk.printed_label !== String(chunk.page_number) ? ` (printed ${chunk.printed_label})` : ""}`
      : `${chunk.locator_type} ${chunk.locator_value}`;
  const next =
    chunk.replaced_by !== null && getDocument(db, chunk.replaced_by)
      ? ` Search it with document_id, or read near seq ${chunk.seq} — the text there may have changed.`
      : "";
  return (
    `chunk_id "${chunkId}" belonged to ${what}, retired on ${when(chunk.superseded_at)} because ` +
    `${BECAUSE[chunk.reason]}. It was at ${where}, seq ${chunk.seq}. ` +
    successor(db, chunk.replaced_by) +
    next
  );
}

export type ResolvedDocument =
  | { ok: true; id: string; note: string | null }
  | { ok: false; message: string };

/**
 * Resolve a caller's document_id, following a retirement to its current
 * version. Used where the id only scopes a request (search, outline), so
 * following it is what the caller meant; never for a seq address, whose meaning
 * can shift between versions.
 */
export function resolveDocumentId(db: Db, id: string): ResolvedDocument {
  if (getDocument(db, id)) return { ok: true, id, note: null };
  const retired = findSupersededDocument(db, id);
  if (!retired) {
    return {
      ok: false,
      message: `Unknown document_id "${id}". Call get_document_outline with no arguments to list the library.`,
    };
  }
  if (retired.replaced_by !== null && getDocument(db, retired.replaced_by)) {
    return {
      ok: true,
      id: retired.replaced_by,
      note:
        `document_id ${id} is an earlier version of "${oneLine(retired.title)}", retired on ` +
        `${when(retired.superseded_at)} because ${BECAUSE[retired.reason]}; showing the current ` +
        `version, ${retired.replaced_by}.`,
    };
  }
  return { ok: false, message: explainRetiredDocument(db, id)! };
}

/** An explanation for a retired document_id, or null when it was never one. */
export function explainRetiredDocument(db: Db, id: string): string | null {
  const retired = findSupersededDocument(db, id);
  if (!retired) return null;
  return (
    `document_id ${id} was "${oneLine(retired.title)}" (${retired.source_path}), retired on ` +
    `${when(retired.superseded_at)} because ${BECAUSE[retired.reason]}. ` +
    successor(db, retired.replaced_by)
  );
}
