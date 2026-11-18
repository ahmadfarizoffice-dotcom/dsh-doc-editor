/**
 * Markdown adapter (CommonMark + GFM tables/strikethrough).
 *
 * Import walks the markdown-it token stream, so nesting, inline emphasis,
 * links, images, fenced code, tables and footnotes (the `[^n]` convention) map
 * onto the document model without re-parsing text. Remote images are never
 * fetched: they are recorded as losses and only their alt text survives.
 *
 * Export writes GFM: ATX headings, `-`/ordered lists with real indentation,
 * pipe tables, `[text](href)` links, `data:` images, fenced code, `[^n]`
 * footnotes and `>` block quotes. Anything Markdown cannot express (colours,
 * fonts, page setup, comments as annotations) is reported as a loss.
 */
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { createListDefinition } from "../model/edit.js";
import { computeNumbering } from "../model/numbering.js";
import { headingLevelOfStyle } from "../model/styles.js";
import type {
  Block,
  Border,
  DocDocument,
  FeatureSupport,
  ImageInline,
  Inline,
  NumberingRef,
  Paragraph,
  ParagraphProps,
  RunProps,
  Table,
} from "../model/types.js";
import {
  addImageInline,
  buildCompatibilityReport,
  buildTable,
  contentWidthPt,
  createDocumentContext,
  decodeDataUri,
  ensureCodeStyle,
  ensureQuoteStyle,
  importResult,
  LossCollector,
  makeParagraph,
  mergeRun,
  pushText,
  type DocumentContext,
  type TableCellSpec,
} from "./shared.js";
import { FormatError } from "./types.js";
import type {
  FormatAdapter,
  FormatCapabilities,
  FormatExportOptions,
  FormatExportResult,
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

interface FootnoteDefinition {
  id: string;
  text: string;
}

/** Extracts `[^id]: text` definitions (plus their indented continuations). */
function extractFootnotes(source: string): {
  body: string;
  definitions: FootnoteDefinition[];
} {
  const lines = source.split("\n");
  const definitions: FootnoteDefinition[] = [];
  const bodyLines: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const match = FOOTNOTE_DEFINITION.exec(line);
    if (!match) {
      bodyLines.push(line);
      index += 1;
      continue;
    }
    const parts = [match[2] ?? ""];
    index += 1;
    while (
      index < lines.length &&
      /^(?:[ \t]{2,}\S|[ \t]*$)/.test(lines[index]) &&
      lines[index].trim().length > 0
    ) {
      parts.push(lines[index].trim());
      index += 1;
    }
    definitions.push({ id: match[1], text: parts.join(" ").trim() });
  }
  return { body: bodyLines.join("\n"), definitions };
}

interface ListFrame {
  numId: string;
  level: number;
  kind: "bullet" | "number";
  start: number;
  items: number;
}

interface PendingParagraph {
  inlines: Inline[];
  style: string;
  props: ParagraphProps;
}

interface TableState {
  /** Header rows: one entry per row, each holding one inline array per cell. */
  header: Inline[][][];
  body: Inline[][][];
  currentRow: Inline[][];
  currentCell: Inline[];
  inCell: boolean;
  inHeader: boolean;
}

interface FootnoteState {
  definitions: Map<string, FootnoteDefinition>;
  referenced: Set<string>;
}

class MarkdownImporter {
  readonly losses = new LossCollector();
  readonly features = new Map<string, number>();
  private listStack: ListFrame[] = [];
  private itemStack: Array<{ numbering: NumberingRef; emitted: boolean }> = [];
  private blockquoteDepth = 0;
  private pending: PendingParagraph | undefined;
  private table: TableState | undefined;
  private headingLevel: number | undefined;

  constructor(
    private readonly ctx: DocumentContext,
    private readonly footnotes: FootnoteState,
  ) {}

  private count(feature: string, amount = 1): void {
    this.features.set(feature, (this.features.get(feature) ?? 0) + amount);
  }

  convert(source: string): void {
    const tokens = parser.parse(source, {});
    for (const token of tokens) this.token(token);
    if (this.pending) this.flushPending();
    this.emitUnreferencedFootnotes();
  }

