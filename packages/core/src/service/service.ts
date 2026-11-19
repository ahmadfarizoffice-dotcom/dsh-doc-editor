/**
 * Unified document service. The web UI, MCP server, native agent tools and the
 * CLI all call these methods, so business logic exists exactly once.
 */
import path from "node:path";
import type {
  Block,
  DocDocument,
  DocRange,
  DocumentStats,
  OutlineEntry,
  ParagraphProps,
  RunProps,
  SearchMatch,
  Section,
  Table,
  TextPosition,
} from "../model/types.js";
import {
  appendParagraph,
  applyHyperlink,
  applyList,
  applyStyle,
  addMedia,
  clearFormatting,
  deleteRange,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  findCellById,
  formatParagraphs,
  formatRange,
  insertEquation,
  insertImage,
  insertLineBreak,
  insertPageBreak,
  insertParagraph,
  insertSectionBreak,
  insertTable,
  insertTableColumn,
  insertTableRow,
  insertText,
  insertToc,
  insertFootnote,
  mergeCells,
  removeList,
  setColumns,
  setHeaderFooter,
  setListNumbering,
  setMetadata,
  setPageSetup,
  splitCell,
} from "../model/edit.js";
import {
  acceptAllChanges,
  addComment,
  rejectAllChanges,
  resolveRevision,
  setTrackChanges,
} from "../model/review.js";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import * as formatRegistry from "../formats/index.js";
import * as convertEngine from "../convert/index.js";
import * as aiAssistant from "../ai/index.js";
import { resolveParagraphProps } from "../model/styles.js";
import { computeNumbering } from "../model/numbering.js";
import {
  documentOutline,
  searchDocument,
  textOffsetToPosition,
} from "../model/query.js";
import { DocumentHistory } from "../model/history.js";
import { compareDocuments, type DocumentComparison } from "../model/compare.js";
import {
  documentStats,
  documentText,
  paragraphText,
  type TextMode,
} from "../model/text.js";
import { createDocument } from "../model/create.js";
import {
  documentFeatureInventory,
  validateDocument,
} from "../model/validate.js";
import { listBlocks, findParagraph, findBlock } from "../model/access.js";
import { layoutDocument, pageInfoForBlock } from "../layout/index.js";
import type { LayoutResult, PageInfo } from "../layout/types.js";
import { exportDocx } from "../docx/export.js";
import { importDocx } from "../docx/import.js";
import type { CompatibilityReport } from "../model/types.js";
import { ServiceError, Workspace, type DocumentRecord } from "./workspace.js";

export interface Session {
  id: string;
  document: DocDocument;
  history: DocumentHistory;
  dirty: boolean;
  sourceFormat: string;
  filePath?: string;
  createdAt: string;
  revision: number;
  layoutCache?: { revision: number; result: LayoutResult };
}

export interface ServiceOptions {
  workspaceRoot?: string;
  allowedReadRoots?: string[];
  readOnly?: boolean;
  auditPath?: string;
  /** Maximum bytes accepted for imports. */
  maxImportBytes?: number;
}

export interface PositionInput {
  blockId: string;
  inlineIndex?: number;
  offset?: number;
}

export interface RangeInput {
  start: PositionInput;
  end: PositionInput;
}

export interface CreatedDocument {
  documentId: string;
  document: DocDocument;
}

export class DocumentService {
  readonly workspace: Workspace;
  private readonly sessions = new Map<string, Session>();
  private readonly maxImportBytes: number;

  constructor(options: ServiceOptions = {}) {
    const root =
      options.workspaceRoot ??
      process.env.DSH_DOC_WORKSPACE ??
      path.join(process.cwd(), ".dsh-doc-data");
    const allowed =
      options.allowedReadRoots ??
      (process.env.DSH_DOC_ALLOWED_ROOTS
        ? process.env.DSH_DOC_ALLOWED_ROOTS.split(path.delimiter).filter(
            Boolean,
          )
        : [process.cwd()]);
    this.workspace = new Workspace({
      root,
      allowedReadRoots: allowed,
      readOnly: options.readOnly ?? process.env.DSH_DOC_READ_ONLY === "1",
      auditPath: options.auditPath ?? process.env.DSH_DOC_AUDIT_LOG,
    });
    this.maxImportBytes =
      options.maxImportBytes ??
      Number(process.env.DSH_DOC_MAX_IMPORT_MB ?? "256") * 1024 * 1024;
  }

  async init(): Promise<void> {
    await this.workspace.init();
  }

  /* ------------------------------------------------------------ sessions */

  session(documentId: string): Session {
    const session = this.sessions.get(documentId);
    if (!session) {
      throw new ServiceError(
        "DOCUMENT_NOT_OPEN",
        `Document is not open: ${documentId}`,
        {
          openDocuments: [...this.sessions.keys()],
        },
      );
    }
    return session;
  }

  sessions_(): Session[] {
    return [...this.sessions.values()];
  }

