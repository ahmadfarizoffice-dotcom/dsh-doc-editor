/**
 * Runtime discovery of the shared core package.
 *
 * The server never imports `packages/core` statically: the package is compiled
 * separately (packages/core/dist) and may not be built yet. Each submodule is
 * loaded dynamically and capabilities are reported honestly — a missing module
 * turns the related endpoint into an explicit 501 instead of fabricated output.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findRepositoryRoot } from "./workspace.js";

export type CoreApi = Record<string, unknown>;
export type CoreSubmodule = "model" | "docx" | "convert" | "render" | "ai";

export interface CoreBundle {
  root: string;
  distDirectory: string;
  modules: Record<CoreSubmodule, CoreApi | null>;
  warnings: string[];
  /** Where each module was loaded from (null when unavailable). */
  sources: Record<CoreSubmodule, string | null>;
  formats: string[];
  capabilities: {
    model: boolean;
    docx: boolean;
    convert: boolean;
    renderer: boolean;
    ai: boolean;
  };
}

const SUBMODULES: CoreSubmodule[] = [
  "model",
  "docx",
  "convert",
  "render",
  "ai",
];

/** Known-format contract of the conversion engine (used only when it has no capability list). */
const DOCUMENTED_CONVERT_FORMATS = [
  "docx",
  "html",
  "odt",
  "rtf",
  "md",
  "txt",
  "pdf",
];

export function pickFunction(
  api: CoreApi | null,
  names: string[],
): ((...args: unknown[]) => unknown) | null {
  if (!api) return null;
  for (const name of names) {
    const candidate = api[name];
    if (typeof candidate === "function")
      return candidate as (...args: unknown[]) => unknown;
  }
  return null;
}

async function importCandidate(
  specifier: string,
): Promise<{ api: CoreApi; source: string } | null> {
  try {
    const module = (await import(specifier)) as CoreApi;
    return { api: module, source: specifier };
  } catch {
    return null;
  }
}

/**
 * Loads the core submodules from (in order): an explicit dist override, the
 * repository's `packages/core/dist`, and the linked workspace package.
 */
export async function loadCore(
  options: { root?: string; distDirectory?: string } = {},
): Promise<CoreBundle> {
  const root = path.resolve(
    options.root ??
      process.env.DSH_DOC_ROOT ??
      findRepositoryRoot(process.cwd()),
  );
  const distDirectory = path.resolve(
    options.distDirectory ??
      process.env.DSH_DOC_CORE_DIST ??
      path.join(root, "packages", "core", "dist"),
  );
  const warnings: string[] = [];
  const modules = {} as Record<CoreSubmodule, CoreApi | null>;
  const sources = {} as Record<CoreSubmodule, string | null>;

  if (!existsSync(distDirectory)) {
    warnings.push(
      `Core package build output not found at ${distDirectory}. Server-side model, conversion, rendering and AI features report themselves as unavailable until packages/core is built (pnpm --filter @dsh-doc/core build).`,
    );
  }

  for (const submodule of SUBMODULES) {
    const candidates: string[] = [];
    const built = path.join(distDirectory, submodule, "index.js");
    if (existsSync(built)) candidates.push(pathToFileURL(built).href);
    const flattened = path.join(distDirectory, `${submodule}.js`);
    if (existsSync(flattened)) candidates.push(pathToFileURL(flattened).href);
    candidates.push(`@dsh-doc/core/${submodule}`);

    let loaded: { api: CoreApi; source: string } | null = null;
    const failures: string[] = [];
    for (const candidate of candidates) {
      loaded = await importCandidate(candidate);
      if (loaded) break;
      failures.push(candidate);
    }

    modules[submodule] = loaded?.api ?? null;
    sources[submodule] = loaded?.source ?? null;
    if (!loaded) {
      warnings.push(
        `Core submodule "${submodule}" is unavailable (tried ${failures
          .map((entry) => entry.replace(/^file:\/\//, ""))
          .join(", ")}).`,
      );
    }
  }

  const docxExport = pickFunction(modules.docx, ["exportDocx"]);
  const docxImport = pickFunction(modules.docx, ["importDocx"]);
  const convertExport = pickFunction(modules.convert, [
    "convertToBuffer",
    "convert",
    "exportDocument",
    "convertDocument",
  ]);
  const renderHtml = pickFunction(modules.render, [
    "renderDocumentHtml",
    "renderHtml",
    "renderToHtml",
  ]);
  const renderPdf = pickFunction(modules.render, [
    "renderDocumentPdf",
    "renderPdf",
    "renderToPdf",
  ]);
  const modelText = pickFunction(modules.model, ["documentText"]);
  const aiAssist = pickFunction(modules.ai, [
    "runAssistantOperation",
    "assist",
    "runAssistant",
    "assistDocument",
  ]);

  /** Public format ids for engine ids (`markdown` → `md`, `text` → `txt`). */
  const PUBLIC_FORMAT: Record<string, string> = { markdown: "md", text: "txt" };
  let convertFormats: string[] = [];
  if (convertExport) {
    const matrix = pickFunction(modules.convert, ["getCapabilityMatrix"]);
    const targets = pickFunction(modules.convert, ["supportedTargets"]);
    try {
      if (matrix) {
        const rows = (matrix as () => unknown)();
        if (Array.isArray(rows)) {
          convertFormats = [
            ...new Set(
              rows
                .filter(
                  (
                    row,
                  ): row is {
                    from: string;
                    to: string;
                    available?: boolean;
                  } => {
                    return (
                      Boolean(row) &&
                      typeof row === "object" &&
                      (row as { from?: unknown }).from === "docx"
                    );
                  },
                )
                .filter((row) => row.available !== false)
                .map((row) => PUBLIC_FORMAT[row.to] ?? row.to),
            ),
          ];
        }
      } else if (targets) {
        const rows = (targets as (from: string) => unknown)("docx");
        if (Array.isArray(rows)) {
          convertFormats = [
            ...new Set(
              rows
                .map((row) =>
                  row && typeof row === "object"
                    ? (row as { to?: unknown }).to
                    : undefined,
                )
                .filter((value): value is string => typeof value === "string")
                .map((value) => PUBLIC_FORMAT[value] ?? value),
            ),
          ];
        }
      }
    } catch {
      convertFormats = [];
    }
    if (convertFormats.length === 0) {
      convertFormats = [...DOCUMENTED_CONVERT_FORMATS];
      warnings.push(
        "The conversion engine did not report its capability matrix; the documented format contract (docx, html, odt, rtf, md, txt, pdf) is advertised.",
      );
    }
  }

  const formats = new Set<string>();
  if (convertFormats.length > 0)
    for (const format of convertFormats) formats.add(format);
  else {
    if (docxExport) formats.add("docx");
    if (modelText) formats.add("txt");
  }
  if (docxExport) formats.add("docx");
  if (renderHtml) formats.add("html");
  if (renderPdf) formats.add("pdf");

  let aiAvailable = false;
  if (aiAssist) {
    try {
      const status = modules.ai?.providerStatus;
      if (typeof status === "function") {
        const value = (status as () => unknown).call(modules.ai) as {
          available?: unknown;
          configured?: unknown;
          offline?: unknown;
          provider?: unknown;
        };
        aiAvailable = value?.available === true;
        if (value?.offline === true) {
          warnings.push(
            `AI provider "${String(value.provider)}" is offline: summarisation and review run without a language model; rewrite/translate/generate/suggest operations answer AI_PROVIDER_REQUIRED.`,
          );
        } else if (value?.configured !== true) {
          warnings.push("The AI module reports no configured provider.");
        }
      } else {
        aiAvailable = true;
      }
    } catch {
      aiAvailable = false;
    }
  }

  if (docxExport && !docxImport) {
    warnings.push(
      "The DOCX adapter can export but not import; POST /api/documents/open will return 501.",
    );
  }

  return {
    root,
    distDirectory,
    modules,
    sources,
    warnings,
    formats: [...formats],
    capabilities: {
      model: modules.model !== null,
      docx: modules.docx !== null,
      convert: modules.convert !== null,
      renderer: Boolean(renderHtml || renderPdf),
      ai: Boolean(aiAssist) && aiAvailable,
    },
  };
}

