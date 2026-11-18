/**
 * @dsh-doc/core - shared document platform library.
 *
 * Module map:
 *  - model   : versioned format-independent document model + deterministic operations
 *  - docx    : OOXML (DOCX/DOTX/DOCM) import and export
 *  - formats : other format adapters (HTML, Markdown, RTF, ODT, legacy DOC, XLSX/PPTX preview)
 *  - layout  : pagination / line breaking / table and float layout engine
 *  - render  : HTML, SVG and PDF renderers over the layout model
 *  - convert : conversion engine, capability matrix and loss reporting
 *  - service : unified document service (workspace, sessions, history, operations)
 *  - ai      : provider independent document assistant
 *  - tools   : MCP/agent tool registry with typed schemas
 */
export * from "./model/index.js";
export * from "./service/index.js";
