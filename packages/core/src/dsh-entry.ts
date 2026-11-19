/**
 * Entry point for the self-contained DeepSeek Harness plugin bundle.
 *
 * It exposes the same engine the editor, CLI and MCP server use: the document
 * service, the tool registry with typed schemas, and the AI review helpers.
 * The bundler in `tools/build-dsh-plugin.mjs` inlines every dependency so the
 * plugin installs from GitHub without a build step or a package registry.
 */
export { DocumentService } from "./service/service.js";
export { Workspace, ServiceError } from "./service/workspace.js";
export {
  listTools,
  getTool,
  invokeTool,
  buildToolManifest,
} from "./tools/registry.js";
export { reviewDocument, providerStatus } from "./ai/assistant.js";
export { createDocument, PAGE_PRESETS } from "./model/create.js";
export { documentStats, documentText } from "./model/text.js";
export { documentOutline, searchDocument } from "./model/query.js";
export {
  importAny,
  exportAny,
  availableFormats,
  detectFormat,
} from "./formats/index.js";
export { convert } from "./convert/index.js";
export { layoutDocument } from "./layout/index.js";
export { renderHtml, renderPdf } from "./render/index.js";
