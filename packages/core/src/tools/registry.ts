/**
 * Single tool registry shared by the MCP server, native agent tool definitions,
 * the HTTP API and tests. Business logic lives in DocumentService; this module
 * only describes and validates the public surface.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { DocumentService } from "../service/service.js";
import { ServiceError } from "../service/workspace.js";

export const positionSchema = z.object({
  blockId: z
    .string()
    .min(1)
    .describe("Paragraph id from document_get_content or document_search"),
  inlineIndex: z.number().int().min(0).optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("UTF-16 offset within the paragraph text"),
});

export const rangeSchema = z.object({
  start: positionSchema,
  end: positionSchema,
});

export const runPropsSchema = z
  .object({
    fontFamily: z.string().optional(),
    fontSize: z.number().positive().max(400).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z
      .union([
        z.boolean(),
        z.enum(["single", "double", "dotted", "dash", "wave", "thick"]),
      ])
      .optional(),
    strike: z.boolean().optional(),
    vertAlign: z.enum(["baseline", "superscript", "subscript"]).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    highlight: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    charSpacing: z.number().min(-20).max(100).optional(),
    caps: z.boolean().optional(),
    smallCaps: z.boolean().optional(),
    language: z.string().optional(),
    characterStyle: z.string().optional(),
  })
  .partial();

export const paragraphPropsSchema = z
  .object({
    alignment: z
      .enum(["left", "center", "right", "justify", "distribute"])
      .optional(),
    lineSpacing: z
      .object({
        rule: z.enum(["auto", "exact", "atLeast"]),
        value: z.number().positive(),
      })
      .optional(),
    spaceBefore: z.number().min(0).max(2000).optional(),
    spaceAfter: z.number().min(0).max(2000).optional(),
    indent: z
      .object({
        left: z.number().optional(),
        right: z.number().optional(),
        firstLine: z.number().optional(),
        hanging: z.number().optional(),
      })
      .optional(),
    keepNext: z.boolean().optional(),
    keepLines: z.boolean().optional(),
    widowControl: z.boolean().optional(),
    pageBreakBefore: z.boolean().optional(),
    outlineLevel: z.number().int().min(0).max(8).optional(),
    shading: z.object({ fill: z.string().optional() }).optional(),
  })
  .partial();

export type ToolCategory =
  "lifecycle" | "reading" | "editing" | "advanced" | "conversion" | "ai";

export interface ToolInvocationResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodRawShape;
  handler: (
    context: { service: DocumentService },
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Mutating tools require explicit authorization and are audited. */
  mutating?: boolean;
  /** Operations that need an LLM provider configured. */
  requiresAi?: boolean;
}

function id(): z.ZodString {
  return z
    .string()
    .min(1)
    .describe("Document id returned by document_create or document_open");
}

const tools: ToolDescriptor[] = [];

function tool(descriptor: ToolDescriptor): void {
  tools.push(descriptor);
}

/* ------------------------------------------------------------- lifecycle */

tool({
  name: "document_create",
  title: "Create document",
  category: "lifecycle",
  mutating: true,
  description:
    "Creates a new document in the workspace with Word-compatible defaults (A4, Calibri 11, Normal style). Returns the document id and the document model.",
  inputSchema: {
    title: z.string().max(300).optional(),
    author: z.string().max(200).optional(),
    pageSize: z
      .enum(["A3", "A4", "A5", "B5", "Letter", "Legal", "Tabloid", "Executive"])
      .optional(),
    landscape: z.boolean().optional(),
    paragraphs: z
      .array(z.string())
      .max(5000)
      .optional()
      .describe("Initial paragraph texts"),
    language: z.string().max(20).optional(),
  },
  handler: async ({ service }, args) => service.createDocument(args as never),
});

tool({
  name: "document_open",
  title: "Open document",
  category: "lifecycle",
  mutating: true,
  description:
    "Opens a document from an allowed path (DOCX/DOTX/DOCM plus any installed format adapter) and returns its id, model and compatibility report.",
  inputSchema: { path: z.string().min(1) },
  handler: async ({ service }, args) => service.openDocument(String(args.path)),
});