  private token(token: Token): void {
    switch (token.type) {
      case "bullet_list_open":
        this.openList("bullet", 1);
        return;
      case "ordered_list_open":
        this.openList("number", numberAttribute(token, "start") ?? 1);
        return;
      case "bullet_list_close":
      case "ordered_list_close":
        this.listStack.pop();
        return;
      case "list_item_open": {
        const frame = this.listStack[this.listStack.length - 1];
        frame.items += 1;
        const numbering: NumberingRef = {
          numId:
            frame?.numId ??
            createListDefinition(this.ctx.doc, { kind: "bullet" }),
          level: Math.min(8, Math.max(0, frame?.level ?? 0)),
        };
        if (
          frame &&
          frame.kind === "number" &&
          frame.items === 1 &&
          frame.start > 1
        ) {
          numbering.startOverride = frame.start;
        }
        this.itemStack.push({ numbering, emitted: false });
        return;
      }
      case "list_item_close":
        this.itemStack.pop();
        return;
      case "blockquote_open":
        this.blockquoteDepth += 1;
        this.count("block.quote");
        return;
      case "blockquote_close":
        this.blockquoteDepth = Math.max(0, this.blockquoteDepth - 1);
        return;
      case "paragraph_open":
        this.pending = {
          inlines: [],
          style: ensureQuoteStyleIfNeeded(this.ctx.doc, this.blockquoteDepth),
          props: this.paragraphProps(),
        };
        return;
      case "paragraph_close":
        if (this.pending) this.flushPending();
        return;
      case "heading_open": {
        const level = Number(token.tag.slice(1)) || 1;
        this.headingLevel = level;
        this.pending = {
          inlines: [],
          style: `Heading${level}`,
          props: { outlineLevel: level - 1 },
        };
        this.count("paragraph.heading");
        return;
      }
      case "heading_close":
        if (this.pending) this.flushPending();
        this.headingLevel = undefined;
        return;
      case "inline":
        this.inline(token);
        return;
      case "fence":
      case "code_block":
        this.codeBlock(token);
        return;
      case "hr": {
        const border: Border = { style: "single", width: 1, color: "#999999" };
        this.ctx.blocks.push(
          makeParagraph(this.ctx, [], {
            props: {
              borders: { bottom: border },
              spaceBefore: 6,
              spaceAfter: 6,
            },
          }),
        );
        this.count("block.rule");
        return;
      }
      case "table_open":
        this.table = {
          header: [],
          body: [],
          currentRow: [],
          currentCell: [],
          inCell: false,
          inHeader: false,
        };
        this.count("table");
        return;
      case "thead_open":
        if (this.table) this.table.inHeader = true;
        return;
      case "thead_close":
        if (this.table) this.table.inHeader = false;
        return;
      case "tbody_open":
        if (this.table) this.table.inHeader = false;
        return;
      case "tbody_close":
        return;
      case "tr_open":
        if (this.table) this.table.currentRow = [];
        return;
      case "tr_close":
        if (this.table) {
          if (this.table.inHeader)
            this.table.header.push(this.table.currentRow);
          else this.table.body.push(this.table.currentRow);
          this.table.currentRow = [];
        }
        return;
      case "th_open":
      case "td_open":
        if (this.table) {
          this.table.inCell = true;
          this.table.currentCell = [];
        }
        return;
      case "th_close":
      case "td_close":
        if (this.table) {
          this.table.inCell = false;
          this.table.currentRow.push(this.table.currentCell);
          this.table.currentCell = [];
        }
        return;
      case "table_close":
        this.closeTable();
        return;
      default:
        return;
    }
  }

  private openList(kind: "bullet" | "number", start: number): void {
    const numId = createListDefinition(this.ctx.doc, {
      kind,
      startAt: start > 1 ? start : undefined,
    });
    this.listStack.push({
      numId,
      level: this.listStack.length,
      kind,
      start,
      items: 0,
    });
    this.count("lists.numbering");
  }

  private paragraphProps(): ParagraphProps {
    const props: ParagraphProps = {};
    if (this.blockquoteDepth > 0)
      props.indent = { left: 36 * this.blockquoteDepth };
    return props;
  }

  private inline(token: Token): void {
    const inlines: Inline[] = [];
    this.inlineChildren(token.children ?? [], inlines, {});
    if (this.table?.inCell) {
      this.table.currentCell = inlines;
      return;
    }
    if (this.pending) {
      this.pending.inlines.push(...inlines);
      return;
    }
    // Tight list items have no paragraph wrapper.
    const numbering = this.itemStack[this.itemStack.length - 1]?.numbering;
    if (numbering) {
      this.ctx.blocks.push(
        makeParagraph(this.ctx, inlines, {
          props: {
            numbering: { ...numbering },
            indent: { left: 36 + numbering.level * 36, hanging: 18 },
          },
        }),
      );
      const item = this.itemStack[this.itemStack.length - 1];
      if (item) item.emitted = true;
      return;
    }
    if (inlines.length > 0)
      this.ctx.blocks.push(
        makeParagraph(this.ctx, inlines, { props: this.paragraphProps() }),
      );
  }

