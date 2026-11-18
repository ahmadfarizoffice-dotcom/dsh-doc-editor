/**
 * HTTP host for the document platform.
 *
 * Serves the built client from dist-client and the JSON API under /api. Every
 * server capability is probed at start-up: endpoints whose core module is not
 * loadable answer with an explicit 501 and a machine readable `code`, never with
 * invented content.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import {
  bytesOf,
  contractOf,
  loadCore,
  pickFunction,
  textOf,
  type CoreBundle,
  type ModuleContract,
} from "./core.js";
import {
  exportFileName,
  findRepositoryRoot,
  isValidDocumentId,
  makeDocumentId,
  validateDocumentShape,
  WorkspaceStore,
} from "./workspace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = "25mb";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTENSIONS = new Set([".docx", ".dotx", ".docm"]);

const EXPORT_CONTENT_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
};

const EXPORT_EXTENSIONS = new Set(Object.keys(EXPORT_CONTENT_TYPES));

/** Public export ids → core conversion engine ids. */
const ENGINE_FORMAT: Record<string, string> = { md: "markdown", txt: "text" };

/** Operations exposed by the core AI assistant. */
const AI_OPERATIONS = new Set([
  "summarize",
  "review",
  "rewrite",
  "translate",
  "generate_content",
  "suggest_edits",
]);

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(HERE, "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void> | void,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

function requireDocumentId(raw: string): string {
  if (!isValidDocumentId(raw)) {
    throw new HttpError(
      400,
      "INVALID_DOCUMENT_ID",
      "Document ids may only contain letters, digits, hyphens and underscores",
    );
  }
  return raw;
}

/**
 * Maps the UI's three modes onto the assistant operations the core AI module
 * exposes. Ask-mode prompts are routed to the deterministic review or the
 * extractive summary; anything else falls back to a summary, which is the only
 * offline capable answer.
 */
function chooseAiOperation(
  mode: string,
  prompt: string,
  requested?: string,
): string {
  if (requested && AI_OPERATIONS.has(requested)) return requested;
  if (mode === "suggest") return "rewrite";
  if (mode === "edit") return "suggest_edits";
  if (/spell|grammar|typo|proofread|review|consisten|punctuat/i.test(prompt))
    return "review";
  return "summarize";
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = request.body as unknown;
  // An absent body is treated as an empty object; each route validates the
  // fields it needs and fails with a specific error code.
  if (body === undefined || body === null || body === "") return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "A JSON object body is required");
  }
  return body as Record<string, unknown>;
}

export interface ServerOptions {
  root?: string;
  workspaceRoot?: string;
  core?: CoreBundle;
}

export interface ServerInstance {
  app: express.Express;
  core: CoreBundle;
  workspace: WorkspaceStore;
  contract: ModuleContract;
  version: string;
}