tool({
  name: "document_save",
  title: "Save document",
  category: "lifecycle",
  mutating: true,
  description:
    "Saves the document to the workspace (DOCX + lossless JSON snapshot). Optionally writes a DOCX copy to an explicit workspace path.",
  inputSchema: { documentId: id(), path: z.string().optional() },
  handler: async ({ service }, args) =>
    service.saveDocument(
      String(args.documentId),
      args.path ? String(args.path) : undefined,
    ),
});

tool({
  name: "document_save_as",
  title: "Save document as",
  category: "lifecycle",
  mutating: true,
  description:
    "Writes the document to a new workspace path; the format is inferred from the extension and must be a supported exporter.",
  inputSchema: { documentId: id(), path: z.string().min(1) },
  handler: async ({ service }, args) =>
    service.saveDocumentAs(String(args.documentId), String(args.path)),
});

tool({
  name: "document_close",
  title: "Close document",
  category: "lifecycle",
  mutating: true,
  description:
    "Closes an open document. Refuses when there are unsaved changes unless discardUnsaved is true.",
  inputSchema: { documentId: id(), discardUnsaved: z.boolean().optional() },
  handler: async ({ service }, args) =>
    service.closeDocument(String(args.documentId), {
      discardUnsaved: args.discardUnsaved === true,
    }),
});

tool({
  name: "document_get_metadata",
  title: "Get document metadata",
  category: "lifecycle",
  description:
    "Returns core/custom metadata, word and page statistics, the compatibility report and current layout warnings.",
  inputSchema: { documentId: id() },
  handler: async ({ service }, args) =>
    service.metadata(String(args.documentId)),
});

tool({
  name: "document_list_formats",
  title: "List formats",
  category: "lifecycle",
  description:
    "Returns the import/export format capability matrix, including which formats are actually available in this build and the known gaps (PDF import, spreadsheet/presentation preview-only).",
  inputSchema: {},
  handler: async ({ service }) => service.listFormats(),
});

/* --------------------------------------------------------------- reading */

tool({
  name: "document_get_content",
  title: "Get document content",
  category: "reading",
  description:
    "Returns the structured document: sections with page geometry, and per-block id, type, style, text and list label. Use block ids with the editing tools.",
  inputSchema: {
    documentId: id(),
    mode: z.enum(["final", "original", "all"]).optional(),
    includeTables: z.boolean().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  },
  handler: async ({ service }, args) =>
    service.getContent(String(args.documentId), args as never),
});