  private inlineChildren(
    tokens: Token[],
    out: Inline[],
    props: RunProps,
  ): void {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      switch (token.type) {
        case "text":
          this.textWithFootnotes(token.content, out, props);
          break;
        case "softbreak":
          pushText(out, " ", props);
          break;
        case "hardbreak":
          out.push({ type: "break", kind: "line" });
          break;
        case "strong_open": {
          const enclosed = collectEnclosed(
            tokens,
            index,
            "strong_open",
            "strong_close",
          );
          this.inlineChildren(
            enclosed.children,
            out,
            mergeRun(props, { bold: true }),
          );
          index = enclosed.endIndex;
          break;
        }
        case "em_open": {
          const enclosed = collectEnclosed(
            tokens,
            index,
            "em_open",
            "em_close",
          );
          this.inlineChildren(
            enclosed.children,
            out,
            mergeRun(props, { italic: true }),
          );
          index = enclosed.endIndex;
          break;
        }
        case "s_open": {
          const enclosed = collectEnclosed(tokens, index, "s_open", "s_close");
          this.inlineChildren(
            enclosed.children,
            out,
            mergeRun(props, { strike: true }),
          );
          index = enclosed.endIndex;
          break;
        }
        case "code_inline":
          pushText(
            out,
            token.content,
            mergeRun(props, { fontFamily: "Consolas", background: "#f2f2f2" }),
          );
          break;
        case "link_open": {
          const href = attribute(token, "href") ?? "";
          const title = attribute(token, "title");
          const target = href.startsWith("#")
            ? mergeRun(props, {
                hyperlink: {
                  anchor: href.slice(1),
                  external: false,
                  tooltip: title,
                },
                color: "#0563c1",
                underline: "single",
              })
            : mergeRun(props, {
                hyperlink: { href, external: true, tooltip: title },
                color: "#0563c1",
                underline: "single",
              });
          const enclosed = collectEnclosed(
            tokens,
            index,
            "link_open",
            "link_close",
          );
          this.inlineChildren(enclosed.children, out, target);
          index = enclosed.endIndex;
          this.count("hyperlink");
          break;
        }
        case "image":
          this.image(token, out, props);
          break;
        case "html_inline":
          // markdown-it is configured with html:false, so this only appears for
          // constructs that survived as raw text; keep the literal text.
          pushText(out, token.content, props);
          this.losses.partial(
            "markdown.rawHtml",
            "Raw inline HTML is kept as literal text",
            undefined,
            true,
          );
          break;
        case "code_block":
          pushText(
            out,
            token.content,
            mergeRun(props, { fontFamily: "Consolas" }),
          );
          break;
        default:
          if (token.children && token.children.length > 0) {
            this.inlineChildren(token.children, out, props);
          } else if (token.content) {
            pushText(out, token.content, props);
          }
          break;
      }
    }
  }

  private textWithFootnotes(
    text: string,
    out: Inline[],
    props: RunProps,
  ): void {
    const pattern = /\[\^([^\]\s]+)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let matched = false;
    while ((match = pattern.exec(text)) !== null) {
      const definition = this.footnotes.definitions.get(match[1]);
      if (!definition) continue;
      matched = true;
      pushText(out, text.slice(lastIndex, match.index), props);
      this.referenceFootnote(definition);
      out.push({
        type: "noteRef",
        noteId: definition.id,
        noteType: "footnote",
      });
      lastIndex = match.index + match[0].length;
    }
    if (!matched) {
      pushText(out, text, props);
      return;
    }
    pushText(out, text.slice(lastIndex), props);
  }

  private referenceFootnote(definition: FootnoteDefinition): void {
    if (this.footnotes.referenced.has(definition.id)) return;
    this.footnotes.referenced.add(definition.id);
    const inlines: Inline[] = [];
    pushText(inlines, definition.text, {});
    this.ctx.doc.footnotes.push({
      id: definition.id,
      type: "footnote",
      blocks: [makeParagraph(this.ctx, inlines)],
    });
    this.count("footnote.reference");
  }

  private emitUnreferencedFootnotes(): void {
    for (const definition of this.footnotes.definitions.values()) {
      if (this.footnotes.referenced.has(definition.id)) continue;
      this.footnotes.referenced.add(definition.id);
      const inlines: Inline[] = [];
      pushText(inlines, definition.text, {});
      this.ctx.doc.footnotes.push({
        id: definition.id,
        type: "footnote",
        blocks: [makeParagraph(this.ctx, inlines)],
      });
      this.losses.partial(
        "footnote.unreferenced",
        "Footnote definition has no reference in the text; it is kept as a note",
        definition.id,
        true,
      );
    }
  }

  private image(token: Token, out: Inline[], props: RunProps): void {
    const src = attribute(token, "src") ?? "";
    const alt = token.content || attribute(token, "alt") || "";
    const decoded = decodeDataUri(src);
    if (decoded) {
      const inline: ImageInline = addImageInline(this.ctx, {
        data: decoded.data,
        contentType: decoded.contentType,
        alt,
        title: attribute(token, "title"),
      });
      out.push(inline);
      this.count("image.inline");
      return;
    }
    this.losses.partial(
      "image.remote",
      "Remote images are never fetched; only the alt text is kept",
      src.slice(0, 120),
      false,
    );
    if (alt.length > 0) pushText(out, alt, props);
  }

  private codeBlock(token: Token): void {
    const style = ensureCodeStyle(this.ctx.doc);
    const lines = token.content
      .replace(/\r\n?/g, "\n")
      .replace(/\n$/, "")
      .split("\n");
    lines.forEach((line, index) => {
      const inlines: Inline[] = [];
      pushText(inlines, line, { fontFamily: "Consolas", fontSize: 10 });
      if (index < lines.length - 1)
        inlines.push({ type: "break", kind: "line" });
      this.ctx.blocks.push(
        makeParagraph(this.ctx, inlines, {
          style,
          props: this.paragraphProps(),
        }),
      );
    });
    this.count("block.preformatted");
    if (token.info.trim().length > 0) {
      this.losses.partial(
        "code.language",
        "Fenced code language is recorded only in the source syntax",
        token.info.trim(),
        false,
      );
    }
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const item = this.itemStack[this.itemStack.length - 1];
    if (item && !item.emitted) {
      pending.props = {
        ...pending.props,
        numbering: { ...item.numbering },
        indent: { left: 36 + item.numbering.level * 36, hanging: 18 },
      };
      item.emitted = true;
    }
    trimInlines(pending.inlines);
    if (
      pending.inlines.length === 0 &&
      pending.style === "Normal" &&
      !pending.props.numbering
    )
      return;
    this.ctx.blocks.push(
      makeParagraph(this.ctx, pending.inlines, {
        style: pending.style,
        props: pending.props,
      }),
    );
  }

  private closeTable(): void {
    const table = this.table;
    this.table = undefined;
    if (!table) return;
    const rows: TableCellSpec[][] = [];
    const headerRows = table.header.length;
    for (const row of [...table.header, ...table.body]) {
      rows.push(
        row.map((cellInlines) => ({
          blocks: [makeParagraph(this.ctx, cellInlines)],
        })),
      );
    }
    if (rows.length === 0) return;
    const columns = Math.max(...rows.map((row) => row.length), 1);
    const width = contentWidthPt(this.ctx.doc) / columns;
    const built = buildTable(this.ctx, rows, {
      columns,
      columnWidths: new Array(columns).fill(width),
      headerRows: headerRows > 0 ? headerRows : undefined,
    });
    this.ctx.blocks.push(built);
  }
}

