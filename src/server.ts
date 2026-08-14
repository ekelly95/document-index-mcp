import { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "./context.js";
import { registerSearchDocument } from "./tools/searchDocument.js";
import { registerGetDocumentOutline } from "./tools/getDocumentOutline.js";
import { registerGetChunkContext } from "./tools/getChunkContext.js";
import { registerIngestDocument } from "./tools/ingestDocument.js";
import { registerDeleteDocument } from "./tools/deleteDocument.js";

/**
 * Kept separate from index.ts so tests can build a server without the entry
 * point's side effects (config loading, stdio connect, signal handlers).
 *
 * Five tools, registered in the order a caller should reach for them: three
 * for reading, two for lifecycle. The READING surface is deliberately this
 * small — progressive disclosure only works if there is exactly one way to get
 * body text, and it is capped — and delete_document does not widen it, since
 * it returns no document content at all.
 */
export function buildServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "document-index-mcp", version: "0.1.0" });

  registerSearchDocument(server, ctx);
  registerGetDocumentOutline(server, ctx);
  registerGetChunkContext(server, ctx);
  registerIngestDocument(server, ctx);
  registerDeleteDocument(server, ctx);

  // This server has no resources or prompts, and initialize says so. Codex
  // probes for them regardless and treats the correct -32601 "no such method"
  // reply as the server failing to start, which is what puts it on the host's
  // "not initialized" banner (openai/codex#37468, open as of 0.147.0). Empty
  // answers cost nothing. Do not remove these as dead code.
  server.server.registerCapabilities({ resources: {}, prompts: {} });
  server.server.setRequestHandler("resources/list", async () => ({ resources: [] }));
  server.server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: [],
  }));
  server.server.setRequestHandler("prompts/list", async () => ({ prompts: [] }));

  return server;
}