tool({
  name: "document_get_outline",
  title: "Get outline",
  category: "reading",
  description:
    "Returns the heading outline (level, text, block id, section) used by the navigation pane and table of contents.",
  inputSchema: {
    documentId: id(),
    maxLevel: z.number().int().min(1).max(9).optional(),
    includeTitle: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.getOutline(String(args.documentId), args as never),
});

tool({
  name: "document_get_text",
  title: "Get text",
  category: "reading",
  description:
    "Returns plain text for the document (or a block range) with word/character counts.",
  inputSchema: {
    documentId: id(),
    mode: z.enum(["final", "original", "all"]).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  },
  handler: async ({ service }, args) =>
    service.getText(String(args.documentId), args as never),
});

tool({
  name: "document_get_selection",
  title: "Get selection",
  category: "reading",
  description: "Extracts the text and block ids covered by a text range.",
  inputSchema: { documentId: id(), range: rangeSchema },
  handler: async ({ service }, args) =>
    service.getSelection(String(args.documentId), args.range as never),
});

tool({
  name: "document_get_page_info",
  title: "Get page info",
  category: "reading",
  description:
    "Returns page count and the rendered page (size, orientation, section) containing a block. Uses the layout engine.",
  inputSchema: { documentId: id(), blockId: z.string().optional() },
  handler: async ({ service }, args) =>
    service.getPageInfo(
      String(args.documentId),
      args.blockId ? String(args.blockId) : undefined,
    ),
});

tool({
  name: "document_search",
  title: "Search document",
  category: "reading",
  description:
    "Literal or regular-expression search across paragraph text, returning offsets, context and optionally page numbers.",
  inputSchema: {
    documentId: id(),
    query: z.string().min(1),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    includePages: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.search(String(args.documentId), String(args.query), args as never),
});

/* --------------------------------------------------------------- editing */

tool({
  name: "document_insert_text",
  title: "Insert text",
  category: "editing",
  mutating: true,
  description:
    "Inserts text at a position. Newlines create new paragraphs that inherit the source paragraph formatting.",
  inputSchema: {
    documentId: id(),
    position: positionSchema,
    text: z.string().max(200000),
    props: runPropsSchema.optional(),
  },
  handler: async ({ service }, args) =>
    service.insertText(String(args.documentId), {
      position: args.position as never,
      text: String(args.text),
      props: args.props as never,
    }),
});

tool({
  name: "document_replace_text",
  title: "Replace text",
  category: "editing",
  mutating: true,
  description:
    "Replaces a range with new text, preserving the formatting of the surrounding content.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema,
    text: z.string().max(200000),
    props: runPropsSchema.optional(),
  },
  handler: async ({ service }, args) =>
    service.replaceText(String(args.documentId), {
      range: args.range as never,
      text: String(args.text),
      props: args.props as never,
    }),
});

tool({
  name: "document_delete_range",
  title: "Delete range",
  category: "editing",
  mutating: true,
  description:
    "Deletes a text range. With tracked changes enabled the text is kept and marked deleted.",
  inputSchema: { documentId: id(), range: rangeSchema },
  handler: async ({ service }, args) =>
    service.deleteRange(String(args.documentId), {
      range: args.range as never,
    }),
});

tool({
  name: "document_format_text",
  title: "Format text",
  category: "editing",
  mutating: true,
  description:
    "Applies character formatting over a range: font family/size, bold, italic, underline, strike, superscript/subscript, colour, highlight, background, spacing, caps.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema,
    props: runPropsSchema,
    clear: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.formatText(String(args.documentId), {
      range: args.range as never,
      props: args.props as never,
      clear: args.clear === true,
    }),
});

tool({
  name: "document_format_paragraph",
  title: "Format paragraph",
  category: "editing",
  mutating: true,
  description:
    "Applies paragraph formatting: alignment, line spacing, space before/after, left/right/first-line/hanging indents, keep-with-next, keep-lines, widow control, shading.",
  inputSchema: {
    documentId: id(),
    blockIds: z.array(z.string().min(1)).min(1).max(500),
    props: paragraphPropsSchema,
  },
  handler: async ({ service }, args) =>
    service.formatParagraph(String(args.documentId), {
      blockIds: args.blockIds as string[],
      props: args.props as never,
    }),
});

tool({
  name: "document_apply_style",
  title: "Apply style",
  category: "editing",
  mutating: true,
  description:
    "Applies a named paragraph style (Title, Subtitle, Heading1-9, Normal, custom styles) to paragraphs.",
  inputSchema: {
    documentId: id(),
    blockIds: z.array(z.string().min(1)).min(1).max(500),
    styleId: z.string().min(1),
    clearDirectFormatting: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.applyStyle(String(args.documentId), {
      blockIds: args.blockIds as string[],
      styleId: String(args.styleId),
      clearDirectFormatting: args.clearDirectFormatting === true,
    }),
});

tool({
  name: "document_insert_heading",
  title: "Insert heading",
  category: "editing",
  mutating: true,
  description:
    "Inserts a heading paragraph (Heading 1-9 by level) after a block or at the end of the document.",
  inputSchema: {
    documentId: id(),
    text: z.string().max(20000),
    level: z.number().int().min(1).max(9),
    afterBlockId: z.string().optional(),
    styleId: z.string().optional(),
  },
  handler: async ({ service }, args) =>
    service.insertHeading(String(args.documentId), args as never),
});

tool({
  name: "document_insert_list",
  title: "Insert list",
  category: "editing",
  mutating: true,
  description:
    "Inserts a bulleted or numbered list. Supports nesting level, restart numbering via startAt and custom bullet glyphs via the service API.",
  inputSchema: {
    documentId: id(),
    items: z.array(z.string().max(20000)).min(1).max(500),
    kind: z.enum(["bullet", "number"]),
    afterBlockId: z.string().optional(),
    level: z.number().int().min(0).max(8).optional(),
    startAt: z.number().int().min(1).optional(),
  },
  handler: async ({ service }, args) =>
    service.insertList(String(args.documentId), args as never),
});

tool({
  name: "document_insert_table",
  title: "Insert table",
  category: "editing",
  mutating: true,
  description:
    "Inserts a table with optional cell data and a repeating header row.",
  inputSchema: {
    documentId: id(),
    rows: z.number().int().min(1).max(500),
    columns: z.number().int().min(1).max(50),
    data: z.array(z.array(z.string())).optional(),
    style: z.string().optional(),
    afterBlockId: z.string().optional(),
    headerRow: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.insertTable(String(args.documentId), args as never),
});

tool({
  name: "document_edit_table",
  title: "Edit table",
  category: "editing",
  mutating: true,
  description:
    "Structural table edits: insertRow, deleteRow, insertColumn, deleteColumn, mergeCells (region), splitCell (cellId), deleteTable.",
  inputSchema: {
    documentId: id(),
    tableId: z.string().min(1),
    operation: z.enum([
      "insertRow",
      "deleteRow",
      "insertColumn",
      "deleteColumn",
      "mergeCells",
      "splitCell",
      "deleteTable",
    ]),
    index: z.number().int().min(0).optional(),
    region: z
      .object({
        startRow: z.number().int().min(0),
        endRow: z.number().int().min(0),
        startColumn: z.number().int().min(0),
        endColumn: z.number().int().min(0),
      })
      .optional(),
    cellId: z.string().optional(),
  },
  handler: async ({ service }, args) =>
    service.editTable(String(args.documentId), args as never),
});

tool({
  name: "document_insert_image",
  title: "Insert image",
  category: "editing",
  mutating: true,
  description:
    "Inserts an image from a workspace path or base64 payload. Dimensions default to the intrinsic pixel size at 96 DPI; floating images use square wrap.",
  inputSchema: {
    documentId: id(),
    position: positionSchema,
    path: z.string().optional(),
    dataBase64: z.string().optional(),
    contentType: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    alt: z.string().max(2000).optional(),
    floating: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.insertImage(String(args.documentId), args as never),
});

tool({
  name: "document_insert_hyperlink",
  title: "Insert hyperlink",
  category: "editing",
  mutating: true,
  description:
    "Attaches an external URL or an internal bookmark anchor to a text range.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema,
    href: z.string().url().optional(),
    anchor: z.string().optional(),
    tooltip: z.string().max(500).optional(),
  },
  handler: async ({ service }, args) =>
    service.insertHyperlink(String(args.documentId), args as never),
});

tool({
  name: "document_insert_page_break",
  title: "Insert page break",
  category: "editing",
  mutating: true,
  description: "Inserts a page, line or column break at a position.",
  inputSchema: {
    documentId: id(),
    position: positionSchema,
    kind: z.enum(["page", "line", "column"]).optional(),
  },
  handler: async ({ service }, args) =>
    service.insertPageBreak(String(args.documentId), args as never),
});

tool({
  name: "document_insert_section_break",
  title: "Insert section break",
  category: "editing",
  mutating: true,
  description:
    "Splits a section at a block index, optionally switching the new section to landscape.",
  inputSchema: {
    documentId: id(),
    sectionIndex: z.number().int().min(0).optional(),
    blockIndex: z.number().int().min(0).optional(),
    type: z.enum(["nextPage", "continuous", "oddPage", "evenPage"]).optional(),
    landscape: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.insertSectionBreak(String(args.documentId), args as never),
});

tool({
  name: "document_edit_header",
  title: "Edit header",
  category: "editing",
  mutating: true,
  description:
    "Sets a section header variant (default/first/even) to plain text. PAGE/NUMPAGES fields are resolved by the layout engine.",
  inputSchema: {
    documentId: id(),
    sectionIndex: z.number().int().min(0).optional(),
    variant: z.enum(["default", "first", "even"]).optional(),
    text: z.string().max(4000),
  },
  handler: async ({ service }, args) =>
    service.editHeaderFooter(String(args.documentId), {
      sectionIndex: args.sectionIndex as number | undefined,
      variant: args.variant as never,
      part: "header",
      text: String(args.text),
    }),
});

tool({
  name: "document_edit_footer",
  title: "Edit footer",
  category: "editing",
  mutating: true,
  description:
    "Sets a section footer variant (default/first/even) to plain text.",
  inputSchema: {
    documentId: id(),
    sectionIndex: z.number().int().min(0).optional(),
    variant: z.enum(["default", "first", "even"]).optional(),
    text: z.string().max(4000),
  },
  handler: async ({ service }, args) =>
    service.editHeaderFooter(String(args.documentId), {
      sectionIndex: args.sectionIndex as number | undefined,
      variant: args.variant as never,
      part: "footer",
      text: String(args.text),
    }),
});

/* --------------------------------------------------------------- advanced */

tool({
  name: "document_add_comment",
  title: "Add comment",
  category: "advanced",
  mutating: true,
  description: "Adds a review comment anchored to a text range.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema,
    text: z.string().min(1).max(8000),
    author: z.string().max(200).optional(),
  },
  handler: async ({ service }, args) =>
    service.addComment(String(args.documentId), args as never),
});

tool({
  name: "document_track_change",
  title: "Track changes",
  category: "advanced",
  mutating: true,
  description:
    "Enables or disables tracked changes. While enabled, edits are recorded as revisions.",
  inputSchema: { documentId: id(), enabled: z.boolean() },
  handler: async ({ service }, args) =>
    service.setTrackChanges(String(args.documentId), args.enabled === true),
});

tool({
  name: "document_accept_change",
  title: "Accept change",
  category: "advanced",
  mutating: true,
  description:
    "Accepts one tracked revision by id, or all revisions when revisionId is omitted.",
  inputSchema: { documentId: id(), revisionId: z.string().optional() },
  handler: async ({ service }, args) =>
    service.acceptChanges(
      String(args.documentId),
      args.revisionId ? String(args.revisionId) : undefined,
    ),
});

tool({
  name: "document_reject_change",
  title: "Reject change",
  category: "advanced",
  mutating: true,
  description:
    "Rejects one tracked revision by id, or all revisions when revisionId is omitted.",
  inputSchema: { documentId: id(), revisionId: z.string().optional() },
  handler: async ({ service }, args) =>
    service.rejectChanges(
      String(args.documentId),
      args.revisionId ? String(args.revisionId) : undefined,
    ),
});

tool({
  name: "document_insert_footnote",
  title: "Insert footnote",
  category: "advanced",
  mutating: true,
  description: "Inserts a footnote or endnote reference with note text.",
  inputSchema: {
    documentId: id(),
    position: positionSchema,
    text: z.string().max(20000),
    type: z.enum(["footnote", "endnote"]).optional(),
  },
  handler: async ({ service }, args) =>
    service.addFootnote(String(args.documentId), args as never),
});

tool({
  name: "document_insert_toc",
  title: "Insert table of contents",
  category: "advanced",
  mutating: true,
  description:
    "Inserts a generated table of contents. Page numbers are computed by the layout engine and refreshed on save/export.",
  inputSchema: {
    documentId: id(),
    afterBlockId: z.string().optional(),
    minLevel: z.number().int().min(1).max(9).optional(),
    maxLevel: z.number().int().min(1).max(9).optional(),
    includeTitle: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.insertToc(String(args.documentId), args as never),
});

tool({
  name: "document_insert_equation",
  title: "Insert equation",
  category: "advanced",
  mutating: true,
  description:
    "Inserts an equation from a TeX-like linear string (\\\\frac{}{}, ^, _, \\\\sqrt{}, Greek letters and common symbols). Structured math nodes are rendered and exported as OMML.",
  inputSchema: {
    documentId: id(),
    position: positionSchema,
    linear: z.string().min(1).max(4000),
    display: z.boolean().optional(),
  },
  handler: async ({ service }, args) =>
    service.insertEquation(String(args.documentId), args as never),
});

tool({
  name: "document_compare",
  title: "Compare documents",
  category: "advanced",
  description:
    "Compares two open documents, returning paragraph-level changes with word diffs, metadata and style changes.",
  inputSchema: { documentId: id(), otherDocumentId: id() },
  handler: async ({ service }, args) =>
    service.compareDocuments(
      String(args.documentId),
      String(args.otherDocumentId),
    ),
});

tool({
  name: "document_get_revision_history",
  title: "Get revision history",
  category: "advanced",
  description:
    "Returns the in-session edit history (newest first) with entry ids usable for restore via the service API.",
  inputSchema: { documentId: id() },
  handler: async ({ service }, args) => ({
    history: service.revisionHistory(String(args.documentId)),
    pendingTrackedChanges: service.revisionSummary(String(args.documentId)),
  }),
});

tool({
  name: "document_undo",
  title: "Undo",
  category: "advanced",
  mutating: true,
  description:
    "Reverts the last document mutation using the session snapshot history.",
  inputSchema: { documentId: id() },
  handler: async ({ service }, args) => service.undo(String(args.documentId)),
});

tool({
  name: "document_redo",
  title: "Redo",
  category: "advanced",
  mutating: true,
  description: "Reapplies the most recently undone mutation.",
  inputSchema: { documentId: id() },
  handler: async ({ service }, args) => service.redo(String(args.documentId)),
});

/* -------------------------------------------------------------- conversion */

tool({
  name: "document_convert",
  title: "Convert document",
  category: "conversion",
  mutating: true,
  description:
    "Converts an open document (or a file path) to another format through the conversion engine. Returns the bytes as base64 or writes them to a workspace path, plus a loss report.",
  inputSchema: {
    documentId: z.string().optional(),
    path: z.string().optional(),
    to: z
      .string()
      .min(1)
      .describe("Target format: docx, odt, rtf, html, md, txt, pdf"),
    outputPath: z.string().optional(),
  },
  handler: async ({ service }, args) => service.convert(args as never),
});

tool({
  name: "document_export_pdf",
  title: "Export PDF",
  category: "conversion",
  mutating: true,
  description:
    "Renders the document to PDF with the layout engine and returns the page count.",
  inputSchema: { documentId: id(), outputPath: z.string().optional() },
  handler: async ({ service }, args) =>
    service.exportPdf(
      String(args.documentId),
      args.outputPath ? String(args.outputPath) : undefined,
    ),
});

tool({
  name: "document_import",
  title: "Import document",
  category: "conversion",
  mutating: true,
  description:
    "Imports a file through the format adapters and opens it as a document.",
  inputSchema: { path: z.string().min(1) },
  handler: async ({ service }, args) =>
    service.importDocument(String(args.path)),
});

tool({
  name: "document_export",
  title: "Export document",
  category: "conversion",
  mutating: true,
  description:
    "Exports the document to a named format (docx, dotx, docm, pdf, html, md, txt, odt, rtf) as base64 or a workspace path.",
  inputSchema: {
    documentId: id(),
    format: z.string().min(1),
    outputPath: z.string().optional(),
  },
  handler: async ({ service }, args) =>
    service.exportDocument(
      String(args.documentId),
      String(args.format),
      args.outputPath ? String(args.outputPath) : undefined,
    ),
});

tool({
  name: "document_engine_status",
  title: "External engine status",
  category: "conversion",
  description:
    "Reports whether the optional LibreOffice engine is installed and usable, alongside the internal engine capability matrix. When LibreOffice is absent the result is available:false with the detection evidence and reason; it never claims a converter that does not exist.",
  inputSchema: {},
  handler: async ({ service }) => service.engineStatus(),
});

tool({
  name: "document_convert_external",
  title: "Convert with LibreOffice",
  category: "conversion",
  mutating: true,
  description:
    "Converts a document through an installed LibreOffice binary (docx, odt, rtf, txt, html, pdf). Reports ENGINE_UNAVAILABLE with detection evidence when LibreOffice is not installed. An output path must stay inside the workspace and is refused in read-only mode.",
  inputSchema: {
    inputPath: z
      .string()
      .min(1)
      .max(4096)
      .describe("Absolute path of an existing document to convert"),
    format: z
      .string()
      .min(1)
      .max(160)
      .describe(
        "Target format: docx, odt, rtf, txt, html, pdf, or ext:Filter Name",
      ),
    outputPath: z
      .string()
      .max(4096)
      .optional()
      .describe("Optional workspace path for the converted file"),
    timeoutMs: z.number().int().min(50).max(600000).optional(),
  },
  handler: async ({ service }, args) =>
    service.convertWithExternalEngine({
      inputPath: String(args.inputPath ?? ""),
      format: String(args.format ?? ""),
      ...(args.outputPath === undefined
        ? {}
        : { outputPath: String(args.outputPath) }),
      ...(args.timeoutMs === undefined
        ? {}
        : { timeoutMs: Number(args.timeoutMs) }),
    }),
});

/* --------------------------------------------------------------------- AI */

tool({
  name: "document_ai_summarize",
  title: "AI summarize",
  category: "ai",
  requiresAi: true,
  description:
    "Summarises the document or a range. Deterministic extractive summarisation works without a provider; abstractive styles require a configured LLM provider.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema.optional(),
    style: z.enum(["paragraph", "bullet", "executive"]).optional(),
    maxSentences: z.number().int().min(1).max(40).optional(),
  },
  handler: async ({ service }, args) => service.ai("summarize", args as never),
});

tool({
  name: "document_ai_rewrite",
  title: "AI rewrite",
  category: "ai",
  requiresAi: true,
  description:
    "Proposes a rewrite of a range (tone/quality instruction). Returns before/after and a structured replace operation; it never applies changes itself.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema,
    instruction: z.string().max(2000).optional(),
    tone: z.string().max(200).optional(),
    mode: z.enum(["ask", "suggest", "edit"]).optional(),
  },
  handler: async ({ service }, args) => service.ai("rewrite", args as never),
});

tool({
  name: "document_ai_translate",
  title: "AI translate",
  category: "ai",
  requiresAi: true,
  description:
    "Proposes a translation of a range into a target language as a structured replace operation.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema,
    targetLanguage: z.string().min(2).max(80),
    mode: z.enum(["ask", "suggest", "edit"]).optional(),
  },
  handler: async ({ service }, args) => service.ai("translate", args as never),
});

tool({
  name: "document_ai_review",
  title: "AI review",
  category: "ai",
  description:
    "Reviews the document or a range for mechanical issues (repeated words, double spaces, inconsistent date formats, very long sentences, common misspellings). Works without a provider.",
  inputSchema: {
    documentId: id(),
    range: rangeSchema.optional(),
    checks: z
      .array(
        z.enum([
          "spelling",
          "grammar",
          "consistency",
          "dates",
          "readability",
          "missingSpaces",
        ]),
      )
      .optional(),
  },
  handler: async ({ service }, args) => service.ai("review", args as never),
});

tool({
  name: "document_ai_generate_content",
  title: "AI generate content",
  category: "ai",
  requiresAi: true,
  description:
    "Generates new content from a prompt and returns an insert operation. Requires a configured LLM provider.",
  inputSchema: {
    documentId: id(),
    prompt: z.string().min(1).max(8000),
    afterBlockId: z.string().optional(),
    mode: z.enum(["suggest", "edit"]).optional(),
  },
  handler: async ({ service }, args) =>
    service.ai("generate_content", args as never),
});

tool({
  name: "document_ai_suggest_edits",
  title: "AI suggest edits",
  category: "ai",
  requiresAi: true,
  description:
    "Asks the provider for a bounded set of structured editing operations for a prompt. Returns the operations and their before/after previews; nothing is applied.",
  inputSchema: {
    documentId: id(),
    prompt: z.string().min(1).max(8000),
    range: rangeSchema.optional(),
    maxOperations: z.number().int().min(1).max(20).optional(),
  },
  handler: async ({ service }, args) =>
    service.ai("suggest_edits", args as never),
});

/* ---------------------------------------------------------------- public */

export function listTools(): ToolDescriptor[] {
  return [...tools];
}

export function getTool(name: string): ToolDescriptor | undefined {
  return tools.find((entry) => entry.name === name);
}

export async function invokeTool(
  service: DocumentService,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolInvocationResult> {
  const descriptor = getTool(name);
  if (!descriptor) {
    return {
      ok: false,
      error: { code: "TOOL_NOT_FOUND", message: `Unknown tool: ${name}` },
    };
  }
  try {
    const data = await descriptor.handler({ service }, args);
    if (
      data &&
      typeof data === "object" &&
      "ok" in (data as Record<string, unknown>) &&
      (data as { ok: unknown }).ok === false
    ) {
      return data as ToolInvocationResult;
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ServiceError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: "TOOL_EXECUTION_FAILED", message } };
  }
}

export interface McpToolManifestEntry {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  mutating: boolean;
  requiresAi: boolean;
  inputSchema: Record<string, unknown>;
}

/** JSON Schema manifest (used by the CI schema validator and agent tool defs). */
export function buildToolManifest(): {
  tools: McpToolManifestEntry[];
  generatedAt: string;
  count: number;
} {
  return {
    generatedAt: "static",
    count: tools.length,
    tools: tools.map((entry) => ({
      name: entry.name,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      mutating: entry.mutating === true,
      requiresAi: entry.requiresAi === true,
      inputSchema: zodToJsonSchema(z.object(entry.inputSchema), {
        target: "jsonSchema7",
        $refStrategy: "none",
      }) as Record<string, unknown>,
    })),
  };
}