function ensureQuoteStyleIfNeeded(doc: DocDocument, depth: number): string {
  return depth > 0 ? ensureQuoteStyle(doc) : "Normal";
}

function attribute(token: Token, name: string): string | undefined {
  const attrs = token.attrs;
  if (!attrs) return undefined;
  for (const [key, value] of attrs) {
    if (key === name) return String(value);
  }
  return undefined;
}

/**
 * Returns the tokens enclosed by `openType` at `openIndex`, matching nested
 * occurrences of the same pair, plus the index of the closing token.
 */
function collectEnclosed(
  tokens: Token[],
  openIndex: number,
  openType: string,
  closeType: string,
): { children: Token[]; endIndex: number } {
  let depth = 1;
  const children: Token[] = [];
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === openType) depth += 1;
    else if (token.type === closeType) {
      depth -= 1;
      if (depth === 0) return { children, endIndex: index };
    }
    children.push(token);
  }
  return { children, endIndex: tokens.length - 1 };
}

function numberAttribute(token: Token, name: string): number | undefined {
  const raw = attribute(token, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function trimInlines(inlines: Inline[]): void {
  const first = inlines[0];
  if (first && first.type === "text") {
    first.text = first.text.replace(/^\s+/, "");
    if (first.text.length === 0) inlines.shift();
  }
  const last = inlines[inlines.length - 1];
  if (last && last.type === "text") {
    last.text = last.text.replace(/\s+$/, "");
    if (last.text.length === 0) inlines.pop();
  }
}

/**
 * Imports Markdown (CommonMark + GFM tables/strikethrough) into the model.
 * `[^n]` footnote definitions become real footnotes; remote images are
 * recorded as losses instead of being fetched.
 */
export async function importMarkdown(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `Markdown input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  let source = buffer.toString("utf8");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  source = source.replace(/\r\n?/g, "\n");

  const extracted = extractFootnotes(source);
  const definitions = new Map<string, FootnoteDefinition>();
  for (const definition of extracted.definitions)
    definitions.set(definition.id, definition);
  const footnoteState: FootnoteState = { definitions, referenced: new Set() };

  const ctx = createDocumentContext({
    metadata: {
      title: titleFromFileName(options.fileName) ?? "Untitled document",
    },
  });
  const importer = new MarkdownImporter(ctx, footnoteState);
  importer.convert(extracted.body);
  ctx.syncIds();
  const doc = ctx.doc;

  const features: FeatureSupport[] = [
    {
      feature: "document.markdown",
      label: "Markdown document",
      level: "full",
      occurrences: 1,
    },
    {
      feature: "document.metadata",
      label: "Document metadata",
      level: "partial",
      occurrences: 1,
      notes:
        "Markdown has no metadata container; the title comes from the file name",
    },
  ];
  for (const [feature, occurrences] of importer.features) {
    features.push({
      feature,
      label: featureLabel(feature),
      level: "full",
      occurrences,
    });
  }
  const losses = importer.losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "markdown",
    fileName: options.fileName,
    features,
    losses,
    unknownElements: [],
  });
  return importResult(doc, losses, []);
}

function titleFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : undefined;
}

function featureLabel(feature: string): string {
  const labels: Record<string, string> = {
    "paragraph.heading": "Headings",
    "block.quote": "Block quotes",
    "block.preformatted": "Code blocks",
    "block.rule": "Horizontal rules",
    "lists.numbering": "Lists",
    table: "Tables",
    "image.inline": "Embedded images",
    "image.remote": "Remote images",
    hyperlink: "Hyperlinks",
    "footnote.reference": "Footnotes",
    "footnote.unreferenced": "Footnote definitions",
  };
  return labels[feature] ?? feature;
}

/* --------------------------------------------------------------- exporter */

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(
      /^(\s*)([#>+-]|\d+\.)/,
      (_match, space: string, token: string) => `${space}\\${token}`,
    );
}

function escapeCell(text: string): string {
  return escapeMarkdown(text).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br />");
}

function codeFence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

interface MarkdownWriter {
  losses: LossCollector;
  noteIndex: Map<string, number>;
  noteDefinitions: string[];
  lines: string[];
  reported: Set<string>;
}

function reportOnce(
  writer: MarkdownWriter,
  feature: string,
  reason: string,
): void {
  if (writer.reported.has(feature)) return;
  writer.reported.add(feature);
  writer.losses.partial(feature, reason, undefined, false);
}

function inlineMarkdown(
  doc: DocDocument,
  inlines: Inline[],
  writer: MarkdownWriter,
  paragraphStyle?: string,
): string {
  let out = "";
  for (const inline of inlines) {
    switch (inline.type) {
      case "text": {
        const props: RunProps = inline.props;
        const isCode =
          props.fontFamily === "Consolas" || props.background === "#f2f2f2";
        let wrapped = isCode
          ? `${codeFence(inline.text)}${inline.text}${codeFence(inline.text)}`
          : escapeMarkdown(inline.text);
        if (props.italic) wrapped = `*${wrapped}*`;
        if (props.bold) wrapped = `**${wrapped}**`;
        if (props.strike || props.doubleStrike) wrapped = `~~${wrapped}~~`;
        if (props.underline)
          reportOnce(
            writer,
            "text.underline",
            "Markdown has no underline; only the text is kept",
          );
        if (props.vertAlign)
          reportOnce(
            writer,
            "text.vertAlign",
            "Superscript/subscript runs are written as plain text",
          );
        if (props.color || props.highlight || props.background) {
          reportOnce(
            writer,
            "text.color",
            "Character colour and highlight have no Markdown representation",
          );
        }
        if (props.fontFamily && props.fontFamily !== "Consolas") {
          reportOnce(
            writer,
            "text.font",
            "Font families have no Markdown representation",
          );
        }
        if (props.caps || props.smallCaps)
          reportOnce(
            writer,
            "text.caps",
            "Capitalisation effects have no Markdown representation",
          );
        const link = props.hyperlink;
        if (link && (link.href || link.anchor)) {
          const href = (link.href ?? `#${link.anchor ?? ""}`)
            .replace(/</g, "%3C")
            .replace(/>/g, "%3E")
            .replace(/\s/g, "%20");
          wrapped = `[${wrapped}](<${href}>)`;
        }
        out += wrapped;
        break;
      }
      case "tab":
        out += "\\t";
        reportOnce(
          writer,
          "text.tab",
          "Tabs are escaped instead of being preserved as tab stops",
        );
        break;
      case "break":
        if (inline.kind === "line") out += "  \n";
        else
          reportOnce(
            writer,
            "pageBreak",
            "Page breaks have no Markdown representation and were dropped",
          );
        break;
      case "image": {
        const asset = doc.media.find((entry) => entry.id === inline.mediaId);
        const alt = escapeCell(inline.alt ?? "");
        if (!asset) {
          writer.losses.unsupported(
            "image.missing",
            "Image media is not in the document",
            `image:${inline.mediaId}`,
            false,
          );
          out += alt;
          break;
        }
        out += `![${alt}](<data:${asset.contentType};base64,${asset.data}>)`;
        if (inline.anchor?.type === "floating") {
          reportOnce(
            writer,
            "image.floating",
            "Floating images are written as inline images",
          );
        }
        break;
      }
      case "field": {
        const text = (inline.result ?? [])
          .map((child) => inlineMarkdown(doc, [child], writer, paragraphStyle))
          .join("");
        reportOnce(
          writer,
          "fields",
          "Field results are written as plain text; Markdown has no fields",
        );
        out += text;
        break;
      }
      case "noteRef": {
        const index = writer.noteIndex.get(inline.noteId);
        if (index === undefined) {
          writer.losses.unsupported(
            "notes.reference",
            "Note reference has no note body",
            `note:${inline.noteId}`,
            false,
          );
          break;
        }
        out += `[^${index}]`;
        break;
      }
      case "commentRef":
        reportOnce(
          writer,
          "comment.anchor",
          "Comment anchors cannot be represented; comment bodies are appended at the end",
        );
        break;
      case "bookmark":
        reportOnce(
          writer,
          "bookmark",
          "Bookmarks cannot be represented in Markdown",
        );
        break;
      case "math":
        out += inline.linear;
        reportOnce(writer, "math", "Equations are written as linear text");
        break;
      case "shape": {
        reportOnce(
          writer,
          "shape",
          "Shapes are flattened to their text content",
        );
        const shape = doc.shapes.find((entry) => entry.id === inline.shapeId);
        if (shape) out += escapeMarkdown(blocksPlainText(shape.blocks));
        break;
      }
      case "unknown":
        out += escapeMarkdown(inline.text ?? "");
        reportOnce(
          writer,
          "unknown.inline",
          "Uninterpreted inlines are written as plain text",
        );
        break;
      default:
        break;
    }
  }
  return out;
}