  private register(
    id: string,
    document: DocDocument,
    sourceFormat: string,
    filePath?: string,
  ): Session {
    const session: Session = {
      id,
      document,
      history: new DocumentHistory(document),
      dirty: false,
      sourceFormat,
      filePath,
      createdAt: new Date().toISOString(),
      revision: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  private touch(session: Session, label: string): void {
    session.dirty = true;
    session.revision += 1;
    session.layoutCache = undefined;
    session.document.metadata.modified = new Date().toISOString();
    session.history.push(session.document, label);
  }

  /* ------------------------------------------------------------ lifecycle */

  async createDocument(input: {
    title?: string;
    author?: string;
    pageSize?: string;
    landscape?: boolean;
    paragraphs?: string[];
    language?: string;
  }): Promise<CreatedDocument> {
    this.workspace.assertWritable();
    const document = createDocument({
      title: input.title,
      author: input.author,
      pageSize: input.paragraphs ? undefined : (input.pageSize as never),
      landscape: input.landscape,
      paragraphs: input.paragraphs,
      language: input.language,
    });
    const id = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const session = this.register(id, document, "json");
    const docx = await exportDocx(document, { preserveTimestamps: true });
    await this.workspace.saveDocument(id, document, docx.buffer, {
      title: document.metadata.title ?? "Untitled document",
      createdAt: document.metadata.created ?? new Date().toISOString(),
      sourceFormat: "json",
      wordCount: countWords(documentText(document)),
      pageCount: layoutDocument(document).pageCount,
    });
    await this.workspace.audit({
      action: "document_create",
      documentId: id,
      outcome: "ok",
    });
    this.touch(session, "Create document");
    return { documentId: id, document };
  }

  async openDocument(filePath: string): Promise<{
    documentId: string;
    document: DocDocument;
    compatibility?: CompatibilityReport;
  }> {
    const bytes = await this.workspace.readExternal(filePath);
    if (bytes.byteLength > this.maxMaxImport()) {
      throw new ServiceError(
        "FILE_TOO_LARGE",
        "Document exceeds the configured import limit",
      );
    }
    const fileName = path.basename(filePath);
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (["docx", "dotx", "docm"].includes(extension)) {
      const imported = await importDocx(bytes, { fileName });
      const id = this.slugForPath(filePath);
      this.register(id, imported.document, extension, path.resolve(filePath));
      await this.workspace.audit({
        action: "document_open",
        documentId: id,
        outcome: "ok",
        detail: { bytes: bytes.byteLength },
      });
      return {
        documentId: id,
        document: imported.document,
        compatibility: imported.report,
      };
    }
    const formats = await this.tryFormats();
    if (!formats) {
      throw new ServiceError(
        "FORMAT_UNAVAILABLE",
        `No importer is available for .${extension}`,
      );
    }
    const result = await formats.importAny(bytes, fileName);
    const id = this.slugForPath(filePath);
    this.register(id, result.document, extension, path.resolve(filePath));
    await this.workspace.audit({
      action: "document_open",
      documentId: id,
      outcome: "ok",
      detail: { bytes: bytes.byteLength, format: extension },
    });
    return {
      documentId: id,
      document: result.document,
      compatibility: result.document.compatibility,
    };
  }

  async importDocument(
    filePath: string,
    format?: string,
  ): Promise<{
    documentId: string;
    document: DocDocument;
    warnings: string[];
  }> {
    const opened = await this.openDocument(filePath);
    return {
      documentId: opened.documentId,
      document: opened.document,
      warnings: [],
    };
  }

  private maxMaxImport(): number {
    return this.maxImportBytes;
  }

  private slugForPath(filePath: string): string {
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const slug =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "document";
    return `${slug}-${Date.now().toString(36)}`.slice(0, 64);
  }

  async saveDocument(
    documentId: string,
    filePath?: string,
  ): Promise<{ path: string; savedAt: string; bytes: number }> {
    this.workspace.assertWritable();
    const session = this.session(documentId);
    const target = filePath
      ? this.workspace.resolveWritePath(filePath)
      : this.workspace.documentDir(documentId);
    const exported = await exportDocx(session.document, {
      preserveTimestamps: false,
    });
    const layout = this.layout(session);
    if (filePath) {
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, exported.buffer);
    }
    await this.workspace.saveDocument(
      documentId,
      session.document,
      exported.buffer,
      {
        title: session.document.metadata.title ?? "Untitled document",
        createdAt: session.document.metadata.created ?? session.createdAt,
        sourceFormat: "docx",
        wordCount: countWords(documentText(session.document)),
        pageCount: layout.pageCount,
      },
    );
    session.dirty = false;
    const savedAt = new Date().toISOString();
    await this.workspace.audit({
      action: "document_save",
      documentId,
      outcome: "ok",
      detail: { bytes: exported.buffer.byteLength },
    });
    return {
      path: filePath
        ? target
        : path.join(this.workspace.documentDir(documentId), "document.docx"),
      savedAt,
      bytes: exported.buffer.byteLength,
    };
  }

  async saveDocumentAs(
    documentId: string,
    filePath: string,
  ): Promise<{ path: string; savedAt: string; bytes: number }> {
    const target = this.workspace.resolveWritePath(filePath);
    const session = this.session(documentId);
    const extension = path.extname(target).slice(1).toLowerCase();
    if (extension === "docx" || extension === "dotx" || extension === "docm") {
      return this.saveDocument(documentId, target);
    }
    const formats = await this.tryFormats();
    if (!formats)
      throw new ServiceError(
        "FORMAT_UNAVAILABLE",
        `No exporter is available for .${extension}`,
      );
    const result = await formats.exportAny(session.document, extension);
    await fsMkdir(path.dirname(target), { recursive: true });
    await fsWriteFile(target, result.buffer);
    await this.workspace.audit({
      action: "document_save_as",
      documentId,
      outcome: "ok",
      detail: { format: extension },
    });
    return {
      path: target,
      savedAt: new Date().toISOString(),
      bytes: result.buffer.byteLength,
    };
  }

  async closeDocument(
    documentId: string,
    options: { discardUnsaved?: boolean } = {},
  ): Promise<{ closed: boolean; discardedChanges: boolean }> {
    const session = this.session(documentId);
    if (session.dirty && !options.discardUnsaved) {
      throw new ServiceError(
        "UNSAVED_CHANGES",
        "Document has unsaved changes; save it or pass discardUnsaved",
        {
          dirty: true,
        },
      );
    }
    this.sessions.delete(documentId);
    await this.workspace.audit({
      action: "document_close",
      documentId,
      outcome: "ok",
    });
    return { closed: true, discardedChanges: session.dirty };
  }

  /** Restores a persisted document into an editing session. */
  async reopenDocument(
    documentId: string,
  ): Promise<{ documentId: string; document: DocDocument }> {
    const existing = this.sessions.get(documentId);
    if (existing) return { documentId, document: existing.document };
    const model = await this.workspace.loadModel(documentId);
    if (model) {
      this.register(documentId, model, "json");
      return { documentId, document: model };
    }
    const docx = await this.workspace.loadDocx(documentId);
    if (!docx)
      throw new ServiceError(
        "DOCUMENT_NOT_FOUND",
        `No stored document ${documentId}`,
      );
    const imported = await importDocx(docx, { fileName: `${documentId}.docx` });
    this.register(documentId, imported.document, "docx");
    return { documentId, document: imported.document };
  }

  async deleteDocument(documentId: string): Promise<{ deleted: boolean }> {
    this.workspace.assertWritable();
    await this.workspace.deleteDocument(documentId);
    this.sessions.delete(documentId);
    await this.workspace.audit({
      action: "document_delete",
      documentId,
      outcome: "ok",
    });
    return { deleted: true };
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    return this.workspace.list();
  }

  metadata(documentId: string): {
    metadata: DocDocument["metadata"];
    stats: DocumentStats;
    compatibility?: CompatibilityReport;
    warnings: string[];
  } {
    const session = this.session(documentId);
    const layout = this.layout(session);
    return {
      metadata: session.document.metadata,
      stats: documentStats(session.document, "final", layout.pageCount),
      compatibility: session.document.compatibility,
      warnings: layout.warnings.map((warning) => warning.message),
    };
  }

  /* -------------------------------------------------------------- reading */

  getText(
    documentId: string,
    options: { mode?: TextMode; from?: string; to?: string } = {},
  ): { text: string; characters: number; words: number } {
    const session = this.session(documentId);
    let text = documentText(session.document, {
      mode: options.mode ?? "final",
    });
    const fromBlock = options.from
      ? this.blockIndex(session.document, options.from)
      : -1;
    const toBlock = options.to
      ? this.blockIndex(session.document, options.to)
      : -1;
    if (fromBlock >= 0 && toBlock >= 0) {
      const paragraphs = listBlocks(session.document);
      const slice = paragraphs.slice(
        Math.min(fromBlock, toBlock),
        Math.max(fromBlock, toBlock) + 1,
      );
      text = slice
        .map((entry) =>
          entry.block.type === "paragraph" ? paragraphText(entry.block) : "",
        )
        .join("\n");
    }
    return { text, characters: text.length, words: countWords(text) };
  }

  private blockIndex(doc: DocDocument, blockId: string): number {
    return listBlocks(doc).findIndex((entry) => entry.block.id === blockId);
  }

  getOutline(
    documentId: string,
    options: { maxLevel?: number; includeTitle?: boolean } = {},
  ): OutlineEntry[] {
    const session = this.session(documentId);
    return documentOutline(session.document, {
      maxLevel: options.maxLevel ?? 9,
      includeTitle: options.includeTitle ?? true,
    }).map((entry) => ({ ...entry, id: entry.blockId }));
  }

  getContent(
    documentId: string,
    options: { mode?: TextMode; includeTables?: boolean; limit?: number } = {},
  ): unknown {
    const session = this.session(documentId);
    const limit = Math.max(1, Math.min(5000, options.limit ?? 5000));
    let count = 0;
    const sections = session.document.sections.map((section, sectionIndex) => ({
      index: sectionIndex,
      page: {
        width: section.page.width,
        height: section.page.height,
        orientation: section.page.orientation,
        margins: section.page.margins,
      },
      columns: section.columns,
      blocks: [] as Array<Record<string, unknown>>,
    }));
    for (const entry of listBlocks(session.document)) {
      if (count >= limit) break;
      const section = sections[entry.sectionIndex];
      if (!section) continue;
      const block = entry.block;
      // Shape/text-box content is reported separately from body blocks.
      if (
        session.document.shapes.some(
          (shape) =>
            shape.kind === "textbox" &&
            shape.blocks.some((child) => child.id === block.id),
        )
      ) {
        continue;
      }
      if (block.type === "paragraph") {
        section.blocks.push({
          id: block.id,
          type: "paragraph",
          style: block.style,
          text: paragraphText(block, options.mode ?? "final"),
          alignment: resolveParagraphProps(session.document, block).alignment,
          listLabel: computeNumbering(session.document).labels.get(block.id)
            ?.label,
          cellId: entry.cell?.id,
        });
      } else if (block.type === "table") {
        if (options.includeTables === false) continue;
        section.blocks.push({
          id: block.id,
          type: "table",
          rows: block.rows.length,
          columns: block.grid.length,
          headerRows: block.rows.filter((row) => row.props.isHeader).length,
        });
      } else {
        section.blocks.push({
          id: block.id,
          type: "toc",
          minLevel: block.minLevel,
          maxLevel: block.maxLevel,
        });
      }
      count += 1;
    }
    const layout = this.layout(session);
    return {
      sections,
      stats: documentStats(
        session.document,
        options.mode ?? "final",
        layout.pageCount,
      ),
      pageCount: layout.pageCount,
      truncated: count >= limit,
    };
  }

  getSelection(
    documentId: string,
    range: RangeInput,
  ): { text: string; blockIds: string[]; range: DocRange } {
    const session = this.session(documentId);
    const resolved = this.resolveRange(session.document, range);
    const startIndex = this.blockIndex(
      session.document,
      resolved.start.blockId,
    );
    const endIndex = this.blockIndex(session.document, resolved.end.blockId);
    const blocks = listBlocks(session.document).slice(
      Math.min(startIndex, endIndex),
      Math.max(startIndex, endIndex) + 1,
    );
    const parts: string[] = [];
    for (const entry of blocks) {
      if (entry.block.type !== "paragraph") continue;
      const text = paragraphText(entry.block, "final");
      if (
        entry.block.id === resolved.start.blockId &&
        entry.block.id === resolved.end.blockId
      ) {
        const from = this.offsetOf(entry.block, resolved.start);
        const to = this.offsetOf(entry.block, resolved.end);
        parts.push(text.slice(Math.min(from, to), Math.max(from, to)));
      } else if (entry.block.id === resolved.start.blockId) {
        parts.push(text.slice(this.offsetOf(entry.block, resolved.start)));
      } else if (entry.block.id === resolved.end.blockId) {
        parts.push(text.slice(0, this.offsetOf(entry.block, resolved.end)));
      } else {
        parts.push(text);
      }
    }
    return {
      text: parts.join("\n"),
      blockIds: blocks.map((entry) => entry.block.id),
      range: resolved,
    };
  }

  getPageInfo(
    documentId: string,
    blockId?: string,
  ): PageInfo & {
    pages: Array<{
      index: number;
      displayNumber: number;
      sectionIndex: number;
      width: number;
      height: number;
      orientation: string;
    }>;
  } {
    const session = this.session(documentId);
    const layout = this.layout(session);
    const target = blockId ?? listBlocks(session.document)[0]?.block.id ?? "";
    const info = pageInfoForBlock(layout, target);
    return {
      ...info,
      pages: layout.pages.map((page) => ({
        index: page.index,
        displayNumber: page.displayNumber,
        sectionIndex: page.sectionIndex,
        width: page.width,
        height: page.height,
        orientation: page.orientation,
      })),
    };
  }

  search(
    documentId: string,
    query: string,
    options: {
      regex?: boolean;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      limit?: number;
      includePages?: boolean;
    } = {},
  ): {
    matches: Array<SearchMatch & { page?: number }>;
    total: number;
  } {
    const session = this.session(documentId);
    const matches = searchDocument(session.document, query, {
      regex: options.regex,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      limit: options.limit ?? 200,
    });
    if (options.includePages) {
      const layout = this.layout(session);
      return {
        matches: matches.map((match) => ({
          ...match,
          page: layout.pageNumberByBlock.get(match.blockId),
        })),
        total: matches.length,
      };
    }
    return { matches, total: matches.length };
  }

  /* -------------------------------------------------------------- editing */

  private resolvePosition(
    doc: DocDocument,
    position: PositionInput,
  ): TextPosition {
    const located = findParagraph(doc, position.blockId);
    if (!located)
      throw new ServiceError(
        "BLOCK_NOT_FOUND",
        `Unknown paragraph: ${position.blockId}`,
      );
    if (position.inlineIndex !== undefined) {
      return {
        blockId: position.blockId,
        inlineIndex: Math.max(0, position.inlineIndex),
        offset: Math.max(0, position.offset ?? 0),
      };
    }
    return textOffsetToPosition(
      located.paragraph,
      Math.max(0, position.offset ?? 0),
    );
  }

  private resolveRange(doc: DocDocument, range: RangeInput): DocRange {
    return {
      start: this.resolvePosition(doc, range.start),
      end: this.resolvePosition(doc, range.end),
    };
  }

  private offsetOf(
    paragraph: import("../model/types.js").Paragraph,
    position: TextPosition,
  ): number {
    let offset = 0;
    for (
      let index = 0;
      index < Math.min(position.inlineIndex, paragraph.inlines.length);
      index += 1
    ) {
      const inline = paragraph.inlines[index];
      if (inline.type === "text") offset += inline.text.length;
      else offset += 1;
    }
    return offset + Math.max(0, position.offset);
  }

  private afterMutation(
    session: Session,
    label: string,
    result: unknown,
    detail?: Record<string, unknown>,
  ): unknown {
    this.touch(session, label);
    void this.workspace.audit({
      action: label,
      documentId: session.id,
      outcome: "ok",
      detail,
    });
    return result;
  }

  insertText(
    documentId: string,
    input: { position: PositionInput; text: string; props?: RunProps },
  ): unknown {
    const session = this.session(documentId);
    const result = insertText(
      session.document,
      this.resolvePosition(session.document, input.position),
      input.text,
      {
        props: input.props,
      },
    );
    return this.afterMutation(session, "document_insert_text", result, {
      characters: input.text.length,
    });
  }

  replaceText(
    documentId: string,
    input: { range: RangeInput; text: string; props?: RunProps },
  ): unknown {
    const session = this.session(documentId);
    const range = this.resolveRange(session.document, input.range);
    const removed = deleteRange(session.document, range);
    const inserted = insertText(session.document, range.start, input.text, {
      props: input.props,
    });
    return this.afterMutation(
      session,
      "document_replace_text",
      { deleted: removed.deletedText.length, inserted },
      {
        removed: removed.deletedText.length,
        inserted: input.text.length,
      },
    );
  }

  deleteRange(documentId: string, input: { range: RangeInput }): unknown {
    const session = this.session(documentId);
    const range = this.resolveRange(session.document, input.range);
    const result = deleteRange(session.document, range);
    return this.afterMutation(session, "document_delete_range", result, {
      removed: result.deletedText.length,
    });
  }

  formatText(
    documentId: string,
    input: { range: RangeInput; props: RunProps; clear?: boolean },
  ): unknown {
    const session = this.session(documentId);
    const range = this.resolveRange(session.document, input.range);
    if (input.clear) clearFormatting(session.document, range);
    const result = formatRange(session.document, range, input.props);
    return this.afterMutation(session, "document_format_text", result);
  }

  formatParagraph(
    documentId: string,
    input: { blockIds: string[]; props: ParagraphProps },
  ): unknown {
    const session = this.session(documentId);
    const result = formatParagraphs(
      session.document,
      input.blockIds,
      input.props,
    );
    return this.afterMutation(session, "document_format_paragraph", result);
  }

  applyStyle(
    documentId: string,
    input: {
      blockIds: string[];
      styleId: string;
      clearDirectFormatting?: boolean;
    },
  ): unknown {
    const session = this.session(documentId);
    const result = applyStyle(session.document, input.blockIds, input.styleId, {
      clearDirectFormatting: input.clearDirectFormatting,
    });
    return this.afterMutation(session, "document_apply_style", result);
  }

  insertHeading(
    documentId: string,
    input: {
      text: string;
      level: number;
      afterBlockId?: string;
      styleId?: string;
    },
  ): unknown {
    const session = this.session(documentId);
    const styleId =
      input.styleId ?? `Heading${Math.max(1, Math.min(9, input.level))}`;
    const anchor = input.afterBlockId ?? this.lastBlockId(session.document);
    const paragraph = insertParagraph(session.document, anchor, input.text, {
      style: styleId,
    });
    return this.afterMutation(session, "document_insert_heading", {
      blockId: paragraph.id,
      styleId,
    });
  }

  insertList(
    documentId: string,
    input: {
      items: string[];
      kind: "bullet" | "number";
      afterBlockId?: string;
      level?: number;
      startAt?: number;
    },
  ): unknown {
    const session = this.session(documentId);
    let anchor = input.afterBlockId ?? this.lastBlockId(session.document);
    const blockIds: string[] = [];
    for (const item of input.items) {
      const paragraph = insertParagraph(session.document, anchor, item, {
        style: input.kind === "bullet" ? "ListBullet" : "ListNumber",
      });
      blockIds.push(paragraph.id);
      anchor = paragraph.id;
    }
    const { numId } = applyList(session.document, blockIds, {
      kind: input.kind,
      level: input.level ?? 0,
      startAt: input.startAt,
    });
    return this.afterMutation(session, "document_insert_list", {
      blockIds,
      numId,
    });
  }

  insertTable(
    documentId: string,
    input: {
      rows: number;
      columns: number;
      data?: string[][];
      style?: string;
      afterBlockId?: string;
      headerRow?: boolean;
    },
  ): unknown {
    const session = this.session(documentId);
    const anchor = input.afterBlockId ?? this.lastBlockId(session.document);
    const table = insertTable(session.document, anchor, {
      rows: input.rows,
      columns: input.columns,
      data: input.data,
      style: input.style,
      headerRow: input.headerRow,
    });
    return this.afterMutation(session, "document_insert_table", {
      tableId: table.id,
      rows: table.rows.length,
      columns: table.grid.length,
    });
  }

  editTable(
    documentId: string,
    input: {
      tableId: string;
      operation: string;
      index?: number;
      region?: {
        startRow: number;
        endRow: number;
        startColumn: number;
        endColumn: number;
      };
      cellId?: string;
    },
  ): unknown {
    const session = this.session(documentId);
    const table = session.document.sections
      .flatMap((section) => section.blocks)
      .find(
        (block): block is Table =>
          block.type === "table" && block.id === input.tableId,
      );
    if (!table)
      throw new ServiceError(
        "TABLE_NOT_FOUND",
        `Unknown table: ${input.tableId}`,
      );
    let result: unknown;
    switch (input.operation) {
      case "insertRow":
        result = {
          rowId: insertTableRow(
            session.document,
            input.tableId,
            input.index ?? table.rows.length,
          ),
        };
        break;
      case "deleteRow":
        result = deleteTableRow(
          session.document,
          input.tableId,
          input.index ?? table.rows.length - 1,
        );
        break;
      case "insertColumn":
        insertTableColumn(
          session.document,
          input.tableId,
          input.index ?? table.grid.length,
        );
        result = { columns: table.grid.length };
        break;
      case "deleteColumn":
        result = deleteTableColumn(
          session.document,
          input.tableId,
          input.index ?? table.grid.length - 1,
        );
        break;
      case "mergeCells":
        if (!input.region)
          throw new ServiceError(
            "INVALID_ARGUMENT",
            "mergeCells requires region",
          );
        result = mergeCells(session.document, input.tableId, input.region);
        break;
      case "splitCell":
        if (!input.cellId)
          throw new ServiceError(
            "INVALID_ARGUMENT",
            "splitCell requires cellId",
          );
        result = splitCell(session.document, input.cellId);
        break;
      case "deleteTable":
        deleteTable(session.document, input.tableId);
        result = { deleted: true };
        break;
      default:
        throw new ServiceError(
          "INVALID_ARGUMENT",
          `Unsupported table operation: ${input.operation}`,
        );
    }
    return this.afterMutation(session, "document_edit_table", result, {
      operation: input.operation,
    });
  }

  async insertImage(
    documentId: string,
    input: {
      position: PositionInput;
      path?: string;
      dataBase64?: string;
      contentType?: string;
      width?: number;
      height?: number;
      alt?: string;
      floating?: boolean;
    },
  ): Promise<unknown> {
    const session = this.session(documentId);
    let data: Buffer;
    let contentType = input.contentType ?? "image/png";
    let naturalWidth: number | undefined;
    let naturalHeight: number | undefined;
    if (input.dataBase64) {
      data = Buffer.from(input.dataBase64, "base64");
    } else if (input.path) {
      data = await this.workspace.readExternal(input.path);
      const extension = input.path.split(".").pop()?.toLowerCase() ?? "png";
      contentType = contentTypeForExtension(extension);
      const size = imageDimensions(data);
      naturalWidth = size?.width;
      naturalHeight = size?.height;
    } else {
      throw new ServiceError(
        "INVALID_ARGUMENT",
        "insert_image requires path or dataBase64",
      );
    }
    const width =
      input.width ?? (naturalWidth ? (naturalWidth * 72) / 96 : 200);
    const height =
      input.height ?? (naturalHeight ? (naturalHeight * 72) / 96 : 150);
    const result = insertImage(
      session.document,
      this.resolvePosition(session.document, input.position),
      {
        data,
        contentType,
        width,
        height,
        alt: input.alt,
        naturalWidthPx: naturalWidth,
        naturalHeightPx: naturalHeight,
        anchor: input.floating
          ? {
              type: "floating",
              wrap: { type: "square" },
              position: {
                horizontal: { align: "left", relativeTo: "column" },
                vertical: { offset: 0, relativeTo: "paragraph" },
              },
            }
          : { type: "inline" },
      },
    );
    return this.afterMutation(session, "document_insert_image", {
      mediaId: result.mediaId,
      width,
      height,
    });
  }

  insertHyperlink(
    documentId: string,
    input: {
      range: RangeInput;
      href?: string;
      anchor?: string;
      tooltip?: string;
    },
  ): unknown {
    const session = this.session(documentId);
    const range = this.resolveRange(session.document, input.range);
    applyHyperlink(session.document, range, {
      href: input.href,
      anchor: input.anchor,
      tooltip: input.tooltip,
    });
    return this.afterMutation(session, "document_insert_hyperlink", {
      href: input.href ?? null,
      anchor: input.anchor ?? null,
    });
  }

  insertPageBreak(
    documentId: string,
    input: { position: PositionInput; kind?: "page" | "line" | "column" },
  ): unknown {
    const session = this.session(documentId);
    const position = this.resolvePosition(session.document, input.position);
    if (input.kind === "line") insertLineBreak(session.document, position);
    else insertPageBreak(session.document, position);
    return this.afterMutation(session, "document_insert_page_break", {
      kind: input.kind ?? "page",
    });
  }

  insertSectionBreak(
    documentId: string,
    input: {
      sectionIndex?: number;
      blockIndex?: number;
      type?: Section["breakBefore"];
      landscape?: boolean;
      pageSize?: string;
    },
  ): unknown {
    const session = this.session(documentId);
    const sectionIndex =
      input.sectionIndex ?? session.document.sections.length - 1;
    const section = session.document.sections[sectionIndex];
    if (!section)
      throw new ServiceError(
        "SECTION_NOT_FOUND",
        `Unknown section ${sectionIndex}`,
      );
    const blockIndex = input.blockIndex ?? section.blocks.length;
    const page =
      input.landscape !== undefined
        ? ({
            orientation: input.landscape ? "landscape" : "portrait",
          } as Partial<Section["page"]>)
        : undefined;
    const result = insertSectionBreak(
      session.document,
      { sectionIndex, blockIndex },
      { type: input.type ?? "nextPage", page },
    );
    if (input.landscape !== undefined) {
      session.document.sections[result.sectionIndex].page.orientation =
        input.landscape ? "landscape" : "portrait";
    }
    return this.afterMutation(session, "document_insert_section_break", result);
  }

  editHeaderFooter(
    documentId: string,
    input: {
      sectionIndex?: number;
      part: "header" | "footer";
      variant?: "default" | "first" | "even";
      text?: string;
      blocks?: Block[];
    },
  ): unknown {
    const session = this.session(documentId);
    const result = setHeaderFooter(session.document, input.sectionIndex ?? 0, {
      part: input.part,
      variant: input.variant ?? "default",
      text: input.text,
      blocks: input.blocks,
    });
    return this.afterMutation(
      session,
      input.part === "header" ? "document_edit_header" : "document_edit_footer",
      result,
    );
  }

  setPageLayout(
    documentId: string,
    input: {
      sectionIndex?: number;
      page?: Partial<Section["page"]> & { pageSize?: string };
      columns?: Section["columns"];
      pageNumbers?: { start?: number; format?: string };
    },
  ): unknown {
    const session = this.session(documentId);
    const sectionIndex = input.sectionIndex ?? 0;
    if (input.page) setPageSetup(session.document, sectionIndex, input.page);
    if (input.columns)
      setColumns(session.document, sectionIndex, input.columns);
    if (input.pageNumbers) {
      const section = session.document.sections[sectionIndex];
      if (section)
        section.pageNumbering = {
          ...(section.pageNumbering ?? {}),
          ...input.pageNumbers,
        };
    }
    return this.afterMutation(session, "document_layout", { sectionIndex });
  }

  /* ------------------------------------------------------------- review */

  addComment(
    documentId: string,
    input: { range: RangeInput; text: string; author?: string },
  ): unknown {
    const session = this.session(documentId);
    const range = this.resolveRange(session.document, input.range);
    const result = addComment(session.document, range, {
      text: input.text,
      author: input.author,
    });
    return this.afterMutation(session, "document_add_comment", result);
  }

  setTrackChanges(documentId: string, enabled: boolean): unknown {
    const session = this.session(documentId);
    setTrackChanges(session.document, enabled);
    return this.afterMutation(session, "document_track_change", { enabled });
  }

  acceptChanges(documentId: string, revisionId?: string): unknown {
    const session = this.session(documentId);
    const result = revisionId
      ? resolveRevision(session.document, revisionId, "accept")
      : acceptAllChanges(session.document);
    return this.afterMutation(session, "document_accept_change", result);
  }

  rejectChanges(documentId: string, revisionId?: string): unknown {
    const session = this.session(documentId);
    const result = revisionId
      ? resolveRevision(session.document, revisionId, "reject")
      : rejectAllChanges(session.document);
    return this.afterMutation(session, "document_reject_change", result);
  }

  addFootnote(
    documentId: string,
    input: {
      position: PositionInput;
      text: string;
      type?: "footnote" | "endnote";
    },
  ): unknown {
    const session = this.session(documentId);
    const result = insertFootnote(
      session.document,
      this.resolvePosition(session.document, input.position),
      input.text,
      {
        type: input.type,
      },
    );
    return this.afterMutation(session, "document_insert_footnote", result);
  }

  insertToc(
    documentId: string,
    input: {
      afterBlockId?: string;
      minLevel?: number;
      maxLevel?: number;
      includeTitle?: boolean;
    },
  ): unknown {
    const session = this.session(documentId);
    const anchor = input.afterBlockId ?? this.lastBlockId(session.document);
    const result = insertToc(session.document, anchor, {
      minLevel: input.minLevel,
      maxLevel: input.maxLevel,
      includeTitle: input.includeTitle,
    });
    return this.afterMutation(session, "document_insert_toc", result);
  }

  insertEquation(
    documentId: string,
    input: { position: PositionInput; linear: string; display?: boolean },
  ): unknown {
    const session = this.session(documentId);
    const result = insertEquation(
      session.document,
      this.resolvePosition(session.document, input.position),
      {
        linear: input.linear,
        display: input.display,
      },
    );
    return this.afterMutation(session, "document_insert_equation", result);
  }

  async compareDocuments(
    documentId: string,
    otherDocumentId: string,
  ): Promise<DocumentComparison> {
    const left = this.session(documentId);
    const right = this.session(otherDocumentId);
    const report = compareDocuments(left.document, right.document);
    await this.workspace.audit({
      action: "document_compare",
      documentId,
      outcome: "ok",
      detail: { otherDocumentId },
    });
    return report;
  }

  revisionHistory(
    documentId: string,
  ): Array<{ id: number; label: string; timestamp: string }> {
    return this.session(documentId).history.list();
  }

  revisionSummary(documentId: string): {
    inserted: number;
    deleted: number;
    formatted: number;
    pending: number;
  } {
    const session = this.session(documentId);
    let inserted = 0;
    let deleted = 0;
    let formatted = 0;
    for (const entry of listBlocks(session.document)) {
      if (entry.block.type !== "paragraph") continue;
      for (const inline of entry.block.inlines) {
        if (inline.type !== "text") continue;
        if (inline.props.revision?.kind === "insert") inserted += 1;
        else if (inline.props.revision?.kind === "delete") deleted += 1;
        else if (inline.props.revision?.kind === "format") formatted += 1;
      }
    }
    return {
      inserted,
      deleted,
      formatted,
      pending: inserted + deleted + formatted,
    };
  }

  undo(documentId: string): unknown {
    const session = this.session(documentId);
    const entry = session.history.undo();
    if (!entry)
      throw new ServiceError("NOTHING_TO_UNDO", "No undo history remains");
    session.document = entry.document;
    session.revision += 1;
    session.layoutCache = undefined;
    session.dirty = true;
    return { label: entry.label, revision: session.revision };
  }

  redo(documentId: string): unknown {
    const session = this.session(documentId);
    const entry = session.history.redo();
    if (!entry)
      throw new ServiceError("NOTHING_TO_REDO", "No redo history remains");
    session.document = entry.document;
    session.revision += 1;
    session.layoutCache = undefined;
    session.dirty = true;
    return { label: entry.label, revision: session.revision };
  }

  restoreRevision(documentId: string, historyId: number): unknown {
    const session = this.session(documentId);
    const entry = session.history.restore(historyId);
    if (!entry)
      throw new ServiceError(
        "REVISION_NOT_FOUND",
        `Unknown history entry ${historyId}`,
      );
    session.document = entry.document;
    session.revision += 1;
    session.layoutCache = undefined;
    session.dirty = true;
    return { label: entry.label, revision: session.revision };
  }

  /* ---------------------------------------------------------- conversion */

  async convert(input: {
    documentId?: string;
    path?: string;
    to: string;
    outputPath?: string;
  }): Promise<unknown> {
    const convert = await this.tryConvert();
    if (!convert)
      throw new ServiceError(
        "CONVERSION_UNAVAILABLE",
        "Conversion engine is not available",
      );
    let document: DocDocument;
    if (input.documentId) {
      document = this.session(input.documentId).document;
    } else if (input.path) {
      const opened = await this.openDocument(input.path);
      document = opened.document;
    } else {
      throw new ServiceError(
        "INVALID_ARGUMENT",
        "convert requires documentId or path",
      );
    }
    const result = await convert.convert(document, { to: input.to });
    if (input.outputPath) {
      const target = this.workspace.resolveWritePath(input.outputPath);
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, result.buffer);
    }
    await this.workspace.audit({
      action: "document_convert",
      documentId: input.documentId,
      outcome: "ok",
      detail: { to: input.to },
    });
    return {
      format: input.to,
      bytes: result.buffer.byteLength,
      losses: result.losses,
      warnings: result.warnings,
      outputPath: input.outputPath ?? null,
      ...(input.outputPath
        ? {}
        : { dataBase64: result.buffer.toString("base64") }),
    };
  }