/** Builds the express application without listening (used by `main` and tests). */
export async function createServer(
  options: ServerOptions = {},
): Promise<ServerInstance> {
  const root = path.resolve(
    options.root ?? process.env.DSH_DOC_ROOT ?? findRepositoryRoot(HERE),
  );
  const workspaceRoot = path.resolve(
    options.workspaceRoot ??
      process.env.DSH_DOC_WORKSPACE ??
      path.join(root, ".workspace"),
  );
  const core = options.core ?? (await loadCore({ root }));
  const contract = contractOf(core);
  const workspace = new WorkspaceStore(workspaceRoot);
  await workspace.ensure();
  const version = packageVersion();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_request, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
        callback(
          new HttpError(
            415,
            "UNSUPPORTED_UPLOAD_TYPE",
            `Only ${[...ALLOWED_UPLOAD_EXTENSIONS].join(", ")} uploads are accepted`,
          ),
        );
        return;
      }
      callback(null, true);
    },
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_BODY }));

  /** Loads a stored document (JSON record or imported DOCX). */
  const loadStoredDocument = async (
    id: string,
  ): Promise<{
    document: unknown;
    title: string;
    kind: "json" | "docx";
    warnings: string[];
  }> => {
    const record = await workspace.readJson(id);
    if (record) {
      return {
        document: record.document,
        title: record.title ?? id,
        kind: "json",
        warnings: record.warnings ?? [],
      };
    }
    const docxBytes = await workspace.readDocx(id);
    if (!docxBytes) {
      throw new HttpError(
        404,
        "DOCUMENT_NOT_FOUND",
        `No document with id “${id}” exists in the workspace`,
      );
    }
    if (!contract.importDocx) {
      throw new HttpError(
        501,
        "DOCX_IMPORT_UNAVAILABLE",
        "This document is a DOCX file and the server cannot import DOCX because the core OOXML adapter is not loadable. Build packages/core to enable it.",
      );
    }
    const imported = await contract.importDocx(docxBytes, {
      fileName: `${id}.docx`,
    });
    return {
      document: imported.document,
      title: id,
      kind: "docx",
      warnings: imported.warnings ?? [],
    };
  };

  /* ---------------------------------------------------------------- health */

  app.get(
    "/api/health",
    asyncRoute((_request, response) => {
      response.json({
        ok: true,
        version,
        capabilities: {
          renderer: core.capabilities.renderer,
          formats: core.formats,
          ai: core.capabilities.ai,
          model: core.capabilities.model,
          docx: core.capabilities.docx,
          convert: core.capabilities.convert,
        },
        warnings: core.warnings,
      });
    }),
  );

  /* -------------------------------------------------------------- documents */

  app.get(
    "/api/documents",
    asyncRoute(async (_request, response) => {
      const documents = await workspace.list();
      response.json({ documents });
    }),
  );

  app.post(
    "/api/documents",
    asyncRoute(async (request, response) => {
      const body = await readJsonBody(request);
      const requestedTitle =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : "Untitled document";
      let document = body.document;
      const warnings: string[] = [];

      if (document === undefined) {
        const createDocument = pickFunction(core.modules.model, [
          "createDocument",
        ]);
        if (!createDocument) {
          throw new HttpError(
            503,
            "MODEL_UNAVAILABLE",
            "No document body was supplied and the core document model is not loadable server-side. Build packages/core (pnpm --filter @dsh-doc/core build) or create the document in the client and send it in the request body.",
          );
        }
        document = createDocument({ title: requestedTitle });
      } else {
        
      }

      const shape = validateDocumentShape(document);
      if (!shape.ok) {
        throw new HttpError(
          400,
          "INVALID_DOCUMENT",
          shape.reason ?? "The document body is not a valid document",
        );
      }
      const validate = pickFunction(core.modules.model, ["validateDocument"]);
      if (validate) {
        const outcome = validate(document) as {
          valid?: boolean;
          issues?: unknown;
        };
        if (outcome && outcome.valid === false) {
          throw new HttpError(
            422,
            "DOCUMENT_VALIDATION_FAILED",
            "The core model rejected this document",
            outcome.issues,
          );
        }
      } else {
        warnings.push(
          "The core model is unavailable: only structural validation was performed.",
        );
      }

      const id = makeDocumentId();
      const title =
        typeof document === "object" &&
        document &&
        typeof (document as { metadata?: { title?: string } }).metadata
          ?.title === "string"
          ? (document as { metadata: { title: string } }).metadata.title ||
            requestedTitle
          : requestedTitle;
      const record = await workspace.writeJson({
        id,
        title,
        document,
        warnings,
      });
      response.status(201).json({
        id: record.id,
        title: record.title,
        document: record.document,
        meta: {
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          validated: Boolean(validate),
          warnings,
        },
      });
    }),
  );

  app.post(
    "/api/documents/open",
    upload.single("file"),
    asyncRoute(async (request, response) => {
      const file = request.file;
      if (!file) {
        throw new HttpError(
          400,
          "MISSING_FILE",
          "Attach the document as multipart field “file”",
        );
      }
      if (!contract.importDocx) {
        throw new HttpError(
          501,
          "DOCX_IMPORT_UNAVAILABLE",
          "The server cannot import DOCX because the core OOXML adapter is not loadable. Build packages/core to enable import.",
        );
      }
      const imported = await contract.importDocx(file.buffer, {
        fileName: file.originalname,
      });
      const shape = validateDocumentShape(imported.document);
      if (!shape.ok) {
        throw new HttpError(
          502,
          "IMPORT_INVALID_DOCUMENT",
          `The importer produced an invalid document: ${shape.reason}`,
        );
      }
      const title =
        path.basename(file.originalname, path.extname(file.originalname)) ||
        "Imported document";
      const id = makeDocumentId();
      const warnings = imported.warnings ?? [];
      const record = await workspace.writeJson({
        id,
        title,
        document: imported.document,
        source: file.originalname,
        warnings,
      });
      response.status(201).json({
        id: record.id,
        title: record.title,
        document: record.document,
        meta: {
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          validated: true,
          source: record.source,
          warnings,
          compatibility: imported.report ?? null,
        },
      });
    }),
  );

  app.get(
    "/api/documents/:id",
    asyncRoute(async (request, response) => {
      const id = requireDocumentId(String(request.params.id ?? ""));
      const stored = await loadStoredDocument(id);
      response.json({
        id,
        title: stored.title,
        document: stored.document,
        meta: {
          updatedAt: new Date().toISOString(),
          validated: core.capabilities.model,
          warnings: stored.warnings,
          source: stored.kind === "docx" ? `${id}.docx` : `${id}.json`,
        },
      });
    }),
  );

  app.put(
    "/api/documents/:id",
    asyncRoute(async (request, response) => {
      const id = requireDocumentId(String(request.params.id ?? ""));
      const body = await readJsonBody(request);
      if (body.document === undefined) {
        throw new HttpError(
          400,
          "MISSING_DOCUMENT",
          "Send the document under the `document` property",
        );
      }
      const shape = validateDocumentShape(body.document);
      if (!shape.ok) {
        throw new HttpError(
          400,
          "INVALID_DOCUMENT",
          shape.reason ?? "The document body is not a valid document",
        );
      }
      const existing = await workspace.exists(id);
      if (!existing.json && !existing.docx) {
        throw new HttpError(
          404,
          "DOCUMENT_NOT_FOUND",
          `No document with id “${id}” exists; create it with POST /api/documents`,
        );
      }
      if (existing.docx && !existing.json) {
        throw new HttpError(
          409,
          "DOCX_READ_ONLY",
          "This workspace entry is a DOCX file. Open it through /api/documents/open to create an editable JSON record first.",
        );
      }
      const validate = pickFunction(core.modules.model, ["validateDocument"]);
      const warnings: string[] = [];
      let validated = false;
      if (validate) {
        const outcome = validate(body.document) as {
          valid?: boolean;
          issues?: unknown;
        };
        validated = true;
        if (outcome && outcome.valid === false) {
          throw new HttpError(
            422,
            "DOCUMENT_VALIDATION_FAILED",
            "The core model rejected this document",
            outcome.issues,
          );
        }
      } else {
        warnings.push(
          "The core model is unavailable: only structural validation was performed.",
        );
      }
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : typeof (body.document as { metadata?: { title?: string } }).metadata
                ?.title === "string"
            ? (body.document as { metadata: { title: string } }).metadata
                .title || id
            : id;
      const record = await workspace.writeJson({
        id,
        title,
        document: body.document,
        warnings,
      });
      response.json({
        id: record.id,
        title: record.title,
        document: record.document,
        meta: { updatedAt: record.updatedAt, validated, warnings },
      });
    }),
  );

  app.delete(
    "/api/documents/:id",
    asyncRoute(async (request, response) => {
      const id = requireDocumentId(String(request.params.id ?? ""));
      const removed = await workspace.remove(id);
      if (!removed)
        throw new HttpError(
          404,
          "DOCUMENT_NOT_FOUND",
          `No document with id “${id}” exists`,
        );
      response.json({ ok: true, id });
    }),
  );

  /* ----------------------------------------------------------------- export */

  app.post(
    "/api/documents/:id/export",
    asyncRoute(async (request, response) => {
      const id = requireDocumentId(String(request.params.id ?? ""));
      const body = await readJsonBody(request);
      const format =
        typeof body.format === "string" ? body.format.trim().toLowerCase() : "";
      if (!EXPORT_EXTENSIONS.has(format)) {
        throw new HttpError(
          400,
          "UNSUPPORTED_FORMAT",
          `The requested format is not an export format this server knows`,
          {
            requested: format,
            known: [...EXPORT_EXTENSIONS],
          },
        );
      }
      const stored = await loadStoredDocument(id);
      let bytes: Uint8Array | null = null;
      const warnings: string[] = [...stored.warnings];

      if (contract.convertExport && !(format === "pdf" && contract.renderPdf)) {
        const engineFormat = ENGINE_FORMAT[format] ?? format;
        try {
          const result = await contract.convertExport(stored.document, {
            from: "auto",
            to: engineFormat,
            fileName: exportFileName(stored.title, format),
            preserveTimestamps: true,
          });
          const produced = bytesOf(result);
          if (produced) {
            bytes = produced;
            if (result && typeof result === "object") {
              const resultWarnings = (result as { warnings?: unknown })
                .warnings;
              if (Array.isArray(resultWarnings)) {
                warnings.push(
                  ...resultWarnings.filter(
                    (entry): entry is string => typeof entry === "string",
                  ),
                );
              }
            }
          }
        } catch (error) {
          warnings.push(
            `Conversion engine failed for ${format}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!bytes && format === "docx" && contract.exportDocx) {
        const result = await contract.exportDocx(stored.document, {});
        bytes = result.buffer;
        if (result.warnings) warnings.push(...result.warnings);
      }

      // The conversion engine may not own a PDF renderer; the platform's
      // layout + PDF renderer is the authoritative PDF path.
      if (!bytes && format === "pdf" && contract.renderPdf) {
        try {
          const rendered = await contract.renderPdf(stored.document, {});
          const produced = bytesOf(rendered);
          if (produced) bytes = produced;
        } catch (error) {
          warnings.push(`PDF renderer failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!bytes && format === "html" && contract.renderHtml) {
        try {
          const rendered = await contract.renderHtml(stored.document, {});
          const html = textOf(rendered);
          if (html) bytes = new TextEncoder().encode(html);
        } catch (error) {
          warnings.push(`HTML renderer failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!bytes && format === "txt" && contract.documentText) {
        bytes = new TextEncoder().encode(
          contract.documentText(stored.document),
        );
      }

      if (!bytes) {
        throw new HttpError(
          501,
          "FORMAT_UNAVAILABLE",
          `Export to ${format.toUpperCase()} is not available on this server. ${
            core.formats.length > 0
              ? `Currently available: ${core.formats.join(", ")}.`
              : "No export backend is loadable — build packages/core (docx/convert) first."
          }`,
          { requested: format, available: core.formats },
        );
      }

      const fileName = exportFileName(stored.title, format);
      const contentType =
        EXPORT_CONTENT_TYPES[format] ?? "application/octet-stream";
      response.setHeader("Content-Type", contentType);
      response.setHeader("Content-Length", String(bytes.byteLength));
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      if (warnings.length > 0) {
        response.setHeader(
          "X-Document-Warnings",
          warnings.slice(0, 8).join(" | ").slice(0, 1024),
        );
      }
      response.end(Buffer.from(bytes));
    }),
  );

  /* ----------------------------------------------------------------- render */

  app.get(
    "/api/render",
    asyncRoute(async (request, response) => {
      const format = String(request.query.format ?? "html").toLowerCase();
      if (format !== "html" && format !== "pdf") {
        throw new HttpError(
          400,
          "UNSUPPORTED_RENDER_FORMAT",
          "format must be html or pdf",
          { requested: format },
        );
      }
      const renderer =
        format === "pdf" ? contract.renderPdf : contract.renderHtml;
      if (!renderer) {
        throw new HttpError(
          501,
          "RENDERER_UNAVAILABLE",
          `The server's ${format.toUpperCase()} renderer is not available: the core layout/render modules are not loadable. Build packages/core to enable server-side rendering.`,
        );
      }

      let id: string | undefined;
      if (request.query.id !== undefined) {
        id = requireDocumentId(String(request.query.id));
      } else {
        const documents = await workspace.list();
        id =
          documents.find((entry) => entry.kind === "json")?.id ??
          documents[0]?.id;
      }
      if (!id)
        throw new HttpError(
          404,
          "NO_DOCUMENTS",
          "There is no document to render yet",
        );

      const stored = await loadStoredDocument(id);
      const result = await renderer(stored.document, {});
      if (format === "html") {
        const html = textOf(result);
        if (!html)
          throw new HttpError(
            502,
            "RENDER_FAILED",
            "The renderer returned no HTML",
          );
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("X-Document-Id", id);
        response.send(html);
        return;
      }
      const bytes = bytesOf(result);
      if (!bytes)
        throw new HttpError(
          502,
          "RENDER_FAILED",
          "The renderer returned no PDF bytes",
        );
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("X-Document-Id", id);
      response.end(Buffer.from(bytes));
    }),
  );

  /* --------------------------------------------------------------------- AI */

  app.post(
    "/api/ai/assist",
    asyncRoute(async (request, response) => {
      if (!contract.aiAssist) {
        throw new HttpError(
          501,
          "AI_PROVIDER_NOT_CONFIGURED",
          "No AI provider is configured on this server: the core AI module is not loadable or reports no provider. No AI output is generated.",
        );
      }
      const body = await readJsonBody(request);
      const mode = typeof body.mode === "string" ? body.mode : "ask";
      if (mode !== "ask" && mode !== "suggest" && mode !== "edit") {
        throw new HttpError(
          400,
          "INVALID_MODE",
          "mode must be ask, suggest or edit",
        );
      }
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt)
        throw new HttpError(
          400,
          "MISSING_PROMPT",
          "A non-empty prompt is required",
        );

      let document = body.document;
      if (document === undefined) {
        const documents = await workspace.list();
        const id =
          documents.find((entry) => entry.kind === "json")?.id ??
          documents[0]?.id;
        if (!id)
          throw new HttpError(
            400,
            "MISSING_DOCUMENT",
            "Send the document with the request or save one first",
          );
        document = (await loadStoredDocument(id)).document;
      }
      const shape = validateDocumentShape(document);
      if (!shape.ok)
        throw new HttpError(
          400,
          "INVALID_DOCUMENT",
          shape.reason ?? "Invalid document",
        );

      const options = (
        body.options && typeof body.options === "object" ? body.options : {}
      ) as Record<string, unknown>;
      const requestedOperation =
        typeof options.operation === "string" ? options.operation : undefined;
      const operation = chooseAiOperation(mode, prompt, requestedOperation);

      const input: Record<string, unknown> = {
        document,
        range: body.range,
        prompt,
        instruction: prompt,
        mode,
        targetLanguage: options.targetLanguage ?? options.language,
        style: options.style,
        maxSentences: options.maxSentences,
        tone: options.tone,
        checks: options.checks,
        afterBlockId: options.afterBlockId,
        maxOperations: options.maxOperations,
      };

      let raw: unknown;
      try {
        raw = await contract.aiAssist(operation, input);
      } catch (error) {
        throw new HttpError(
          502,
          "AI_PROVIDER_ERROR",
          `The AI service failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const result = (
        raw && typeof raw === "object"
          ? raw
          : { ok: false, answer: String(raw) }
      ) as {
        ok?: boolean;
        operation?: string;
        provider?: string;
        model?: string;
        answer?: string;
        operations?: Array<{ tool?: string; summary?: string; args?: unknown }>;
        preview?: { before?: string; after?: string };
        warnings?: string[];
        findings?: unknown[];
        error?: { code?: string; message?: string; hint?: string };
      };

      if (result.ok === false) {
        const code = result.error?.code ?? "AI_REQUEST_FAILED";
        const message =
          result.error?.message ?? "The AI service reported a failure";
        const hint = result.error?.hint ? ` ${result.error.hint}` : "";
        if (
          code === "AI_PROVIDER_REQUIRED" ||
          code === "AI_PROVIDER_NOT_CONFIGURED"
        ) {
          throw new HttpError(
            501,
            "AI_PROVIDER_NOT_CONFIGURED",
            `${message}${hint}`,
          );
        }
        if (
          code === "RANGE_REQUIRED" ||
          code === "INVALID_ARGUMENT" ||
          code === "DOCUMENT_REQUIRED"
        ) {
          throw new HttpError(400, code, `${message}${hint}`);
        }
        throw new HttpError(502, code, `${message}${hint}`);
      }

      const operations = Array.isArray(result.operations)
        ? result.operations
        : [];
      const warnings = Array.isArray(result.warnings)
        ? result.warnings.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];

      response.json({
        mode,
        operationName: result.operation ?? operation,
        provider: result.model
          ? `${result.provider ?? "unknown"} · ${result.model}`
          : result.provider,
        answer: result.answer,
        suggestion: result.preview
          ? {
              before: result.preview.before ?? "",
              after: result.preview.after ?? "",
              rationale: warnings.join(" ") || undefined,
            }
          : undefined,
        operation: operations.length
          ? {
              summary: operations
                .map((entry) => entry.summary ?? entry.tool ?? "operation")
                .join(" · "),
              operations,
            }
          : undefined,
        findings: result.findings,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    }),
  );

  /* ---------------------------------------------------------------- static */

  const clientDirectory = path.resolve(HERE, "..", "dist-client");
  const clientIndex = path.join(clientDirectory, "index.html");
  if (existsSync(clientDirectory)) {
    app.use(
      express.static(clientDirectory, {
        index: false,
        fallthrough: true,
        maxAge: "1h",
      }),
    );
  }

  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) {
      response.status(404).json({
        error: "NOT_FOUND",
        message: `Unknown API route: ${request.method} ${request.path}`,
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    if (existsSync(clientIndex)) {
      response.sendFile(clientIndex);
      return;
    }
    response.status(503).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DSH Docs — client not built</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;line-height:1.55;color:#1a1d21}code{background:#f1f3f5;padding:1px 5px;border-radius:4px}</style>
</head><body>
<h1>DSH Docs API is running</h1>
<p>The browser client has not been built yet, so there is no UI to serve from <code>apps/web/dist-client</code>.</p>
<ul>
<li>Build it: <code>pnpm --filter @dsh-doc/web build</code>, then reload this page.</li>
<li>Or develop with hot reload: <code>pnpm --filter @dsh-doc/web dev</code> (Vite serves the UI and proxies <code>/api</code> here).</li>
</ul>
<p>The API itself is available: <a href="/api/health">/api/health</a>, <a href="/api/documents">/api/documents</a>.</p>
</body></html>`);
  });

   
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (error instanceof HttpError) {
        response.status(error.status).json({
          error: error.code,
          code: error.code,
          message: error.message,
          details: error.details,
        });
        return;
      }
      if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        response.status(status).json({
          error: error.code,
          code: error.code,
          message:
            error.code === "LIMIT_FILE_SIZE"
              ? `Uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`
              : error.message,
        });
        return;
      }
      const maybeBodyError = error as {
        type?: string;
        status?: number;
        message?: string;
      };
      if (maybeBodyError?.type === "entity.too.large") {
        response.status(413).json({
          error: "BODY_TOO_LARGE",
          code: "BODY_TOO_LARGE",
          message: `JSON bodies are limited to ${MAX_BODY}`,
        });
        return;
      }
      if (maybeBodyError?.type === "entity.parse.failed") {
        response.status(400).json({
          error: "INVALID_JSON",
          code: "INVALID_JSON",
          message: "The request body is not valid JSON",
        });
        return;
      }
      console.error("[dsh-doc] unhandled error:", error);
      response.status(500).json({
        error: "INTERNAL_ERROR",
        code: "INTERNAL_ERROR",
        message:
          error instanceof Error ? error.message : "Unexpected server error",
      });
    },
  );

  // Ensure the workspace directory exists even when the server starts cold.
  await mkdir(workspaceRoot, { recursive: true });

  return { app, core, workspace, contract, version };
}

async function main(): Promise<void> {
  const server = await createServer();
  const port = Number(process.env.PORT ?? 4317);
  const host = process.env.HOST ?? "127.0.0.1";
  const listener = server.app.listen(port, host, () => {
    const capabilities = server.core.capabilities;
    console.log(`[dsh-doc] web server listening on http://${host}:${port}`);
    console.log(
      `[dsh-doc] core root: ${server.core.root} · model=${capabilities.model} docx=${capabilities.docx} convert=${capabilities.convert} renderer=${capabilities.renderer} ai=${capabilities.ai}`,
    );
    for (const warning of server.core.warnings)
      console.warn(`[dsh-doc] ${warning}`);
    console.log(`[dsh-doc] workspace: ${server.workspace.root}`);
  });
  const shutdown = (signal: string): void => {
    console.log(`[dsh-doc] ${signal} received, shutting down`);
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isMain) {
  main().catch((error) => {
    console.error("[dsh-doc] failed to start:", error);
    process.exitCode = 1;
  });
}
