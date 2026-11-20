/**
 * MCP wiring proof for the optional LibreOffice tools.
 *
 * The suite starts the real MCP server factory (`apps/mcp/src/server.ts`) on an
 * in-memory transport, lists tools through the protocol, invokes
 * `document_engine_status`, and then drives 150 direct registry invocations
 * across argument permutations. It also implements the second accepted path
 * from the task: the shared `listTools()` + `invokeTool()` surface.
 *
 * LibreOffice is made deterministically unavailable for this file by pointing
 * every discovery source at missing paths, so the assertions describe the
 * supported "not installed" state rather than the host's current state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { DocumentService } from "../../src/service/service.js";
import {
  buildToolManifest,
  invokeTool,
  listTools,
} from "../../src/tools/registry.js";
import { clearLibreOfficeCache } from "../../src/engine/libreoffice.js";
import { createMcpServer } from "../../../../apps/mcp/src/server.js";

interface ToolPayload {
  ok: boolean;
  data?: Record<string, any>;
  error?: { code: string; message: string; details?: any };
}

function payload(result: unknown): ToolPayload {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? "{}";
  return JSON.parse(text) as ToolPayload;
}

const repoRoot = path.resolve(process.cwd());
const requireFromMcp = createRequire(
  path.join(repoRoot, "apps/mcp/package.json"),
);

async function loadSdkModule<T>(specifier: string): Promise<T> {
  const resolved = requireFromMcp.resolve(specifier);
  return (await import(pathToFileURL(resolved).href)) as T;
}

interface SdkClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      inputSchema: Record<string, any>;
    }>;
  }>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
}

describe("MCP LibreOffice wiring", () => {
  let workspace = "";
  let service: DocumentService;
  let client: SdkClient;
  let server: ReturnType<typeof createMcpServer>;
  let savedEnvironment: Record<string, string | undefined> = {};

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "dsh-lo-mcp-"));
    await mkdir(path.join(workspace, "documents"), { recursive: true });
    await writeFile(
      path.join(workspace, "sample.docx"),
      "fake docx input",
      "utf8",
    );

    // Deterministic "not installed" state for this test process.
    savedEnvironment = {
      DSH_SOFFICE_PATH: process.env.DSH_SOFFICE_PATH,
      ProgramFiles: process.env.ProgramFiles,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    };
    process.env.DSH_SOFFICE_PATH = path.join(workspace, "missing-soffice.exe");
    process.env.ProgramFiles = path.join(workspace, "missing-program-files");
    process.env["ProgramFiles(x86)"] = path.join(
      workspace,
      "missing-program-files-x86",
    );
    process.env.LOCALAPPDATA = path.join(workspace, "missing-local-app-data");
    clearLibreOfficeCache();

    service = new DocumentService({
      workspaceRoot: workspace,
      allowedReadRoots: [workspace],
      auditPath: path.join(workspace, "audit.log"),
    });
    await service.init();
    server = createMcpServer(service);
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      loadSdkModule<{ Client: new (...args: any[]) => SdkClient }>(
        "@modelcontextprotocol/sdk/client/index.js",
      ),
      loadSdkModule<{
        InMemoryTransport: {
          createLinkedPair(): [unknown, unknown];
        };
      }>("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(
      serverTransport as Parameters<typeof server.connect>[0],
    );
    client = new Client(
      { name: "libreoffice-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearLibreOfficeCache();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("lists both LibreOffice tools with valid JSON schemas", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("document_engine_status");
    expect(names).toContain("document_convert_external");
    expect(names).toContain("document_set_engine");

    for (const name of [
      "document_engine_status",
      "document_convert_external",
      "document_set_engine",
    ]) {
      const tool = listed.tools.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.type).toBe("object");
      if (name === "document_engine_status") {
        expect(tool?.inputSchema.properties).toEqual({});
      }
    }

    const conversion = listed.tools.find(
      (entry) => entry.name === "document_convert_external",
    );
    expect(
      Object.keys(conversion?.inputSchema.properties ?? {}).sort(),
    ).toEqual(["format", "inputPath", "outputPath", "timeoutMs"]);

    const engineTool = listed.tools.find(
      (entry) => entry.name === "document_set_engine",
    );
    expect(
      Object.keys(engineTool?.inputSchema.properties ?? {}).sort(),
    ).toEqual(["engine"]);
    expect(engineTool?.inputSchema.required).toEqual(["engine"]);
    expect(engineTool?.inputSchema.properties?.engine?.enum).toEqual([
      "auto",
      "libreoffice",
      "internal",
    ]);
  });

  it("reports the engine preference, resolved engine and route matrix", async () => {
    const result = payload(
      await client.callTool({
        name: "document_engine_status",
        arguments: {},
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data?.preference).toBe("auto");
    expect(result.data?.engineInUse?.engine).toBe("internal");
    expect(result.data?.engineInUse?.reason).toBe("engine-unavailable");
    expect(result.data?.engineInUse?.fallbackReason).toBe("engine-unavailable");
    const pdf = (result.data?.capabilities as any[]).find(
      (entry) => entry.format === "pdf",
    );
    expect(pdf.routing).toEqual({
      engine: "internal",
      reason: "engine-unavailable",
      fallbackReason: "engine-unavailable",
    });
    expect(result.data?.verifySaveWithLibreOffice).toBe(false);
  });

  it("reports the engine as unavailable with detection evidence", async () => {
    const result = payload(
      await client.callTool({
        name: "document_engine_status",
        arguments: {},
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data?.available).toBe(false);
    expect(typeof result.data?.reason).toBe("string");
    expect(String(result.data?.reason).length).toBeGreaterThan(0);
    const engines = result.data?.engines as Record<string, any>;
    expect(engines.internal.available).toBe(true);
    expect(engines.libreoffice.available).toBe(false);
    expect(engines.libreoffice.reason).toBeTruthy();
    const detection = engines.libreoffice.detection;
    expect(detection.available).toBe(false);
    expect(Array.isArray(detection.candidates)).toBe(true);
    expect(detection.candidates.length).toBeGreaterThan(0);
    expect(Array.isArray(result.data?.capabilities)).toBe(true);
  });

  it("maps a real conversion attempt to ENGINE_UNAVAILABLE through MCP", async () => {
    const result = payload(
      await client.callTool({
        name: "document_convert_external",
        arguments: {
          inputPath: path.join(workspace, "sample.docx"),
          format: "pdf",
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ENGINE_UNAVAILABLE");
    expect(result.error?.details?.detection?.available).toBe(false);
    expect(result.error?.details?.detection?.reason).toBeTruthy();
  });

  it("exposes the new tools through listTools and buildToolManifest", () => {
    const tools = listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("document_engine_status");
    expect(names).toContain("document_convert_external");
    expect(tools.length).toBe(53);
    const manifest = buildToolManifest();
    expect(manifest.count).toBe(53);
    for (const entry of manifest.tools.filter(
      (tool) =>
        tool.name.startsWith("document_engine") ||
        tool.name === "document_convert_external",
    )) {
      expect(entry.inputSchema.type).toBe("object");
      expect(entry.category).toBe("conversion");
    }
  });

  it("runs 150 registry invocations across argument permutations without crashing", async () => {
    let invocations = 0;

    // 100 status permutations: the tool takes no inputs, so every extra
    // argument is ignored and the result stays the same typed payload.
    const statusArgs: Array<Record<string, unknown>> = [];
    const permutations: Array<Record<string, unknown>> = [
      {},
      { refresh: true },
      { format: "pdf" },
      { inputPath: "x" },
      { timeoutMs: 50 },
      { documentId: null },
      { nested: { a: 1, b: [2, 3] } },
      { unicode: "résumé é" },
      { long: "x".repeat(1_000) },
      { array: [1, 2, 3] },
      { number: 42 },
      { boolean: true },
      { emptyString: "" },
      { nul: "a\u0000b" },
      { outputPath: "C:\\outside.pdf" },
    ];
    for (let index = 0; index < 100; index += 1) {
      const base = permutations[index % permutations.length];
      statusArgs.push({ ...base, invocation: index });
    }
    for (const args of statusArgs) {
      const result = await invokeTool(service, "document_engine_status", args);
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, any>;
      expect(data.available).toBe(false);
      expect(typeof data.reason).toBe("string");
      invocations += 1;
    }

    const validInput = path.join(workspace, "sample.docx");
    const missingInput = path.join(workspace, "missing.docx");
    const outsideOutput = path.join(workspace, "..", "outside.pdf");
    const convertCases: Array<{
      args: Record<string, unknown>;
      codes: string[];
    }> = [];

    for (let index = 0; index < 10; index += 1) {
      convertCases.push({
        args:
          index % 2 === 0
            ? { format: "pdf" }
            : { inputPath: "", format: "pdf" },
        codes: ["INVALID_ARGUMENT"],
      });
    }
    for (let index = 0; index < 10; index += 1) {
      convertCases.push({
        args: { inputPath: `relative-${index}.docx`, format: "pdf" },
        codes: ["PATH_OUTSIDE_WORKSPACE"],
      });
    }
    for (let index = 0; index < 5; index += 1) {
      convertCases.push({
        args: { inputPath: missingInput, format: "pdf" },
        codes: ["INVALID_ARGUMENT"],
      });
    }
    for (const format of [
      "xlsx",
      "pptx",
      "",
      "pdf:",
      "docx:",
      "..",
      "pdf\u0000",
      "x".repeat(200),
      '"pdf"',
      "PDF\u0000",
    ]) {
      convertCases.push({
        args: { inputPath: validInput, format },
        codes: ["FORMAT_UNSUPPORTED"],
      });
    }
    for (const timeoutMs of [0, -1, 49, 600_001, 1.5]) {
      convertCases.push({
        args: { inputPath: validInput, format: "pdf", timeoutMs },
        codes: ["INVALID_ARGUMENT"],
      });
    }
    for (let index = 0; index < 5; index += 1) {
      convertCases.push({
        args: {
          inputPath: validInput,
          format: "pdf",
          outputPath:
            index % 2 === 0 ? outsideOutput : path.join("relative-out.pdf"),
        },
        codes: ["PATH_TRAVERSAL", "PATH_OUTSIDE_WORKSPACE"],
      });
    }
    for (let index = 0; index < 5; index += 1) {
      convertCases.push({
        args: { inputPath: validInput, format: "pdf" },
        codes: ["ENGINE_UNAVAILABLE"],
      });
    }
    expect(convertCases).toHaveLength(50);

    for (const entry of convertCases) {
      const result = await invokeTool(
        service,
        "document_convert_external",
        entry.args,
      );
      expect(result.ok).toBe(false);
      expect(result.error?.message).toBeTruthy();
      expect(entry.codes).toContain(String(result.error?.code));
      invocations += 1;
    }

    expect(invocations).toBe(150);
    console.log(`mcp invocations: ${invocations}`);
  });
});