  async exportPdf(
    documentId: string,
    outputPath?: string,
  ): Promise<{
    bytes: number;
    pageCount: number;
    path: string | null;
    dataBase64?: string;
  }> {
    const session = this.session(documentId);
    const render = await import("../render/index.js");
    const layout = this.layout(session);
    const buffer = await render.renderPdf(layout, {
      title: session.document.metadata.title,
      author: session.document.metadata.creator,
      images: render.mediaMap(session.document),
    });
    if (outputPath) {
      const target = this.workspace.resolveWritePath(outputPath);
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, buffer);
      await this.workspace.audit({
        action: "document_export_pdf",
        documentId,
        outcome: "ok",
        detail: { bytes: buffer.byteLength },
      });
      return {
        bytes: buffer.byteLength,
        pageCount: layout.pageCount,
        path: target,
      };
    }
    return {
      bytes: buffer.byteLength,
      pageCount: layout.pageCount,
      path: null,
      dataBase64: buffer.toString("base64"),
    };
  }

  async exportDocument(
    documentId: string,
    format: string,
    outputPath?: string,
  ): Promise<unknown> {
    const session = this.session(documentId);
    const normalized = format.toLowerCase().replace(/^\./, "");
    if (
      normalized === "docx" ||
      normalized === "dotx" ||
      normalized === "docm"
    ) {
      const exported = await exportDocx(session.document, {
        flavor: normalized as "docx" | "dotx" | "docm",
      });
      if (outputPath) {
        const target = this.workspace.resolveWritePath(outputPath);
        await fsMkdir(path.dirname(target), { recursive: true });
        await fsWriteFile(target, exported.buffer);
        return {
          format: normalized,
          bytes: exported.buffer.byteLength,
          path: target,
          losses: [],
        };
      }
      return {
        format: normalized,
        bytes: exported.buffer.byteLength,
        path: null,
        dataBase64: exported.buffer.toString("base64"),
        losses: [],
      };
    }
    const formats = await this.tryFormats();
    if (!formats)
      throw new ServiceError(
        "FORMAT_UNAVAILABLE",
        `No exporter available for ${format}`,
      );
    const result = await formats.exportAny(session.document, normalized);
    if (outputPath) {
      const target = this.workspace.resolveWritePath(outputPath);
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, result.buffer);
      return {
        format: normalized,
        bytes: result.buffer.byteLength,
        path: target,
        losses: result.losses ?? [],
      };
    }
    return {
      format: normalized,
      bytes: result.buffer.byteLength,
      path: null,
      dataBase64: result.buffer.toString("base64"),
      losses: result.losses ?? [],
    };
  }

  async listFormats(): Promise<unknown> {
    const formats = await this.tryFormats();
    if (!formats) {
      return {
        import: ["docx", "dotx", "docm"],
        export: ["docx", "dotx", "docm", "pdf"],
        pdfImport: false,
        availability: "core-only",
        note: "Only DOCX and PDF are implemented in this build",
        formats: [],
      };
    }
    const rows = formats.availableFormats();
    const importExtensions = [
      ...new Set(
        rows.filter((row) => row.canImport).flatMap((row) => row.extensions),
      ),
    ];
    // PDF has no adapter: export is rendered from the layout engine.
    const exportExtensions = [
      ...new Set([
        ...rows.filter((row) => row.canExport).flatMap((row) => row.extensions),
        "pdf",
      ]),
    ];
    return {
      import: importExtensions,
      export: exportExtensions,
      pdfImport: false,
      availability: "full",
      formats: rows,
    };
  }

  /* ------------------------------------------------------------------- AI */

  async ai(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const ai = await this.tryAi();
    if (!ai)
      throw new ServiceError(
        "AI_UNAVAILABLE",
        "AI assistant module is not available",
      );
    const sessionId = (input.documentId as string | undefined) ?? "";
    const session = sessionId ? this.session(sessionId) : undefined;
    const result = await ai.runAssistantOperation(operation, {
      ...input,
      document: session?.document,
    });
    await this.workspace.audit({
      action: `document_ai_${operation}`,
      documentId: sessionId,
      outcome: "ok",
    });
    return result;
  }

  /* -------------------------------------------------------------- helpers */

  layout(session: Session): LayoutResult {
    if (
      session.layoutCache &&
      session.layoutCache.revision === session.revision
    ) {
      return session.layoutCache.result;
    }
    const result = layoutDocument(session.document);
    session.layoutCache = { revision: session.revision, result };
    return result;
  }

  lastBlockId(doc: DocDocument): string {
    const lastSection = doc.sections[doc.sections.length - 1];
    const blocks = lastSection?.blocks ?? [];
    const last = blocks[blocks.length - 1];
    if (!last)
      throw new ServiceError("DOCUMENT_EMPTY", "Document has no blocks");
    return last.id;
  }

  validate(documentId: string): ReturnType<typeof validateDocument> {
    const session = this.session(documentId);
    return validateDocument(session.document);
  }

  featureInventory(
    documentId: string,
  ): ReturnType<typeof documentFeatureInventory> {
    return documentFeatureInventory(this.session(documentId).document);
  }

  capabilityReport(documentId: string): {
    compatibility?: CompatibilityReport;
    validation: ReturnType<typeof validateDocument>;
    features: ReturnType<typeof documentFeatureInventory>;
  } {
    const session = this.session(documentId);
    return {
      compatibility: session.document.compatibility,
      validation: validateDocument(session.document),
      features: documentFeatureInventory(session.document),
    };
  }

  /* ------------------------------------------------------- optional deps */

  private async tryFormats(): Promise<typeof formatRegistry> {
    return formatRegistry;
  }

  private async tryConvert(): Promise<{
    convert: (
      doc: DocDocument,
      options: { to: string },
    ) => Promise<{ buffer: Buffer; losses: unknown[]; warnings: string[] }>;
  }> {
    return {
      convert: (doc, options) =>
        convertEngine.convert(doc, {
          from: "model",
          to: options.to,
        }) as Promise<{
          buffer: Buffer;
          losses: unknown[];
          warnings: string[];
        }>,
    };
  }

  private async tryAi(): Promise<typeof aiAssistant> {
    return aiAssistant;
  }
}

/* --------------------------------------------------------------- helpers */

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}\p{M}]+/gu);
  return matches ? matches.length : 0;
}

function contentTypeForExtension(extension: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    webp: "image/webp",
    tiff: "image/tiff",
  };
  return map[extension] ?? "application/octet-stream";
}

/** Reads intrinsic raster dimensions without an image library. */
function imageDimensions(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined;
  if (buffer[0] === 0x89 && buffer[1] === 0x50)
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer[0] === 0x47 && buffer[1] === 0x49)
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

export type { DocDocument };
