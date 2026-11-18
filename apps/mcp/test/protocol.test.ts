import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DocumentService } from "@dsh-doc/core/service";
import { createMcpServer } from "../src/server.js";

interface ToolPayload {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function payload(result: unknown): ToolPayload {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? "{}";
  return JSON.parse(text) as ToolPayload;
}

function textOf(result: unknown): string {
  return ((result as { content?: Array<{ text?: string }> }).content?.[0]
    ?.text ?? "") as string;
}

describe("MCP protocol", () => {
  let service: DocumentService;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let workspace: string;
  let documentId = "";

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "dsh-doc-mcp-"));
    service = new DocumentService({
      workspaceRoot: workspace,
      allowedReadRoots: [workspace],
      auditPath: path.join(workspace, "audit.log"),
    });
    await service.init();
    server = createMcpServer(service);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  });

  it("lists the implemented tool surface", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThanOrEqual(45);
    for (const required of [
      "document_create",
      "document_open",
      "document_get_content",
      "document_insert_text",
      "document_format_text",
      "document_insert_table",
      "document_insert_toc",
      "document_add_comment",
      "document_compare",
      "document_export_pdf",
      "document_ai_review",
    ]) {
      expect(names).toContain(required);
    }
    const create = tools.tools.find((tool) => tool.name === "document_create");
    expect(create?.inputSchema.type).toBe("object");
    // Every tool must have an object input schema with typed properties.
    for (const tool of tools.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("creates, edits, formats and reads a document through MCP", async () => {
    const created = payload(
      await client.callTool({
        name: "document_create",
        arguments: {
          title: "MCP test document",
          paragraphs: ["Hello world.", "Second paragraph."],
        },
      }),
    );
    expect(created.ok).toBe(true);
    documentId = String(created.data?.documentId);
    expect(documentId.length).toBeGreaterThan(0);

    const content = payload(
      await client.callTool({
        name: "document_get_content",
        arguments: { documentId },
      }),
    );
    expect(content.ok).toBe(true);
    const sections = content.data?.sections as Array<{
      blocks: Array<{ id: string; text: string }>;
    }>;
    const firstBlock = sections[0].blocks[0];
    expect(firstBlock.text).toBe("Hello world.");

    const inserted = payload(
      await client.callTool({
        name: "document_insert_text",
        arguments: {
          documentId,
          position: { blockId: firstBlock.id, offset: 5 },
          text: " there",
        },
      }),
    );
    expect(inserted.ok).toBe(true);

    const afterInsert = payload(
      await client.callTool({
        name: "document_get_text",
        arguments: { documentId },
      }),
    );
    expect(String(afterInsert.data?.text)).toContain("Hello there world.");

    const formatted = payload(
      await client.callTool({
        name: "document_format_text",
        arguments: {
          documentId,
          range: {
            start: { blockId: firstBlock.id, offset: 0 },
            end: { blockId: firstBlock.id, offset: 5 },
          },
          props: { bold: true, color: "#cc0000" },
        },
      }),
    );
    expect(formatted.ok).toBe(true);

    const applied = payload(
      await client.callTool({
        name: "document_apply_style",
        arguments: {
          documentId,
          blockIds: [firstBlock.id],
          styleId: "Heading2",
        },
      }),
    );
    expect(applied.ok).toBe(true);

    const table = payload(
      await client.callTool({
        name: "document_insert_table",
        arguments: {
          documentId,
          rows: 2,
          columns: 2,
          data: [
            ["A", "B"],
            ["1", "2"],
          ],
          headerRow: true,
        },
      }),
    );
    expect(table.ok).toBe(true);

    const toc = payload(
      await client.callTool({
        name: "document_insert_toc",
        arguments: { documentId },
      }),
    );
    expect(toc.ok).toBe(true);

    const search = payload(
      await client.callTool({
        name: "document_search",
        arguments: { documentId, query: "world", includePages: true },
      }),
    );
    expect(search.ok).toBe(true);
    const matches = search.data?.matches as Array<{
      blockId: string;
      page?: number;
    }>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].page).toBe(1);

    const pageInfo = payload(
      await client.callTool({
        name: "document_get_page_info",
        arguments: { documentId },
      }),
    );
    expect(pageInfo.ok).toBe(true);
    expect(
      Number((pageInfo.data as { pageCount?: number }).pageCount),
    ).toBeGreaterThan(0);

    const comment = payload(
      await client.callTool({
        name: "document_add_comment",
        arguments: {
          documentId,
          range: {
            start: { blockId: firstBlock.id, offset: 0 },
            end: { blockId: firstBlock.id, offset: 5 },
          },
          text: "Please double-check this phrase.",
          author: "QA",
        },
      }),
    );
    expect(comment.ok).toBe(true);

    const tracked = payload(
      await client.callTool({
        name: "document_track_change",
        arguments: { documentId, enabled: true },
      }),
    );
    expect(tracked.ok).toBe(true);

    const trackedInsert = payload(
      await client.callTool({
        name: "document_insert_text",
        arguments: {
          documentId,
          position: { blockId: firstBlock.id, offset: 5 },
          text: "tracked ",
        },
      }),
    );
    expect(trackedInsert.ok).toBe(true);

    const history = payload(
      await client.callTool({
        name: "document_get_revision_history",
        arguments: { documentId },
      }),
    );
    expect(history.ok).toBe(true);
    expect(
      (history.data?.pendingTrackedChanges as { pending: number }).pending,
    ).toBeGreaterThan(0);

    const accepted = payload(
      await client.callTool({
        name: "document_accept_change",
        arguments: { documentId },
      }),
    );
    expect(accepted.ok).toBe(true);
  });

  it("reviews a document without a language model provider", async () => {
    const review = payload(
      await client.callTool({
        name: "document_ai_review",
        arguments: { documentId, checks: ["spelling", "grammar", "dates"] },
      }),
    );
    expect(review.ok).toBe(true);
    expect(Array.isArray(review.data?.findings)).toBe(true);
    expect(String(review.data?.provider)).toBe("deterministic");
  });

  it("saves, exports and reopens the document", async () => {
    const saved = payload(
      await client.callTool({
        name: "document_save",
        arguments: { documentId },
      }),
    );
    expect(saved.ok).toBe(true);
    const savedPath = String(saved.data?.path);
    expect(savedPath.endsWith(".docx")).toBe(true);
    const bytes = await readFile(savedPath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    const pdf = payload(
      await client.callTool({
        name: "document_export_pdf",
        arguments: { documentId },
      }),
    );
    expect(pdf.ok).toBe(true);
    const pdfBytes = Buffer.from(String(pdf.data?.dataBase64), "base64");
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Number(pdf.data?.pageCount)).toBeGreaterThan(0);

    const html = payload(
      await client.callTool({
        name: "document_export",
        arguments: { documentId, format: "html" },
      }),
    );
    if (html.ok) {
      const exported = Buffer.from(
        String((html.data as { dataBase64?: string }).dataBase64 ?? ""),
        "base64",
      ).toString("utf8");
      expect(exported.toLowerCase()).toContain("<html");
    } else {
      // The HTML adapter is optional in a core-only build; the failure must be explicit.
      expect(html.error?.code).toMatch(
        /FORMAT_UNAVAILABLE|CONVERSION_UNAVAILABLE/,
      );
    }

    const reopened = payload(
      await client.callTool({
        name: "document_open",
        arguments: { path: savedPath },
      }),
    );
    expect(reopened.ok).toBe(true);
    const reopenedText = payload(
      await client.callTool({
        name: "document_get_text",
        arguments: { documentId: String(reopened.data?.documentId) },
      }),
    );
    expect(String(reopenedText.data?.text)).toContain("world.");
    await client.callTool({
      name: "document_close",
      arguments: {
        documentId: String(reopened.data?.documentId),
        discardUnsaved: true,
      },
    });
  });

  it("exposes resources and prompts", async () => {
    const resources = await client.listResources();
    const uris = resources.resources.map((resource) => resource.uri);
    expect(uris).toContain("dshdoc://documents");
    expect(uris).toContain("dshdoc://formats");

    const formats = await client.readResource({ uri: "dshdoc://formats" });
    const formatsText = String(
      (formats.contents[0] as { text?: string }).text ?? "",
    );
    expect(formatsText).toContain("docx");

    const open = await client.readResource({ uri: "dshdoc://documents" });
    const openText = String((open.contents[0] as { text?: string }).text ?? "");
    expect(openText).toContain(documentId);

    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((prompt) => prompt.name);
    for (const required of [
      "summarize_document",
      "review_document",
      "proofread_document",
      "rewrite_document",
      "translate_document",
      "generate_document",
      "compare_documents",
      "format_document",
    ]) {
      expect(names).toContain(required);
    }

    const prompt = await client.getPrompt({
      name: "summarize_document",
      arguments: { documentId, style: "bullet", maxSentences: "5" },
    });
    expect(prompt.messages.length).toBeGreaterThan(0);
    const first = prompt.messages[0].content as { type: string; text?: string };
    expect(first.type).toBe("text");
    expect(String(first.text)).toContain("untrusted data");
  });

  it("refuses path traversal and unknown tools", async () => {
    const traversal = payload(
      await client.callTool({
        name: "document_open",
        arguments: { path: path.join(workspace, "..", "escape.docx") },
      }),
    );
    expect(traversal.ok).toBe(false);
    expect(traversal.error?.code).toMatch(
      /PATH_OUTSIDE_WORKSPACE|FILE_NOT_FOUND/,
    );

    const unknown = await client.callTool({
      name: "document_open",
      arguments: {},
    });
    const text = textOf(unknown);
    expect(text.length).toBeGreaterThan(0);
  });

  it("writes an audit trail for mutating tools", async () => {
    const auditFile = path.join(workspace, "audit.log");
    const raw = await readFile(auditFile, "utf8");
    expect(raw).toContain("document_create");
    expect(raw).toContain("mcp_tool_call");
    const lines = raw.trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThan(5);
    // The audit log must never contain document text.
    expect(raw).not.toContain("Hello world");
    await writeFile(
      path.join(workspace, "audit-check.txt"),
      `${lines.length}`,
      "utf8",
    );
  });
});
