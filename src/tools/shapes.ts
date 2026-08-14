import * as z from "zod";
import type { ChunkRow } from "../db/chunksRepo.js";

/** Shapes shared across the tool surface. */

export const FORMATS = ["pdf", "epub", "docx", "pptx", "md", "html", "txt"] as const;
export const LOCATOR_TYPES = ["page", "section"] as const;
export const CHUNK_KINDS = ["text", "table", "code", "list", "heading"] as const;

export const LocatorShape = z.object({
  type: z.enum(LOCATOR_TYPES),
  value: z.string(),
  ordinal: z.number().int(),
  page_number: z.number().int().nullable(),
  printed_label: z.string().nullable(),
});

export const ChunkRefShape = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  seq: z.number().int(),
  kind: z.enum(CHUNK_KINDS),
  locator: LocatorShape,
  section_path: z.array(z.string()),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});

export type ChunkRef = z.infer<typeof ChunkRefShape>;

export function toChunkRef(row: ChunkRow): ChunkRef {
  return {
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    seq: row.seq,
    kind: row.kind,
    locator: {
      type: row.locator_type,
      value: row.locator_value,
      ordinal: row.locator_ordinal,
      page_number: row.page_number,
      printed_label: row.printed_label,
    },
    section_path: JSON.parse(row.section_path) as string[],
    bbox: row.bbox ? (JSON.parse(row.bbox) as [number, number, number, number]) : null,
  };
}

/** "Part II › Methods › 3.2 Sampling — page 41" */
export function describeLocation(ref: ChunkRef): string {
  const where =
    ref.locator.printed_label && ref.locator.printed_label !== ref.locator.value
      ? `${ref.locator.type} ${ref.locator.value} (printed ${ref.locator.printed_label})`
      : `${ref.locator.type} ${ref.locator.value}`;
  const path = ref.section_path.length > 0 ? ref.section_path.join(" › ") : "(no section)";
  return `${path} — ${where}`;
}
