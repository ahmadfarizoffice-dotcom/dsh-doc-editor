/**
 * Unified document service. The web UI, MCP server, native agent tools and the
 * CLI all call these methods, so business logic exists exactly once.
 */
import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdir as fsMkdir,
  mkdtemp as fsMkdtemp,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
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
  hasUniqueStructuralIds,
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
  inlineLength as inlineTextLength,
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
import * as formatRegistry from "../formats/index.js";
import type { ConversionLoss } from "../formats/types.js";
import * as convertEngine from "../convert/index.js";
import type { ConversionReport } from "../convert/index.js";
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
import {
  convertWithLibreOffice,
  countPdfPages,
  detectLibreOffice,
  LibreOfficeError,
  LIBREOFFICE_CONVERSION_FORMATS,
  LIBREOFFICE_INSTALL_HINT,
  supportedLibreOfficeFormats,
  type LibreOfficeDetection,
} from "../engine/libreoffice.js";
import {
  adapterFormatFor,
  ENGINE_PREFERENCES,
  ENGINE_PREFERENCE_DEFAULT,
  fallbackReasonForError,
  normalizeEnginePreference,
  normalizeRoutingFormat,
  parseEnginePreference,
  routeAfterFailure,
  routeConversion,
  type ConversionEngineId,
  type EnginePreference,
  type EngineRoute,
  type FallbackReason,
} from "../engine/routing.js";
import { ServiceError, Workspace, type DocumentRecord } from "./workspace.js";