export interface ModuleContract {
  exportDocx:
    | ((
        document: unknown,
        options?: unknown,
      ) => Promise<{ buffer: Uint8Array; warnings?: string[] }>)
    | null;
  importDocx:
    | ((
        bytes: Uint8Array,
        options?: unknown,
      ) => Promise<{
        document: unknown;
        report?: unknown;
        warnings?: string[];
        unmappedParts?: string[];
      }>)
    | null;
  /** `convertToBuffer(document, options)` style export (options carries `to`). */
  convertExport:
    | ((input: unknown, options: Record<string, unknown>) => Promise<unknown>)
    | null;
  renderHtml:
    | ((document: unknown, options?: unknown) => Promise<unknown> | unknown)
    | null;
  renderPdf:
    | ((document: unknown, options?: unknown) => Promise<unknown> | unknown)
    | null;
  documentText: ((document: unknown, options?: unknown) => string) | null;
  /** `runAssistantOperation(operation, input)` style entry point. */
  aiAssist:
    | ((operation: string, input: Record<string, unknown>) => Promise<unknown>)
    | null;
}

/** Resolved callable surface of the loaded core package. */
export function contractOf(bundle: CoreBundle): ModuleContract {
  return {
    exportDocx: pickFunction(bundle.modules.docx, [
      "exportDocx",
    ]) as ModuleContract["exportDocx"],
    importDocx: pickFunction(bundle.modules.docx, [
      "importDocx",
    ]) as ModuleContract["importDocx"],
    convertExport: pickFunction(bundle.modules.convert, [
      "convertToBuffer",
      "convert",
      "exportDocument",
      "convertDocument",
    ]) as ModuleContract["convertExport"],
    renderHtml: pickFunction(bundle.modules.render, [
      "renderDocumentHtml",
      "renderHtml",
      "renderToHtml",
    ]) as ModuleContract["renderHtml"],
    renderPdf: pickFunction(bundle.modules.render, [
      "renderDocumentPdf",
      "renderPdf",
      "renderToPdf",
    ]) as ModuleContract["renderPdf"],
    documentText: pickFunction(bundle.modules.model, [
      "documentText",
    ]) as ModuleContract["documentText"],
    aiAssist: pickFunction(bundle.modules.ai, [
      "runAssistantOperation",
      "assist",
      "runAssistant",
      "assistDocument",
    ]) as ModuleContract["aiAssist"],
  };
}

/** Reads bytes out of the various shapes an exporter may return. */
export function bytesOf(result: unknown): Uint8Array | null {
  if (result instanceof Uint8Array) return result;
  if (typeof result === "string") return new TextEncoder().encode(result);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["buffer", "bytes", "data", "content", "output"]) {
      const value = record[key];
      if (value instanceof Uint8Array) return value;
      if (typeof value === "string") return new TextEncoder().encode(value);
    }
  }
  return null;
}

/** Reads text out of a renderer result. */
export function textOf(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result instanceof Uint8Array) return new TextDecoder().decode(result);
  if (result && typeof result === "object") {
    for (const key of ["html", "text", "content", "body", "output"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    }
  }
  return null;
}