function blocksPlainText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "paragraph") {
        return block.inlines
          .map((inline) =>
            inline.type === "text"
              ? inline.text
              : inline.type === "tab"
                ? "\t"
                : inline.type === "break"
                  ? "\n"
                  : inline.type === "math"
                    ? inline.linear
                    : "",
          )
          .join("");
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function listKindOf(
  doc: DocDocument,
  paragraph: Paragraph,
): "bullet" | "number" | undefined {
  const numbering = paragraph.props.numbering ?? undefined;
  if (!numbering) return undefined;
  const num = doc.numbering.nums[numbering.numId];
  const abstract = num ? doc.numbering.abstract[num.abstractId] : undefined;
  const levelDef =
    abstract?.levels.find((level) => level.level === numbering.level) ??
    abstract?.levels[0];
  if (!levelDef) return "bullet";
  return levelDef.numFmt === "bullet" || levelDef.numFmt === "none"
    ? "bullet"
    : "number";
}

class MarkdownExporter {
  readonly writer: MarkdownWriter;

  constructor(private readonly doc: DocDocument) {
    const noteIndex = new Map<string, number>();
    const noteDefinitions: string[] = [];
    [...doc.footnotes].forEach((note, index) => {
      noteIndex.set(note.id, index + 1);
      noteDefinitions.push(
        `[^${index + 1}]: ${note.blocks
          .map((block) => (block.type === "paragraph" ? blockText(block) : ""))
          .join(" ")
          .trim()}`,
      );
    });
    this.writer = {
      losses: new LossCollector(),
      noteIndex,
      noteDefinitions,
      lines: [],
      reported: new Set(),
    };
  }

  run(): string {
    this.doc.sections.forEach((section, index) => {
      if (index > 0) {
        this.push();
        this.writer.losses.partial(
          "section.multiple",
          "Section boundaries are flattened; page breaks have no Markdown representation",
          `section[${index}]`,
          false,
        );
      }
      this.renderBlocks(section.blocks);
    });
    this.appendComments();
    this.appendNotes();
    return `${this.writer.lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`;
  }

  private push(line = ""): void {
    this.writer.lines.push(line);
  }

  private renderBlocks(blocks: Block[]): void {
    let index = 0;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.type === "table") {
        this.table(block);
        index += 1;
        continue;
      }
      if (block.type === "toc") {
        this.writer.losses.partial(
          "toc",
          "Table of contents cannot be represented in Markdown",
          undefined,
          false,
        );
        index += 1;
        continue;
      }
      if (block.style === "Code") {
        index = this.codeGroup(blocks, index);
        continue;
      }
      if (isRuleParagraph(block)) {
        this.push("---");
        this.push();
        index += 1;
        continue;
      }
      if (block.props.numbering) {
        index = this.listGroup(blocks, index);
        continue;
      }
      if (block.style === "Quote" || (block.props.indent?.left ?? 0) >= 36) {
        index = this.quoteGroup(blocks, index);
        continue;
      }
      const headingLevel = headingLevelOfStyle(this.doc, block.style);
      const text = inlineMarkdown(
        this.doc,
        block.inlines,
        this.writer,
        block.style,
      );
      if (headingLevel !== undefined && headingLevel <= 6) {
        this.push(`${"#".repeat(headingLevel)} ${text}`.trimEnd());
      } else if (text.trim().length > 0) {
        this.push(text);
      } else {
        this.push();
      }
      this.push();
      index += 1;
    }
  }

  private codeGroup(blocks: Block[], start: number): number {
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let index = start;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.type !== "paragraph" || block.style !== "Code") break;
      for (const inline of block.inlines) {
        if (inline.type === "text") chunk.push(inline.text);
        else if (inline.type === "break" && inline.kind === "line") {
          chunks.push(chunk);
          chunk = [];
        }
      }
      index += 1;
    }
    chunks.push(chunk);
    const content = chunks.map((lines) => lines.join("")).join("\n");
    const fence = codeFence(content);
    this.push(`${fence}text`);
    for (const line of content.split("\n")) this.push(line);
    this.push(fence);
    this.push();
    return index;
  }

  private listGroup(blocks: Block[], start: number): number {
    let index = start;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.type !== "paragraph" || !block.props.numbering) break;
      const kind = listKindOf(this.doc, block);
      const level = Math.max(0, Math.min(8, block.props.numbering.level));
      const indent = "  ".repeat(level);
      const marker = kind === "bullet" ? "-" : this.orderedMarker(block);
      const text = inlineMarkdown(
        this.doc,
        block.inlines,
        this.writer,
        block.style,
      );
      this.push(`${indent}${marker} ${text}`.trimEnd());
      index += 1;
    }
    this.push();
    return index;
  }

  private orderedMarker(paragraph: Paragraph): string {
    const numbering = paragraph.props.numbering;
    if (!numbering) return "1.";
    const num = this.doc.numbering.nums[numbering.numId];
    const abstract = num
      ? this.doc.numbering.abstract[num.abstractId]
      : undefined;
    const levelDef = abstract?.levels.find(
      (level) => level.level === numbering.level,
    );
    if (levelDef && !["decimal", "decimalZero"].includes(levelDef.numFmt)) {
      reportOnce(
        this.writer,
        "numbering.format",
        "Non-decimal list numbering is written as a plain ordered list",
      );
      return "1.";
    }
    const label = computeNumbering(this.doc).labels.get(paragraph.id)?.label;
    const match = label ? /^(\d+)/.exec(label) : null;
    return match ? `${match[1]}.` : "1.";
  }

  private quoteGroup(blocks: Block[], start: number): number {
    let index = start;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.type !== "paragraph") break;
      const isQuote =
        block.style === "Quote" || (block.props.indent?.left ?? 0) >= 36;
      if (!isQuote) break;
      const text = inlineMarkdown(
        this.doc,
        block.inlines,
        this.writer,
        block.style,
      );
      this.push(`> ${text}`.trimEnd());
      index += 1;
    }
    this.push();
    return index;
  }

  private table(table: Table): void {
    if (table.rows.length === 0) {
      this.writer.losses.partial(
        "table.empty",
        "Empty table cannot be represented in Markdown",
        undefined,
        false,
      );
      return;
    }
    const headerRow = table.rows[0];
    const headerCells = headerRow.cells.map((cell) =>
      cellText(this.doc, cell.blocks, this.writer),
    );
    const hasMerges = table.rows.some((row) =>
      row.cells.some(
        (cell) =>
          (cell.props.gridSpan ?? 1) > 1 || cell.props.vMerge !== undefined,
      ),
    );
    if (hasMerges) {
      this.writer.losses.fallback(
        "table.mergedCells",
        "Merged cells cannot be represented in GFM; contents are written into separate cells",
        undefined,
        false,
      );
    }
    if (!headerRow.props.isHeader) {
      this.writer.losses.partial(
        "table.headerRow",
        "The first row is written as the Markdown header row",
        undefined,
        false,
      );
    }
    this.push(`| ${headerCells.join(" | ")} |`);
    this.push(`| ${headerCells.map(() => "---").join(" | ")} |`);
    for (let index = 1; index < table.rows.length; index += 1) {
      const row = table.rows[index];
      const cells = row.cells
        .filter((cell) => cell.props.vMerge !== "continue")
        .map((cell) => cellText(this.doc, cell.blocks, this.writer));
      this.push(`| ${cells.join(" | ")} |`);
    }
    this.push();
  }

  private appendComments(): void {
    if (this.doc.comments.length === 0) return;
    this.push();
    this.push("> **Comments**");
    for (const comment of this.doc.comments) {
      const body = comment.blocks
        .map((block) =>
          block.type === "paragraph"
            ? inlineMarkdown(this.doc, block.inlines, this.writer, block.style)
            : "",
        )
        .join(" ")
        .trim();
      this.push(
        `> ${comment.author}${comment.resolved ? " (resolved)" : ""}: ${body}`.trimEnd(),
      );
    }
    this.writer.losses.partial(
      "comment",
      "Comments are appended as a quoted summary; anchors and threading are lost",
      undefined,
      false,
    );
  }

  private appendNotes(): void {
    if (this.writer.noteDefinitions.length === 0) return;
    this.push();
    for (const definition of this.writer.noteDefinitions) this.push(definition);
    this.writer.losses.partial(
      "endnote",
      "Endnotes are written as footnote definitions at the end of the document",
      undefined,
      false,
    );
  }
}