/** Prepended to warnings when a transient failure was retried successfully. */
const LIBREOFFICE_RETRY_WARNING =
  "LibreOffice conversion was retried with an isolated user profile after a transient failure.";

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
  /**
   * Conversion/PDF engine preference. Defaults to `auto` (LibreOffice first,
   * automatic reported fallback to the internal engine). `DSH_DOC_ENGINE`
   * supplies the default when this is omitted; unknown environment values fall
   * back to `auto` while an explicit invalid option throws.
   */
  engine?: EnginePreference;
  /**
   * Verify a save by rendering the stored DOCX through LibreOffice and
   * reporting the PDF page count. Off by default: it roughly doubles save time.
   */
  verifySaveWithLibreOffice?: boolean;
  /**
   * Root for the service's own ephemeral conversion directories (the DOCX
   * intermediate and LibreOffice's output directory). Tests point this at a
   * private directory to assert cleanup; production leaves it undefined and the
   * OS temp directory is used.
   */
  engineTempDirectory?: string;
  /**
   * Timeout for one LibreOffice conversion. Defaults to the adapter's 60 s.
   * A timed-out conversion falls back to the internal engine with
   * `fallbackReason: "timeout"`.
   */
  engineTimeoutMs?: number;
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
  private readonly verifySaveWithLibreOffice: boolean;
  private readonly engineTempDirectory?: string;
  private readonly engineTimeoutMs?: number;
  private enginePreferenceValue: EnginePreference;
  /** The most recent explicit routing decision, for `engineStatus()`. */
  private lastRoute: EngineRoute | null = null;

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
    this.enginePreferenceValue =
      options.engine !== undefined
        ? parseEnginePreference(options.engine)
        : normalizeEnginePreference(
            process.env.DSH_DOC_ENGINE,
            ENGINE_PREFERENCE_DEFAULT,
          );
    this.verifySaveWithLibreOffice = options.verifySaveWithLibreOffice === true;
    this.engineTempDirectory = options.engineTempDirectory;
    this.engineTimeoutMs = options.engineTimeoutMs;
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
  ): Promise<{
    path: string;
    savedAt: string;
    bytes: number;
    /** Engine that wrote the stored DOCX (always the model exporter). */
    engine: "internal";
    enginePreference: EnginePreference;
    /** Only present when `verifySaveWithLibreOffice` is enabled. */
    verification: {
      engine: ConversionEngineId;
      pageCount: number;
      reason: EngineRoute["reason"];
      fallbackReason: FallbackReason | null;
    } | null;
  }> {
    this.workspace.assertWritable();
    const session = this.session(documentId);
    const target = filePath
      ? this.workspace.resolveWritePath(filePath)
      : this.workspace.documentDir(documentId);
    // Snapshot the model so an edit that lands while the DOCX is exported cannot
    // produce a JSON/DOCX pair from two different revisions.
    const snapshot = structuredClone(session.document);
    const revisionAtSave = session.revision;
    const exported = await exportDocx(snapshot, {
      preserveTimestamps: false,
    });
    const layout = layoutDocument(snapshot);
    if (filePath) {
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, exported.buffer);
    }
    // The stored DOCX comes from the model exporter, so model fidelity is kept
    // and the record says so explicitly instead of implying LibreOffice wrote it.
    await this.workspace.saveDocument(documentId, snapshot, exported.buffer, {
      title: snapshot.metadata.title ?? "Untitled document",
      createdAt: snapshot.metadata.created ?? session.createdAt,
      sourceFormat: "docx",
      wordCount: countWords(documentText(snapshot)),
      pageCount: layout.pageCount,
      engine: "internal",
      enginePreference: this.enginePreferenceValue,
    });
    if (session.revision === revisionAtSave) session.dirty = false;
    const savedAt = new Date().toISOString();
    const verification = this.verifySaveWithLibreOffice
      ? await this.verifySavedDocx(exported.buffer, layout.pageCount)
      : null;
    await this.workspace.audit({
      action: "document_save",
      documentId,
      outcome: "ok",
      detail: {
        bytes: exported.buffer.byteLength,
        engine: "internal",
        enginePreference: this.enginePreferenceValue,
        ...(verification
          ? {
              verificationEngine: verification.engine,
              verificationPages: verification.pageCount,
            }
          : {}),
      },
    });
    return {
      path: filePath
        ? target
        : path.join(this.workspace.documentDir(documentId), "document.docx"),
      savedAt,
      bytes: exported.buffer.byteLength,
      engine: "internal",
      enginePreference: this.enginePreferenceValue,
      verification,
    };
  }

  /**
   * Optional, off-by-default save check: render the exact DOCX bytes that were
   * stored through LibreOffice and report the page count. A failure is reported
   * as an internal fallback, never as a failed save.
   */
  private async verifySavedDocx(
    docx: Buffer,
    layoutPageCount: number,
  ): Promise<{
    engine: ConversionEngineId;
    pageCount: number;
    reason: EngineRoute["reason"];
    fallbackReason: FallbackReason | null;
  }> {
    const { available, detection } = await this.routingDetectionFor("pdf");
    const route = routeConversion({
      preference: this.enginePreferenceValue,
      available,
      format: "pdf",
    });
    if (route.engine === "libreoffice" && detection) {
      try {
        const rendered = await this.convertDocxToPdf(docx, detection);
        return {
          engine: "libreoffice",
          pageCount: rendered.pageCount,
          reason: route.reason,
          fallbackReason: null,
        };
      } catch (error) {
        const fallback = routeAfterFailure(
          {
            preference: this.enginePreferenceValue,
            available,
            format: "pdf",
          },
          fallbackReasonForError(error),
        );
        this.lastRoute = fallback;
        return {
          engine: "internal",
          pageCount: layoutPageCount,
          reason: fallback.reason,
          fallbackReason: fallback.fallbackReason,
        };
      }
    }
    this.lastRoute = route;
    return {
      engine: "internal",
      pageCount: layoutPageCount,
      reason: route.reason,
      fallbackReason: route.fallbackReason,
    };
  }

  async saveDocumentAs(
    documentId: string,
    filePath: string,
  ): Promise<{
    path: string;
    savedAt: string;
    bytes: number;
    engine: ConversionEngineId;
    fallbackReason: FallbackReason | null;
  }> {
    // Every route that writes into the workspace is refused in read-only mode.
    this.workspace.assertWritable();
    const target = this.workspace.resolveWritePath(filePath);
    const session = this.session(documentId);
    const extension = path.extname(target).slice(1).toLowerCase();
    if (extension === "docx" || extension === "dotx" || extension === "docm") {
      const saved = await this.saveDocument(documentId, target);
      return {
        path: saved.path,
        savedAt: saved.savedAt,
        bytes: saved.bytes,
        engine: saved.engine,
        fallbackReason: null,
      };
    }
    const outcome = await this.exportThroughEngine(session.document, extension);
    await fsMkdir(path.dirname(target), { recursive: true });
    await fsWriteFile(target, outcome.buffer);
    await this.workspace.audit({
      action: "document_save_as",
      documentId,
      outcome: "ok",
      detail: {
        format: extension,
        engine: outcome.route.engine,
        fallbackReason: outcome.route.fallbackReason,
      },
    });
    return {
      path: target,
      savedAt: new Date().toISOString(),
      bytes: outcome.buffer.byteLength,
      engine: outcome.route.engine,
      fallbackReason: outcome.route.fallbackReason,
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

  /**
   * Validates a caller-supplied position before a mutation or a read.
   *
   * Positions are never silently clamped: a reversed, negative, non-finite or
   * out-of-text position raises a typed `INVALID_RANGE`, so callers cannot end
   * up with a partially applied edit.
   */
  private validatePosition(
    doc: DocDocument,
    position: PositionInput,
  ): TextPosition {
    const located = findParagraph(doc, position.blockId);
    if (!located)
      throw new ServiceError(
        "BLOCK_NOT_FOUND",
        `Unknown paragraph: ${position.blockId}`,
      );
    const paragraph = located.paragraph;
    const inlineIndex = position.inlineIndex;
    if (inlineIndex !== undefined) {
      if (
        !Number.isInteger(inlineIndex) ||
        inlineIndex < 0 ||
        inlineIndex > paragraph.inlines.length
      ) {
        throw new ServiceError(
          "INVALID_RANGE",
          `inlineIndex ${inlineIndex} is out of bounds for paragraph ${position.blockId}`,
        );
      }
    }
    const offset = position.offset ?? 0;
    if (!Number.isFinite(offset) || offset < 0) {
      throw new ServiceError(
        "INVALID_RANGE",
        `offset ${offset} is out of bounds for paragraph ${position.blockId}`,
      );
    }
    if (inlineIndex !== undefined) {
      const inline = paragraph.inlines[inlineIndex];
      const max = inline
        ? inline.type === "text"
          ? inline.text.length
          : 0
        : 0;
      if (offset > max) {
        throw new ServiceError(
          "INVALID_RANGE",
          `offset ${offset} is out of bounds for paragraph ${position.blockId}`,
        );
      }
      return { blockId: position.blockId, inlineIndex, offset };
    }
    const total = paragraph.inlines.reduce(
      (sum, inline) => sum + inlineTextLength(inline),
      0,
    );
    if (offset > total) {
      throw new ServiceError(
        "INVALID_RANGE",
        `offset ${offset} is out of bounds for paragraph ${position.blockId}`,
      );
    }
    return textOffsetToPosition(paragraph, offset);
  }

  private resolvePosition(
    doc: DocDocument,
    position: PositionInput,
  ): TextPosition {
    return this.validatePosition(doc, position);
  }

  private static positionFollows(
    start: TextPosition,
    end: TextPosition,
  ): boolean {
    if (start.inlineIndex !== end.inlineIndex)
      return start.inlineIndex > end.inlineIndex;
    return start.offset > end.offset;
  }

  private resolveRange(doc: DocDocument, range: RangeInput): DocRange {
    const start = this.validatePosition(doc, range.start);
    const end = this.validatePosition(doc, range.end);
    const order = new Map<string, number>();
    listBlocks(doc).forEach((entry, index) => {
      order.set(entry.block.id, index);
    });
    const startOrder = order.get(start.blockId);
    const endOrder = order.get(end.blockId);
    if (startOrder === undefined || endOrder === undefined)
      throw new ServiceError(
        "BLOCK_NOT_FOUND",
        `Unknown paragraph: ${startOrder === undefined ? start.blockId : end.blockId}`,
      );
    const reversed =
      startOrder > endOrder ||
      (startOrder === endOrder && DocumentService.positionFollows(start, end));
    if (reversed)
      throw new ServiceError("INVALID_RANGE", "Range end precedes its start");
    return { start, end };
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
        this.assertMergeRegion(table, input.region);
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

  /**
   * Rejects merge regions that the model would otherwise clamp: reversed or
   * non-integer bounds, coordinates outside the grid, and regions that overlap
   * a cell that is already merged.
   */
  private assertMergeRegion(
    table: Table,
    region: {
      startRow: number;
      endRow: number;
      startColumn: number;
      endColumn: number;
    },
  ): void {
    const bounds = [
      region.startRow,
      region.endRow,
      region.startColumn,
      region.endColumn,
    ];
    if (bounds.some((value) => !Number.isInteger(value))) {
      throw new ServiceError(
        "INVALID_RANGE",
        "mergeCells region bounds must be integers",
      );
    }
    const { startRow, endRow, startColumn, endColumn } = region;
    if (startRow < 0 || startColumn < 0) {
      throw new ServiceError(
        "INVALID_RANGE",
        "mergeCells region must not start before the first row/column",
      );
    }
    if (endRow < startRow || endColumn < startColumn) {
      throw new ServiceError(
        "INVALID_RANGE",
        "mergeCells region end precedes its start",
      );
    }
    if (endRow >= table.rows.length) {
      throw new ServiceError(
        "INVALID_RANGE",
        `mergeCells row ${endRow} is outside the table (${table.rows.length} rows)`,
      );
    }
    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const row = table.rows[rowIndex];
      if (!row || endColumn >= row.cells.length) {
        throw new ServiceError(
          "INVALID_RANGE",
          `mergeCells column is outside the table at row ${rowIndex}`,
        );
      }
      for (
        let columnIndex = startColumn;
        columnIndex <= endColumn;
        columnIndex += 1
      ) {
        const cell = row.cells[columnIndex];
        if (!cell) {
          throw new ServiceError(
            "INVALID_RANGE",
            `mergeCells column ${columnIndex} is outside row ${rowIndex}`,
          );
        }
        if ((cell.props.gridSpan ?? 1) > 1 || cell.props.vMerge) {
          throw new ServiceError(
            "INVALID_RANGE",
            `mergeCells region overlaps an existing merge at ${rowIndex}:${columnIndex}`,
          );
        }
      }
    }
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
    // Cloned header/footer parts are re-keyed by the model; enforce the global
    // uniqueness invariant so a regression cannot silently duplicate ids.
    if (!hasUniqueStructuralIds(session.document)) {
      throw new ServiceError(
        "INVALID_STATE",
        "Section break produced duplicate structural ids",
      );
    }
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
    const section = session.document.sections[sectionIndex];
    if (!section) {
      throw new ServiceError(
        "SECTION_NOT_FOUND",
        `Unknown section: ${sectionIndex}`,
      );
    }
    if (input.page) {
      const page = input.page;
      if (
        page.orientation !== undefined &&
        page.orientation !== "portrait" &&
        page.orientation !== "landscape"
      ) {
        throw new ServiceError(
          "INVALID_ARGUMENT",
          `Unknown orientation: ${String(page.orientation)}`,
        );
      }
      for (const key of ["width", "height"] as const) {
        const value = page[key];
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
          throw new ServiceError(
            "INVALID_ARGUMENT",
            `Page ${key} must be a positive finite number`,
          );
        }
      }
      const margins =
        (page.margins as unknown as Record<string, number | undefined>) ?? {};
      for (const [edge, value] of Object.entries(margins)) {
        if (value === undefined) continue;
        if (!Number.isFinite(value)) {
          throw new ServiceError(
            "INVALID_ARGUMENT",
            `Page margin ${edge} must be a finite number`,
          );
        }
        const mustBePositive = ["top", "right", "bottom", "left"].includes(
          edge,
        );
        if (mustBePositive ? value <= 0 : value < 0) {
          throw new ServiceError(
            "INVALID_ARGUMENT",
            `Page margin ${edge} must be ${mustBePositive ? "greater than zero" : "non-negative"}`,
          );
        }
      }
    }
    if (input.columns) {
      if (!Number.isInteger(input.columns.count) || input.columns.count < 1) {
        throw new ServiceError(
          "INVALID_ARGUMENT",
          `Column count must be at least 1 (received ${String(input.columns.count)})`,
        );
      }
      if (!Number.isFinite(input.columns.space) || input.columns.space < 0) {
        throw new ServiceError(
          "INVALID_ARGUMENT",
          "Column spacing must be a non-negative finite number",
        );
      }
    }
    const previousPage = structuredClone(section.page);
    if (input.page) setPageSetup(session.document, sectionIndex, input.page);
    if (input.columns)
      setColumns(session.document, sectionIndex, input.columns);
    // Geometry must still fit the page after the patch; roll back on overflow.
    const applied = session.document.sections[sectionIndex];
    const fits =
      applied.page.margins.left + applied.page.margins.right <
        applied.page.width &&
      applied.page.margins.top + applied.page.margins.bottom <
        applied.page.height;
    if (!fits) {
      applied.page = previousPage;
      throw new ServiceError(
        "INVALID_ARGUMENT",
        "Page margins do not fit inside the page",
      );
    }
    if (input.pageNumbers) {
      applied.pageNumbering = {
        ...(applied.pageNumbering ?? {}),
        ...input.pageNumbers,
      };
    }
    return this.afterMutation(session, "document_layout", { sectionIndex });
  }

  /**
   * Renames a document and updates its descriptive metadata (editor panel).
   *
   * Only the user-facing properties are accepted: `title`, `subject`,
   * `keywords`, `creator`, `category` and `description`. Unknown keys and
   * values of the wrong type are ignored, so the engine keeps owning
   * timestamps, revision counters and application properties.
   */
  setDocumentMetadata(
    documentId: string,
    patch: Partial<DocDocument["metadata"]>,
  ): unknown {
    const session = this.session(documentId);
    const source = (patch ?? {}) as Partial<DocDocument["metadata"]>;
    const clean: Partial<DocDocument["metadata"]> = {};
    if (typeof source.title === "string") clean.title = source.title;
    if (typeof source.subject === "string") clean.subject = source.subject;
    if (typeof source.creator === "string") clean.creator = source.creator;
    if (typeof source.category === "string") clean.category = source.category;
    if (typeof source.description === "string")
      clean.description = source.description;
    if (Array.isArray(source.keywords)) {
      clean.keywords = source.keywords.filter(
        (keyword): keyword is string => typeof keyword === "string",
      );
    }
    const changed = Object.keys(clean);
    if (changed.length === 0) return { changed };
    setMetadata(session.document, clean);
    // Audit detail records which fields changed, never their content.
    return this.afterMutation(session, "document_set_metadata", { changed });
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

  /** Engine preference configured for this service instance. */
  enginePreference(): EnginePreference {
    return this.enginePreferenceValue;
  }

  /**
   * Resolves the engine this service would use for the flagship conversion
   * (PDF) right now, including why. Never spawns a conversion.
   */
  async engineInUse(): Promise<{
    engine: ConversionEngineId;
    preference: EnginePreference;
    available: boolean;
    reason: EngineRoute["reason"];
    fallbackReason: FallbackReason | null;
    path: string | null;
    version: string | null;
  }> {
    const detection = await this.detectEngine();
    const route = routeConversion({
      preference: this.enginePreferenceValue,
      available: detection.available,
      format: "pdf",
    });
    return {
      engine: route.engine,
      preference: route.preference,
      available: detection.available,
      reason: route.reason,
      fallbackReason: route.fallbackReason,
      path: detection.path,
      version: detection.version ?? null,
    };
  }

  /** Changes the engine preference for this service (not process-wide). */
  async setEnginePreference(value: unknown): Promise<{
    previous: EnginePreference;
    preference: EnginePreference;
    engine: ConversionEngineId;
    available: boolean;
    reason: EngineRoute["reason"];
    fallbackReason: FallbackReason | null;
  }> {
    let preference: EnginePreference;
    try {
      preference = parseEnginePreference(value);
    } catch (error) {
      throw new ServiceError(
        "INVALID_ARGUMENT",
        error instanceof Error ? error.message : String(error),
        { engine: value, accepted: [...ENGINE_PREFERENCES] },
      );
    }
    const previous = this.enginePreferenceValue;
    this.enginePreferenceValue = preference;
    const resolved = await this.engineInUse();
    await this.workspace.audit({
      action: "document_set_engine",
      outcome: "ok",
      detail: { previous, preference, engine: resolved.engine },
    });
    return {
      previous,
      preference,
      engine: resolved.engine,
      available: resolved.available,
      reason: resolved.reason,
      fallbackReason: resolved.fallbackReason,
    };
  }

  async convert(input: {
    documentId?: string;
    path?: string;
    to: string;
    outputPath?: string;
  }): Promise<unknown> {
    if (input.outputPath) this.workspace.assertWritable();
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
    const outcome = await this.exportThroughEngine(document, input.to);
    if (input.outputPath) {
      const target = this.workspace.resolveWritePath(input.outputPath);
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, outcome.buffer);
    }
    await this.workspace.audit({
      action: "document_convert",
      documentId: input.documentId,
      outcome: "ok",
      detail: {
        to: input.to,
        engine: outcome.route.engine,
        fallbackReason: outcome.route.fallbackReason,
      },
    });
    return {
      format: input.to,
      bytes: outcome.buffer.byteLength,
      losses: outcome.losses,
      warnings: outcome.warnings,
      outputPath: input.outputPath ?? null,
      engine: outcome.route.engine,
      preference: outcome.route.preference,
      reason: outcome.route.reason,
      fallbackReason: outcome.route.fallbackReason,
      report: outcome.report,
      pageCount: outcome.pageCount,
      ...(input.outputPath
        ? {}
        : { dataBase64: outcome.buffer.toString("base64") }),
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
    engine: ConversionEngineId;
    preference: EnginePreference;
    reason: EngineRoute["reason"];
    fallbackReason: FallbackReason | null;
    durationMs: number;
    warnings: string[];
  }> {
    if (outputPath) this.workspace.assertWritable();
    const started = Date.now();
    const session = this.session(documentId);
    const snapshot = structuredClone(session.document);
    const { available, detection } = await this.routingDetectionFor("pdf");
    let route = routeConversion({
      preference: this.enginePreferenceValue,
      available,
      format: "pdf",
    });
    let buffer: Buffer | null = null;
    let pageCount = 0;
    const warnings: string[] = [];

    if (route.engine === "libreoffice" && detection) {
      try {
        const docx = await exportDocx(snapshot, { preserveTimestamps: true });
        const rendered = await this.convertDocxToPdf(docx.buffer, detection);
        buffer = rendered.buffer;
        pageCount = rendered.pageCount;
        warnings.push(...rendered.warnings);
      } catch (error) {
        // Never silent: the typed reason is returned and audited below.
        route = routeAfterFailure(
          {
            preference: this.enginePreferenceValue,
            available,
            format: "pdf",
          },
          fallbackReasonForError(error),
        );
      }
    }

    if (!buffer) {
      const render = await import("../render/index.js");
      const layout = layoutDocument(snapshot);
      buffer = await render.renderPdf(layout, {
        title: snapshot.metadata.title,
        author: snapshot.metadata.creator,
        images: render.mediaMap(snapshot),
      });
      // Count the actual page objects; the layout page count is the fallback.
      pageCount = countPdfPages(buffer) ?? layout.pageCount;
    }

    this.lastRoute = route;
    const durationMs = Date.now() - started;
    const result = {
      bytes: buffer.byteLength,
      pageCount,
      engine: route.engine,
      preference: route.preference,
      reason: route.reason,
      fallbackReason: route.fallbackReason,
      durationMs,
      warnings,
    };
    if (outputPath) {
      const target = this.workspace.resolveWritePath(outputPath);
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, buffer);
      await this.workspace.audit({
        action: "document_export_pdf",
        documentId,
        outcome: "ok",
        detail: {
          bytes: buffer.byteLength,
          engine: route.engine,
          fallbackReason: route.fallbackReason,
        },
      });
      return { ...result, path: target };
    }
    return {
      ...result,
      path: null,
      dataBase64: buffer.toString("base64"),
    };
  }

  async exportDocument(
    documentId: string,
    format: string,
    outputPath?: string,
  ): Promise<unknown> {
    if (outputPath) this.workspace.assertWritable();
    const session = this.session(documentId);
    const normalized = normalizeRoutingFormat(format);
    if (normalized === "dotx" || normalized === "docm") {
      // Template/macro flavours are not in LibreOffice's writer filter table;
      // the model exporter writes them with exact model fidelity.
      const exported = await exportDocx(session.document, {
        flavor: normalized,
      });
      const route = routeConversion({
        preference: this.enginePreferenceValue,
        available: false,
        format: normalized,
      });
      this.lastRoute = route;
      const base = {
        format: normalized,
        bytes: exported.buffer.byteLength,
        losses: [] as ConversionLoss[],
        warnings: [] as string[],
        engine: "internal" as const,
        preference: route.preference,
        reason: route.reason,
        fallbackReason: route.fallbackReason,
        report: null,
        pageCount: null,
      };
      if (outputPath) {
        const target = this.workspace.resolveWritePath(outputPath);
        await fsMkdir(path.dirname(target), { recursive: true });
        await fsWriteFile(target, exported.buffer);
        return { ...base, path: target };
      }
      return {
        ...base,
        path: null,
        dataBase64: exported.buffer.toString("base64"),
      };
    }
    const formats = await this.tryFormats();
    if (!formats)
      throw new ServiceError(
        "FORMAT_UNAVAILABLE",
        `No exporter available for ${format}`,
      );
    const outcome = await this.exportThroughEngine(
      session.document,
      normalized,
    );
    const result = {
      format: normalized,
      bytes: outcome.buffer.byteLength,
      losses: outcome.losses,
      warnings: outcome.warnings,
      engine: outcome.route.engine,
      preference: outcome.route.preference,
      reason: outcome.route.reason,
      fallbackReason: outcome.route.fallbackReason,
      report: outcome.report,
      pageCount: outcome.pageCount,
    };
    if (outputPath) {
      const target = this.workspace.resolveWritePath(outputPath);
      await fsMkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, outcome.buffer);
      await this.workspace.audit({
        action: "document_export",
        documentId,
        outcome: "ok",
        detail: {
          format: normalized,
          engine: outcome.route.engine,
          fallbackReason: outcome.route.fallbackReason,
        },
      });
      return { ...result, path: target };
    }
    return {
      ...result,
      path: null,
      dataBase64: outcome.buffer.toString("base64"),
    };
  }

  /* ------------------------------------------------- engine routing bits */

  private async detectEngine(refresh = false): Promise<LibreOfficeDetection> {
    return detectLibreOffice({ refresh });
  }

  /**
   * Detection for a conversion route. An explicit `internal` preference never
   * probes (and therefore never launches) LibreOffice; neither does a target
   * format the routing table keeps on the internal adapter (plain text,
   * markdown, template flavours).
   */
  private async routingDetection(): Promise<{
    available: boolean;
    detection: LibreOfficeDetection | null;
  }> {
    if (this.enginePreferenceValue === "internal") {
      return { available: false, detection: null };
    }
    const detection = await this.detectEngine();
    return { available: detection.available, detection };
  }

  /**
   * Route-specific detection: only probe LibreOffice when the target format
   * could actually use it. This is what makes `internal` (and txt/markdown)
   * never spawn a process.
   */
  private async routingDetectionFor(format: string): Promise<{
    available: boolean;
    detection: LibreOfficeDetection | null;
  }> {
    if (this.enginePreferenceValue === "internal") {
      return { available: false, detection: null };
    }
    const capable = routeConversion({
      preference: this.enginePreferenceValue,
      available: false,
      format,
    }).capable;
    if (!capable) return { available: false, detection: null };
    return this.routingDetection();
  }

  /** Shared options for `convertWithLibreOffice` calls made by this service. */
  private engineConversionOptions(): {
    tempDirectory?: string;
    timeoutMs?: number;
  } {
    return {
      ...(this.engineTempDirectory === undefined
        ? {}
        : { tempDirectory: this.engineTempDirectory }),
      ...(this.engineTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.engineTimeoutMs }),
    };
  }

  /**
   * Runs one LibreOffice conversion. The adapter retries a transient shared-
   * profile failure once with an isolated profile; the retry is surfaced as a
   * warning so it is never silent. Timeouts and missing-engine errors are never
   * retried, and an explicit external conversion reports its error instead.
   */
  private async convertWithLibreOfficeRetry(
    options: Parameters<typeof convertWithLibreOffice>[0],
  ): Promise<{
    result: Awaited<ReturnType<typeof convertWithLibreOffice>>;
    retried: boolean;
  }> {
    const result = await convertWithLibreOffice(options);
    return { result, retried: result.retried === true };
  }

  /** Runs `work` inside a fresh temporary directory that is always removed. */
  private async withTempDirectory<T>(
    prefix: string,
    work: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await fsMkdtemp(
      path.join(this.engineTempDirectory ?? tmpdir(), prefix),
    );
    try {
      return await work(directory);
    } finally {
      await fsRm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  /** The internal adapter path, measured exactly like the conversion engine. */
  private async internalConversion(
    document: DocDocument,
    format: string,
  ): Promise<{
    buffer: Buffer;
    losses: ConversionLoss[];
    warnings: string[];
    report: ConversionReport;
    pageCount: number | null;
  }> {
    const result = (await convertEngine.convert(document, {
      from: "model",
      to: adapterFormatFor(format),
    })) as {
      buffer: Buffer;
      losses: ConversionLoss[];
      warnings: string[];
      report: ConversionReport;
    };
    return {
      buffer: result.buffer,
      losses: result.losses,
      warnings: result.warnings,
      report: result.report,
      pageCount:
        format === "pdf" ? (countPdfPages(result.buffer) ?? null) : null,
    };
  }

  /** DOCX bytes → PDF through LibreOffice, with a counted page total. */
  private async convertDocxToPdf(
    docx: Buffer,
    detection: LibreOfficeDetection,
  ): Promise<{
    buffer: Buffer;
    pageCount: number;
    warnings: string[];
    durationMs: number;
  }> {
    return this.withTempDirectory("dsh-doc-pdf-", async (directory) => {
      const docxPath = path.join(directory, "input.docx");
      await fsWriteFile(docxPath, docx);
      const { result: converted, retried } =
        await this.convertWithLibreOfficeRetry({
          inputPath: docxPath,
          format: "pdf",
          detection,
          ...this.engineConversionOptions(),
        });
      const buffer = Buffer.from(converted.dataBase64 ?? "", "base64");
      if (buffer.byteLength === 0) {
        throw new LibreOfficeError(
          "OUTPUT_MISSING",
          "LibreOffice returned no PDF bytes",
        );
      }
      const pageCount = countPdfPages(buffer);
      if (pageCount === undefined || pageCount <= 0) {
        throw new LibreOfficeError(
          "OUTPUT_MISSING",
          "LibreOffice produced a PDF without countable page objects",
          { bytes: buffer.byteLength, sha256: converted.sha256 },
        );
      }
      return {
        buffer,
        pageCount,
        warnings: [
          ...converted.warnings,
          ...(retried ? [LIBREOFFICE_RETRY_WARNING] : []),
        ],
        durationMs: converted.durationMs,
      };
    });
  }

  private libreOfficeReport(
    document: DocDocument,
    options: {
      durationMs: number;
      textEqual: boolean | null;
      after?: DocumentStats;
      warnings: string[];
    },
  ): ConversionReport {
    const before = documentStats(document);
    return {
      // Text equality is the only content claim this path makes; structure is
      // measured from the re-imported output when one exists.
      contentPreservation: 1,
      structuralPreservation:
        options.after === undefined
          ? 1
          : convertEngine.structuralPreservationScore(before, options.after),
      unsupportedElements: [],
      durationMs: options.durationMs,
      verified: options.textEqual !== null,
      method: options.textEqual === null ? "unverified" : "roundtrip-text",
      textBefore: before,
      ...(options.after === undefined ? {} : { textAfter: options.after }),
      roundTripAttempted: options.textEqual !== null,
    };
  }

  /**
   * One LibreOffice attempt for a text-bearing target. Returns `ok: false` with
   * `text-loss` when the output cannot be re-imported or its normalized text
   * differs from the model: the caller then keeps the internal adapter.
   */
  private async libreOfficeExport(
    document: DocDocument,
    format: string,
    detection: LibreOfficeDetection,
  ): Promise<
    | {
        ok: true;
        buffer: Buffer;
        pageCount: number | null;
        textEqual: boolean | null;
        warnings: string[];
        report: ConversionReport;
      }
    | { ok: false; reason: FallbackReason; detail: string }
  > {
    if (format === "pdf") {
      const docx = await exportDocx(document, { preserveTimestamps: true });
      const rendered = await this.convertDocxToPdf(docx.buffer, detection);
      return {
        ok: true,
        buffer: rendered.buffer,
        pageCount: rendered.pageCount,
        textEqual: null,
        warnings: rendered.warnings,
        report: this.libreOfficeReport(document, {
          durationMs: rendered.durationMs,
          textEqual: null,
          warnings: rendered.warnings,
        }),
      };
    }

    const docx = await exportDocx(document, { preserveTimestamps: true });
    const converted = await this.withTempDirectory(
      "dsh-doc-convert-",
      async (directory) => {
        const docxPath = path.join(directory, "input.docx");
        await fsWriteFile(docxPath, docx.buffer);
        const { result, retried } = await this.convertWithLibreOfficeRetry({
          inputPath: docxPath,
          format,
          detection,
          ...this.engineConversionOptions(),
        });
        const buffer = Buffer.from(result.dataBase64 ?? "", "base64");
        if (buffer.byteLength === 0) {
          throw new LibreOfficeError(
            "OUTPUT_MISSING",
            `LibreOffice returned no ${format} bytes`,
          );
        }
        return {
          buffer,
          warnings: [
            ...result.warnings,
            ...(retried ? [LIBREOFFICE_RETRY_WARNING] : []),
          ],
          durationMs: result.durationMs,
        };
      },
    );

    const beforeText = convertEngine.normalizeConversionText(
      documentText(document),
    );
    let imported: { document: DocDocument };
    try {
      imported = await formatRegistry.importAny(
        converted.buffer,
        `libreoffice.${format}`,
      );
    } catch (error) {
      return {
        ok: false,
        reason: "text-loss",
        detail: `LibreOffice ${format} output could not be re-imported: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const afterText = convertEngine.normalizeConversionText(
      documentText(imported.document),
    );
    if (afterText !== beforeText) {
      return {
        ok: false,
        reason: "text-loss",
        detail: `LibreOffice ${format} output changed the document text (${beforeText.length} → ${afterText.length} characters)`,
      };
    }
    const after = documentStats(imported.document);
    return {
      ok: true,
      buffer: converted.buffer,
      pageCount: null,
      textEqual: true,
      warnings: converted.warnings,
      report: this.libreOfficeReport(document, {
        durationMs: converted.durationMs,
        textEqual: true,
        after,
        warnings: converted.warnings,
      }),
    };
  }

  /**
   * The single routing entry point for `convert()` / `exportDocument()`.
   * LibreOffice is attempted first when the preference and detection allow it;
   * every downgrade carries a typed reason in `route`.
   */
  private async exportThroughEngine(
    document: DocDocument,
    target: string,
  ): Promise<{
    buffer: Buffer;
    losses: ConversionLoss[];
    warnings: string[];
    report: ConversionReport;
    pageCount: number | null;
    route: EngineRoute;
    textEqual: boolean | null;
  }> {
    const format = normalizeRoutingFormat(target);
    const { available, detection } = await this.routingDetectionFor(format);
    let route = routeConversion({
      preference: this.enginePreferenceValue,
      available,
      format,
    });

    if (route.engine === "libreoffice" && detection) {
      try {
        const attempt = await this.libreOfficeExport(
          document,
          format,
          detection,
        );
        if (attempt.ok) {
          this.lastRoute = route;
          return {
            buffer: attempt.buffer,
            losses: [],
            warnings: attempt.warnings,
            report: attempt.report,
            pageCount: attempt.pageCount,
            route,
            textEqual: attempt.textEqual,
          };
        }
        // Text loss is a routing decision, not an error: keep the internal
        // adapter for fidelity and report the measured reason.
        route = routeConversion({
          preference: this.enginePreferenceValue,
          available,
          format,
          textLoss: true,
        });
        const internal = await this.internalConversion(document, format);
        this.lastRoute = route;
        return {
          ...internal,
          warnings: [
            ...internal.warnings,
            `LibreOffice ${format} output lost document text (${attempt.detail}); the internal adapter was used instead.`,
          ],
          route,
          textEqual: false,
        };
      } catch (error) {
        route = routeAfterFailure(
          {
            preference: this.enginePreferenceValue,
            available,
            format,
          },
          fallbackReasonForError(error),
        );
        const internal = await this.internalConversion(document, format);
        this.lastRoute = route;
        return {
          ...internal,
          warnings: [
            ...internal.warnings,
            `LibreOffice ${format} conversion failed; the internal adapter was used instead.`,
          ],
          route,
          textEqual: null,
        };
      }
    }

    const internal = await this.internalConversion(document, format);
    this.lastRoute = route;
    return { ...internal, route, textEqual: null };
  }

  /**
   * Reports the optional external engines. Always resolves: an absent
   * LibreOffice install is reported as `available: false` together with the
   * detection evidence (candidates, probe attempts and a stable reason), never
   * as a silent capability. The configured preference, the engine that is
   * actually in use and the per-format routing decision are reported too.
   */
  async engineStatus(options: { refresh?: boolean } = {}): Promise<{
    available: boolean;
    reason: string | null;
    checkedAt: string;
    installHint: string;
    preference: EnginePreference;
    verifySaveWithLibreOffice: boolean;
    engineInUse: {
      engine: ConversionEngineId;
      reason: EngineRoute["reason"];
      fallbackReason: FallbackReason | null;
      format: string;
    };
    lastRoute: EngineRoute | null;
    workspace: { readOnly: boolean };
    engines: Record<string, unknown>;
    capabilities: Array<{
      format: string;
      internal: { import: boolean; export: boolean };
      libreoffice: { available: boolean; import: boolean; export: boolean };
      routing: {
        engine: ConversionEngineId;
        reason: EngineRoute["reason"];
        fallbackReason: FallbackReason | null;
      };
    }>;
  }> {
    const detection = await detectLibreOffice({
      refresh: options.refresh === true,
    });
    const listed = (await this.listFormats()) as {
      import?: string[];
      export?: string[];
    };
    const internalImport = new Set(
      (listed.import ?? []).map((entry) => entry.toLowerCase()),
    );
    const internalExport = new Set(
      (listed.export ?? []).map((entry) => entry.toLowerCase()),
    );
    const libreOfficeImport = new Set(
      Object.values(LIBREOFFICE_CONVERSION_FORMATS).flatMap((definition) => [
        ...definition.inputExtensions,
      ]),
    );
    const formats = [
      ...new Set([
        ...supportedLibreOfficeFormats(),
        ...internalImport,
        ...internalExport,
      ]),
    ].sort();
    const capabilities = formats.map((format) => {
      const route = routeConversion({
        preference: this.enginePreferenceValue,
        available: detection.available,
        format,
      });
      return {
        format,
        internal: {
          import: internalImport.has(format),
          export: internalExport.has(format),
        },
        libreoffice: {
          available: detection.available,
          import: detection.available && libreOfficeImport.has(format),
          export:
            detection.available &&
            Object.hasOwn(LIBREOFFICE_CONVERSION_FORMATS, format),
        },
        routing: {
          engine: route.engine,
          reason: route.reason,
          fallbackReason: route.fallbackReason,
        },
      };
    });
    const flagRoute = routeConversion({
      preference: this.enginePreferenceValue,
      available: detection.available,
      format: "pdf",
    });

    return {
      available: detection.available,
      reason: detection.available ? null : (detection.reason ?? "not-found"),
      checkedAt: detection.checkedAt,
      installHint: LIBREOFFICE_INSTALL_HINT,
      preference: this.enginePreferenceValue,
      verifySaveWithLibreOffice: this.verifySaveWithLibreOffice,
      engineInUse: {
        engine: flagRoute.engine,
        reason: flagRoute.reason,
        fallbackReason: flagRoute.fallbackReason,
        format: "pdf",
      },
      lastRoute: this.lastRoute ? { ...this.lastRoute } : null,
      workspace: { readOnly: this.workspace.readOnly },
      engines: {
        internal: {
          id: "internal",
          available: true,
          name: "Built-in layout/PDF renderer and format adapters",
          pdf: { export: true, import: false, pixelAccurate: false },
          note: "Used when LibreOffice is unavailable, when the preference is internal, or when a LibreOffice conversion loses text.",
        },
        libreoffice: {
          id: "libreoffice",
          available: detection.available,
          path: detection.path,
          version: detection.version ?? null,
          source: detection.source,
          reason: detection.available
            ? null
            : (detection.reason ?? "not-found"),
          defaultEngine: true,
          note: "Default conversion and PDF rendering engine when detected; every fallback is reported as fallbackReason.",
          detection,
        },
      },
      capabilities,
    };
  }

  /**
   * Converts a document through the optional LibreOffice engine. Input may be
   * read from the workspace or any configured read root; a requested output
   * path must stay inside the workspace and is refused in read-only mode.
   * Every LibreOffice failure keeps its typed code and detection evidence.
   */
  async convertWithExternalEngine(input: {
    inputPath: string;
    format: string;
    outputPath?: string;
    timeoutMs?: number;
  }): Promise<unknown> {
    if (
      typeof input.inputPath !== "string" ||
      input.inputPath.trim().length === 0
    ) {
      throw new ServiceError(
        "INVALID_ARGUMENT",
        "inputPath is required for external conversion",
      );
    }
    const inputPath = this.workspace.resolveReadPath(input.inputPath);
    let outputPath: string | undefined;
    if (input.outputPath !== undefined) {
      if (
        typeof input.outputPath !== "string" ||
        input.outputPath.trim().length === 0
      ) {
        throw new ServiceError(
          "INVALID_ARGUMENT",
          "outputPath must be a non-empty string when supplied",
        );
      }
      this.workspace.assertWritable();
      outputPath = this.workspace.resolveWritePath(input.outputPath);
    }
    try {
      const result = await convertWithLibreOffice({
        inputPath,
        format:
          typeof input.format === "string"
            ? input.format
            : String(input.format),
        ...(outputPath === undefined ? {} : { outputPath }),
        ...(input.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
        workspaceRoot: this.workspace.root,
        readOnly: this.workspace.readOnly,
      });
      await this.workspace.audit({
        action: "document_convert_external",
        outcome: "ok",
        detail: {
          format: result.format,
          bytes: result.bytes,
          output: outputPath !== undefined,
        },
      });
      return result;
    } catch (error) {
      if (error instanceof LibreOfficeError) {
        await this.workspace.audit({
          action: "document_convert_external",
          outcome: "error",
          detail: { code: error.code, format: input.format },
        });
        throw new ServiceError(error.code, error.message, error.details);
      }
      throw error;
    }
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