function isRuleParagraph(block: Paragraph): boolean {
  return (
    block.inlines.length === 0 &&
    block.props?.borders?.bottom?.style === "single"
  );
}

function blockText(block: Paragraph): string {
  return block.inlines
    .map((inline) =>
      inline.type === "text" ? inline.text : inline.type === "tab" ? " " : "",
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(
  doc: DocDocument,
  blocks: Block[],
  writer: MarkdownWriter,
): string {
  return blocks
    .map((block) => {
      if (block.type === "paragraph")
        return inlineMarkdown(doc, block.inlines, writer, block.style);
      if (block.type === "table") return "[nested table]";
      return "";
    })
    .join("<br />")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * Exports a document as GFM Markdown. Text, headings, lists, tables, links,
 * images (as `data:` URIs), code and footnotes round-trip; formatting with no
 * Markdown equivalent is reported in `losses`.
 */
export async function exportMarkdown(
  doc: DocDocument,
  options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  void options;
  const exporter = new MarkdownExporter(doc);
  const text = exporter.run();
  const losses = exporter.writer.losses.all();
  if (doc.metadata.title && doc.metadata.title !== "Untitled document") {
    losses.push({
      feature: "document.metadata.title",
      level: "partial",
      reason:
        "Markdown has no metadata container; the title is only kept in the file name",
      preserved: false,
    });
  }
  return { buffer: Buffer.from(text, "utf8"), warnings: [], losses };
}

/* ------------------------------------------------------------- descriptor */

const CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: true,
  styles: "partial",
  tables: "partial",
  images: "partial",
  hyperlinks: "full",
  headersFooters: "none",
  pageLayout: "none",
  numbering: "partial",
  metadata: "none",
  comments: "partial",
  trackedChanges: "none",
  math: "none",
  notes: [
    "Headings, lists, GFM tables, links, code and footnotes round-trip.",
    "Remote images are never fetched: only alt text survives and a loss is reported.",
    "Character colour, fonts, underline, page setup and revisions are reported as losses.",
  ],
};

const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd"];

/** Markdown format descriptor. */
export const markdownAdapter: FormatAdapter = {
  id: "markdown",
  label: "Markdown (CommonMark + GFM)",
  extensions: MARKDOWN_EXTENSIONS,
  mimeTypes: ["text/markdown", "text/x-markdown"],
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    const match = fileName ? /\.([A-Za-z0-9]+)$/.exec(fileName) : null;
    if (match && MARKDOWN_EXTENSIONS.includes(match[1].toLowerCase()))
      return true;
    const head = bytes
      .subarray(0, Math.min(bytes.length, 4096))
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    if (head.includes("\u0000")) return false;
    if (/^\s*#{1,6}\s+\S/m.test(head)) return true;
    if (/^\s*(```|~~~)/m.test(head)) return true;
    if (/^\s*[-*+]\s+\S/m.test(head) && /\n/.test(head)) return true;
    if (/^\s*\d+[.)]\s+\S/m.test(head) && /\n/.test(head)) return true;
    return false;
  },
  import: importMarkdown,
  export: exportMarkdown,
};
