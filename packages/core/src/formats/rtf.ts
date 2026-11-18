/**
 * RTF adapter.
 *
 * Import is a real group parser: it walks the RTF token stream with a state
 * stack, reads the font/colour/style/info tables, applies character formatting
 * (`\b \i \ul \strike \super \sub \fs \cf \cb \highlight`), paragraph formatting
 * (`\qc \qr \qj \li \fi \sa \sb`), handles `\uN` unicode escapes with their
 * `\ucN` fallback skip count, nested groups, `{\*\...}` destinations, HYPERLINK
 * fields, and the `\trowd/\cellx/\cell/\row` table model.
 *
 * Constructs this reader does not interpret (pictures, embedded objects,
 * headers/footers, footnote bodies, annotations) are skipped and reported as
 * losses — never silently dropped.
 */
import { computeNumbering } from "../model/numbering.js";
import {
  headingLevelOfStyle,
  resolveParagraphProps,
  resolveRunProps,
} from "../model/styles.js";
import { ptToTwips, twipsToPt } from "../model/types.js";
import type {
  Block,
  DocDocument,
  FeatureSupport,
  HyperlinkTarget,
  Inline,
  Paragraph,
  ParagraphProps,
  RunProps,
  Table,
} from "../model/types.js";
import {
  buildCompatibilityReport,
  buildTable,
  contentWidthPt,
  createDocumentContext,
  importResult,
  LossCollector,
  makeParagraph,
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

/* ------------------------------------------------------------ tokenizer */

type RtfToken =
  | { kind: "groupStart" }
  | { kind: "groupEnd" }
  | { kind: "text"; text: string }
  | { kind: "hex"; byte: number }
  | { kind: "control"; word: string; param?: number };

const MAX_TOKENS = 4_000_000;

function tokenizeRtf(source: string): RtfToken[] {
  const tokens: RtfToken[] = [];
  let text = "";
  let index = 0;
  const flushText = () => {
    if (text.length > 0) {
      tokens.push({ kind: "text", text });
      text = "";
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (char === "{") {
      flushText();
      tokens.push({ kind: "groupStart" });
      index += 1;
      continue;
    }
    if (char === "}") {
      flushText();
      tokens.push({ kind: "groupEnd" });
      index += 1;
      continue;
    }
    if (char === "\\") {
      flushText();
      const next = source[index + 1];
      if (next === undefined) break;
      if (next === "'") {
        const hex = source.slice(index + 2, index + 4);
        const byte = Number.parseInt(hex, 16);
        if (Number.isFinite(byte)) tokens.push({ kind: "hex", byte });
        index += 4;
        continue;
      }
      if (/[A-Za-z]/.test(next)) {
        let cursor = index + 1;
        let word = "";
        while (cursor < source.length && /[A-Za-z]/.test(source[cursor])) {
          word += source[cursor];
          cursor += 1;
        }
        let param: number | undefined;
        let negative = false;
        if (source[cursor] === "-") {
          negative = true;
          cursor += 1;
        }
        let digits = "";
        while (cursor < source.length && /[0-9]/.test(source[cursor])) {
          digits += source[cursor];
          cursor += 1;
        }
        if (digits.length > 0) {
          param = Number(digits) * (negative ? -1 : 1);
        }
        if (source[cursor] === " ") cursor += 1;
        tokens.push({ kind: "control", word: word.toLowerCase(), param });
        index = cursor;
        continue;
      }
      tokens.push({ kind: "control", word: next });
      index += 2;
      continue;
    }
    if (char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    text += char;
    index += 1;
    if (tokens.length > MAX_TOKENS) {
      throw new FormatError(
        "FORMAT_INVALID_INPUT",
        "RTF token stream exceeded the safety limit",
      );
    }
  }
  flushText();
  return tokens;
}

const CP1252_SPECIAL: Record<number, string> = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203A",
  0x9c: "\u0153",
  0x9e: "\u017E",
  0x9f: "\u0178",
};

function decodeCp1252(byte: number): string {
  const special = CP1252_SPECIAL[byte];
  if (special !== undefined) return special;
  return String.fromCharCode(byte);
}

/** Destinations whose entire group is skipped (and reported). */
const SKIPPED_DESTINATIONS = new Set([
  "pict",
  "object",
  "objdata",
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "listtable",
  "listoverridetable",
  "filetbl",
  "revtbl",
  "rsidtbl",
  "generator",
  "xmlnstbl",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "mathpr",
  "pgptbl",
  "pnseclvl",
  "fldtype",
  "bkmkstart",
  "bkmkend",
  "nonshppict",
  "shpinst",
  "shprslt",
  "wgrffmtfilter",
  "userprops",
  "annotation",
  "atnid",
  "atnauthor",
  "atndate",
  "atnref",
  "template",
  "docvar",
]);

interface RtfState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vertAlign: "baseline" | "superscript" | "subscript";
  fontSize: number;
  colorIndex: number;
  backgroundIndex: number;
  highlightIndex: number;
  fontIndex: number;
  hidden: boolean;
  /** Paragraph state. */
  alignment: "left" | "center" | "right" | "justify";
  indentLeftTwips: number;
  firstLineTwips: number;
  spaceBeforeTwips: number;
  spaceAfterTwips: number;
  styleIndex: number;
  inTable: boolean;
  ucSkip: number;
}

function defaultState(): RtfState {
  return {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    vertAlign: "baseline",
    fontSize: 24,
    colorIndex: 0,
    backgroundIndex: 0,
    highlightIndex: 0,
    fontIndex: 0,
    hidden: false,
    alignment: "left",
    indentLeftTwips: 0,
    firstLineTwips: 0,
    spaceBeforeTwips: 0,
    spaceAfterTwips: 0,
    styleIndex: 0,
    inTable: false,
    ucSkip: 1,
  };
}

function cloneState(state: RtfState): RtfState {
  return { ...state };
}

interface TableCollector {
  rows: TableCellSpec[][];
  row: TableCellSpec[];
  cellBlocks: Block[];
  boundaries: number[];
}

class RtfReader {
  readonly losses = new LossCollector();
  readonly features = new Map<string, number>();
  private index = 0;
  private state = defaultState();
  readonly fonts = new Map<number, string>();
  colors: string[] = [];
  private styleNames = new Map<number, string>();
  readonly metadata: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
  } = {};
  private paragraph: { inlines: Inline[]; style: string } | undefined;
  private container: Block[];
  private table: TableCollector | undefined;
  private skipChars = 0;
  private linkProps: HyperlinkTarget | undefined;
  private readonly tokens: RtfToken[];

  constructor(
    private readonly ctx: DocumentContext,
    tokens: RtfToken[],
  ) {
    this.tokens = tokens;
    this.container = ctx.blocks;
  }

  private count(feature: string, amount = 1): void {
    this.features.set(feature, (this.features.get(feature) ?? 0) + amount);
  }

  read(): void {
    this.parseSequence(false, this.state);
    this.flushParagraph();
    this.closeTable();
  }

  /* ------------------------------------------------------------ parsing */

  private parseSequence(untilGroupEnd: boolean, state: RtfState): void {
    const previousState = this.state;
    this.state = state;
    try {
      this.parseSequenceBody(untilGroupEnd, state);
    } finally {
      this.state = previousState;
    }
  }

  private parseSequenceBody(untilGroupEnd: boolean, state: RtfState): void {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      switch (token.kind) {
        case "groupEnd":
          if (untilGroupEnd) return;
          continue;
        case "groupStart":
          this.parseGroup(state);
          continue;
        case "text":
          this.appendText(token.text, state);
          continue;
        case "hex":
          if (this.skipChars > 0) {
            this.skipChars -= 1;
            continue;
          }
          this.appendText(decodeCp1252(token.byte), state);
          continue;
        case "control":
          this.control(token.word, token.param, state);
          continue;
        default:
          continue;
      }
    }
  }

  private parseGroup(parentState: RtfState): void {
    // Peek the first meaningful token to detect a destination.
    const start = this.index;
    const first = this.tokens[start];
    if (!first) return;
    if (first.kind === "control" && first.word === "*") {
      const destination = this.tokens[start + 1];
      if (destination && destination.kind === "control") {
        this.losses.unsupported(
          `rtf.${destination.word}`,
          `RTF ignorable destination \\*\\${destination.word} is not interpreted`,
          undefined,
          false,
        );
      }
      this.index += 1;
      this.skipGroup();
      return;
    }
    if (first.kind === "control") {
      const word = first.word;
      if (word === "fonttbl") {
        this.index += 1;
        this.parseFontTable();
        return;
      }
      if (word === "colortbl") {
        this.index += 1;
        this.parseColorTable();
        return;
      }
      if (word === "info") {
        this.index += 1;
        this.parseInfo();
        return;
      }
      if (word === "stylesheet") {
        this.index += 1;
        this.parseStyleSheet();
        return;
      }
      if (word === "field") {
        this.index += 1;
        this.parseField(parentState);
        return;
      }
      if (SKIPPED_DESTINATIONS.has(word)) {
        this.index += 1;
        this.losses.unsupported(
          `rtf.${word}`,
          `RTF destination \\${word} is not interpreted`,
          undefined,
          false,
        );
        this.skipGroup();
        return;
      }
      if (word === "footnote") {
        this.index += 1;
        this.losses.partial(
          "footnote",
          "RTF footnote bodies are not imported; only the reference position is kept",
          undefined,
          false,
        );
        this.skipGroup();
        return;
      }
    }
    const child = cloneState(parentState);
    this.parseSequence(true, child);
  }

  private skipGroup(): void {
    let depth = 1;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.kind === "groupStart") depth += 1;
      else if (token.kind === "groupEnd") {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private control(
    word: string,
    param: number | undefined,
    state: RtfState,
  ): void {
    switch (word) {
      case "b":
        state.bold = param === undefined ? true : param !== 0;
        return;
      case "i":
        state.italic = param === undefined ? true : param !== 0;
        return;
      case "ul":
        state.underline = param === undefined ? true : param !== 0;
        return;
      case "ulnone":
        state.underline = false;
        return;
      case "strike":
        state.strike = param === undefined ? true : param !== 0;
        return;
      case "super":
        state.vertAlign = "superscript";
        return;
      case "sub":
        state.vertAlign = "subscript";
        return;
      case "nosupersub":
        state.vertAlign = "baseline";
        return;
      case "plain":
        state.bold = false;
        state.italic = false;
        state.underline = false;
        state.strike = false;
        state.vertAlign = "baseline";
        state.fontSize = 24;
        state.colorIndex = 0;
        state.backgroundIndex = 0;
        state.highlightIndex = 0;
        state.fontIndex = 0;
        state.hidden = false;
        return;
      case "fs":
        if (param !== undefined) state.fontSize = param;
        return;
      case "cf":
        if (param !== undefined) state.colorIndex = param;
        return;
      case "cb":
        if (param !== undefined) state.backgroundIndex = param;
        return;
      case "highlight":
        if (param !== undefined) state.highlightIndex = param;
        return;
      case "f":
        if (param !== undefined) state.fontIndex = param;
        return;
      case "v":
        state.hidden = param === undefined ? true : param !== 0;
        return;
      case "uc":
        if (param !== undefined) state.ucSkip = Math.max(0, Math.min(4, param));
        return;
      case "u":
        if (param !== undefined) {
          const code = param < 0 ? param + 65536 : param;
          this.appendText(String.fromCharCode(code), state);
          this.skipChars = state.ucSkip;
        }
        return;
      case "par":
      case "sect":
      case "pagebb":
        if (word === "sect") {
          this.count("section.break");
        }
        this.flushParagraph();
        return;
      case "page":
        this.flushParagraph();
        this.container.push(
          makeParagraph(this.ctx, [{ type: "break", kind: "page" }]),
        );
        this.count("pageBreak");
        return;
      case "line":
        this.currentInlines().push({ type: "break", kind: "line" });
        return;
      case "tab":
      case "cell":
      case "row":
        if (word === "tab") {
          this.currentInlines().push({ type: "tab" });
          return;
        }
        if (word === "cell") {
          this.finishCell();
          return;
        }
        this.finishRow();
        return;
      case "pard":
        state.alignment = "left";
        state.indentLeftTwips = 0;
        state.firstLineTwips = 0;
        state.spaceBeforeTwips = 0;
        state.spaceAfterTwips = 0;
        state.styleIndex = 0;
        state.inTable = false;
        return;
      case "ql":
        state.alignment = "left";
        return;
      case "qc":
        state.alignment = "center";
        return;
      case "qr":
        state.alignment = "right";
        return;
      case "qj":
        state.alignment = "justify";
        return;
      case "li":
        if (param !== undefined) state.indentLeftTwips = param;
        return;
      case "fi":
        if (param !== undefined) state.firstLineTwips = param;
        return;
      case "sb":
        if (param !== undefined) state.spaceBeforeTwips = param;
        return;
      case "sa":
        if (param !== undefined) state.spaceAfterTwips = param;
        return;
      case "s":
        if (param !== undefined) state.styleIndex = param;
        return;
      case "trowd":
        this.ensureTable();
        if (this.table) {
          this.table.row = [];
          this.table.cellBlocks = [];
          this.table.boundaries = [];
        }
        return;
      case "cellx":
        if (param !== undefined) {
          this.ensureTable();
          this.table?.boundaries.push(param);
        }
        return;
      case "intbl":
        this.ensureTable();
        state.inTable = true;
        return;
      case "nowidctlpar":
      case "widctlpar":
        return;
      case "bkmkstart":
      case "bkmkend":
        return;
      default:
        this.count(`rtf.control.${word}`);
        return;
    }
  }

  /* ----------------------------------------------------- table support */

  private ensureTable(): void {
    if (this.table) return;
    this.flushParagraph();
    this.table = { rows: [], row: [], cellBlocks: [], boundaries: [] };
    this.container = this.table.cellBlocks;
  }

  private finishCell(): void {
    this.closeTableParagraph();
    if (!this.table) return;
    this.table.row.push({
      blocks:
        this.table.cellBlocks.length > 0
          ? [...this.table.cellBlocks]
          : [makeParagraph(this.ctx, [])],
    });
    this.table.cellBlocks = [];
    this.container = this.table.cellBlocks;
    this.count("table.cells");
  }

  private finishRow(): void {
    this.closeTableParagraph();
    if (!this.table) return;
    if (this.table.row.length > 0) {
      this.table.rows.push(this.table.row);
      this.count("table.rows");
    }
    this.table.row = [];
    this.table.cellBlocks = [];
    this.container = this.table.cellBlocks;
  }

  private closeTableParagraph(): void {
    this.flushParagraph();
  }

  private closeTable(): void {
    const table = this.table;
    if (!table) return;
    this.flushParagraph();
    if (table.row.length > 0) table.rows.push(table.row);
    this.table = undefined;
    this.container = this.ctx.blocks;
    if (table.rows.length === 0) return;
    const columns = Math.max(...table.rows.map((row) => row.length), 1);
    const boundaries = table.boundaries.length > 0 ? table.boundaries : [];
    const widths: number[] = [];
    for (let index = 0; index < columns; index += 1) {
      const previous = index === 0 ? 0 : (boundaries[index - 1] ?? 0);
      const current = boundaries[index] ?? previous + 1440;
      widths.push(Math.max(12, twipsToPt(current - previous)));
    }
    const built: Table = buildTable(this.ctx, table.rows, {
      columns,
      columnWidths: widths,
    });
    this.ctx.blocks.push(built);
  }

  /* --------------------------------------------------------------- text */

  private appendText(text: string, state: RtfState): void {
    if (text.length === 0) return;
    let value = text;
    if (this.skipChars > 0) {
      if (value.length <= this.skipChars) {
        this.skipChars -= value.length;
        return;
      }
      value = value.slice(this.skipChars);
      this.skipChars = 0;
    }
    if (state.hidden) {
      this.losses.partial(
        "rtf.hidden",
        "Hidden RTF text was not imported",
        undefined,
        false,
      );
      return;
    }
    this.currentInlines().push(...this.textInline(value, state));
  }

  private textInline(text: string, state: RtfState): Inline[] {
    const props = this.runProps(state);
    const out: Inline[] = [];
    pushText(out, text, props);
    return out;
  }

  private runProps(state: RtfState): RunProps {
    const props: RunProps = {};
    if (state.bold) props.bold = true;
    if (state.italic) props.italic = true;
    if (state.underline) props.underline = "single";
    if (state.strike) props.strike = true;
    if (state.vertAlign !== "baseline") props.vertAlign = state.vertAlign;
    if (state.fontSize > 0) props.fontSize = state.fontSize / 2;
    const color =
      state.colorIndex === 0 ? undefined : this.colors[state.colorIndex];
    if (color) props.color = color;
    const background =
      state.backgroundIndex === 0
        ? undefined
        : this.colors[state.backgroundIndex];
    if (background) props.background = background;
    const highlight =
      state.highlightIndex === 0
        ? undefined
        : this.colors[state.highlightIndex];
    if (highlight) props.highlight = highlight;
    const font = this.fonts.get(state.fontIndex);
    if (font) props.fontFamily = font;
    if (this.linkProps) props.hyperlink = { ...this.linkProps };
    return props;
  }

  private currentInlines(): Inline[] {
    if (!this.paragraph) {
      this.paragraph = { inlines: [], style: this.paragraphStyle() };
    }
    return this.paragraph.inlines;
  }

  private paragraphStyle(): string {
    const state = this.state;
    const name = this.styleNames.get(state.styleIndex);
    if (!name) return "Normal";
    const match = /^heading\s*([1-9])$/i.exec(name.trim());
    if (match) return `Heading${match[1]}`;
    return "Normal";
  }

  private flushParagraph(): void {
    const paragraph = this.paragraph;
    this.paragraph = undefined;
    if (!paragraph) return;
    if (paragraph.inlines.length === 0) return;
    const state = this.state;
    const props: ParagraphProps = { alignment: state.alignment };
    if (state.indentLeftTwips > 0)
      props.indent = { left: twipsToPt(state.indentLeftTwips) };
    if (state.firstLineTwips !== 0) {
      props.indent = {
        ...(props.indent ?? {}),
        firstLine:
          state.firstLineTwips > 0
            ? twipsToPt(state.firstLineTwips)
            : undefined,
        hanging:
          state.firstLineTwips < 0
            ? twipsToPt(-state.firstLineTwips)
            : undefined,
      };
    }
    if (state.spaceBeforeTwips > 0)
      props.spaceBefore = twipsToPt(state.spaceBeforeTwips);
    if (state.spaceAfterTwips > 0)
      props.spaceAfter = twipsToPt(state.spaceAfterTwips);
    const style = paragraph.style;
    if (style.startsWith("Heading"))
      props.outlineLevel = Number(style.slice(7)) - 1;
    const target = this.table ? this.table.cellBlocks : this.container;
    target.push(makeParagraph(this.ctx, paragraph.inlines, { style, props }));
  }

  /* ---------------------------------------------------------- sub-parsers */

  private parseFontTable(): void {
    let depth = 1;
    let fontIndex = 0;
    let pieces: string[] = [];
    const commit = () => {
      if (fontIndex >= 0 && pieces.length > 0) {
        this.fonts.set(fontIndex, cleanFontName(pieces.join("")));
      }
      pieces = [];
    };
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.kind === "groupStart") {
        depth += 1;
        commit();
        continue;
      }
      if (token.kind === "groupEnd") {
        depth -= 1;
        commit();
        if (depth === 0) return;
        continue;
      }
      if (token.kind === "text") {
        pieces.push(token.text);
        continue;
      }
      if (token.kind === "control") {
        if (token.word === "f" && token.param !== undefined) {
          commit();
          fontIndex = token.param;
          continue;
        }
        // Font family/character set descriptors are not part of the name.
        if (
          ["froman", "fswiss", "fmodern", "fscript", "fdecor", "fnil", "fcharset", "fprq", "fbias", "cpg"].includes(
            token.word,
          )
        ) {
          continue;
        }
      }
    }
    commit();
  }

  private parseColorTable(): void {
    let depth = 1;
    let red = 0;
    let green = 0;
    let blue = 0;
    this.colors = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.kind === "groupStart") {
        depth += 1;
        continue;
      }
      if (token.kind === "groupEnd") {
        depth -= 1;
        if (depth === 0) return;
        continue;
      }
      if (token.kind === "control") {
        if (token.word === "red" && token.param !== undefined) red = token.param;
        else if (token.word === "green" && token.param !== undefined) green = token.param;
        else if (token.word === "blue" && token.param !== undefined) blue = token.param;
        continue;
      }
      if (token.kind === "text" && token.text.includes(";")) {
        this.colors.push(
          `#${clampByte(red).toString(16).padStart(2, "0")}${clampByte(green).toString(16).padStart(2, "0")}${clampByte(
            blue,
          )
            .toString(16)
            .padStart(2, "0")}`,
        );
        red = 0;
        green = 0;
        blue = 0;
      }
    }
  }

  private parseInfo(): void {
    let depth = 1;
    let key: string | null = null;
    let buffer = "";
    const commit = () => {
      const value = buffer.trim();
      buffer = "";
      if (!key || !value) return;
      if (key === "title") this.metadata.title = value;
      else if (key === "author") this.metadata.author = value;
      else if (key === "subject") this.metadata.subject = value;
      else if (key === "keywords") {
        this.metadata.keywords = value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
      }
    };
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.kind === "groupStart") {
        depth += 1;
        continue;
      }
      if (token.kind === "groupEnd") {
        depth -= 1;
        commit();
        if (depth === 0) return;
        continue;
      }
      if (token.kind === "text") {
        buffer += token.text;
        continue;
      }
      if (token.kind === "hex") {
        buffer += decodeCp1252(token.byte);
        continue;
      }
      commit();
      key = token.word;
    }
    commit();
  }

  private parseStyleSheet(): void {
    let depth = 1;
    let styleIndex = 0;
    let buffer = "";
    const commit = () => {
      const name = buffer.replace(/;.*$/, "").trim();
      if (name.length > 0) this.styleNames.set(styleIndex, name);
      buffer = "";
    };
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.kind === "groupStart") {
        depth += 1;
        commit();
        continue;
      }
      if (token.kind === "groupEnd") {
        depth -= 1;
        commit();
        if (depth === 0) return;
        continue;
      }
      if (token.kind === "text") {
        buffer += token.text;
        continue;
      }
      if (token.kind === "control" && token.word === "s" && token.param !== undefined) {
        commit();
        styleIndex = token.param;
        continue;
      }
    }
    commit();
  }

  /**
   * Parses `{\field{\*\fldinst ...}{\fldrslt ...}}`. HYPERLINK instructions are
   * applied as hyperlink marks; other field results are kept as plain text and
   * reported.
   */
  private parseField(parentState: RtfState): void {
    let instruction = "";
    let hasResult = false;
    const groupEnd = this.findGroupEnd(this.index - 2);
    while (this.index < groupEnd) {
      const token = this.tokens[this.index];
      if (token.kind === "groupStart") {
        this.index += 1;
        let first = this.tokens[this.index];
        // `{\*\fldinst ...}` and `{\*\fldrslt ...}` carry an ignorable-destination
        // marker before the destination name.
        if (first && first.kind === "control" && first.word === "*") {
          this.index += 1;
          first = this.tokens[this.index];
        }
        if (first && first.kind === "control" && first.word === "fldinst") {
          this.index += 1;
          instruction = this.captureGroupText();
          continue;
        }
        if (first && first.kind === "control" && first.word === "fldrslt") {
          this.index += 1;
          hasResult = true;
          const href = /HYPERLINK\s+"([^"]+)"/i.exec(instruction)?.[1];
          const previousLink = this.linkProps;
          if (href) {
            this.linkProps = {
              href,
              external: !href.startsWith("#"),
              anchor: href.startsWith("#") ? href.slice(1) : undefined,
            };
          }
          const child = cloneState(parentState);
          this.parseSequence(true, child);
          this.linkProps = previousLink;
          continue;
        }
        this.skipGroup();
        continue;
      }
      this.index += 1;
    }
    if (!hasResult) {
      this.losses.partial(
        "rtf.field",
        "RTF field without a cached result was ignored",
        instruction.slice(0, 80),
        false,
      );
    } else if (!/HYPERLINK/i.test(instruction)) {
      this.losses.partial(
        "fields",
        "Only HYPERLINK fields are interpreted; field results are kept as plain text",
        instruction.slice(0, 80),
        false,
      );
    } else {
      this.count("hyperlink");
    }
    if (this.tokens[this.index]?.kind === "groupEnd") this.index += 1;
  }

  private findGroupEnd(startIndex: number): number {
    let depth = 0;
    for (let index = startIndex; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      if (token.kind === "groupStart") depth += 1;
      else if (token.kind === "groupEnd") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return this.tokens.length;
  }

  private captureGroupText(): string {
    let out = "";
    let depth = 1;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.kind === "groupStart") {
        depth += 1;
        continue;
      }
      if (token.kind === "groupEnd") {
        depth -= 1;
        if (depth === 0) return out;
        continue;
      }
      if (token.kind === "text") out += token.text;
      else if (token.kind === "hex") out += decodeCp1252(token.byte);
      else if (token.kind === "control")
        out +=
          token.param !== undefined
            ? `${token.word}${token.param} `
            : `${token.word} `;
    }
    return out;
  }
}

function cleanFontName(raw: string): string {
  return raw.replace(/;.*$/, "").replace(/\s+/g, " ").trim();
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/* ---------------------------------------------------------------- import */

/**
 * Imports Rich Text Format into the document model.
 *
 * The parser is bounded and never throws on malformed input: unfinished groups
 * are closed implicitly and unknown destinations are skipped with a loss.
 */
export async function importRtf(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `RTF input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  const source = buffer.toString("latin1");
  if (!/^\s*\{\\rtf/i.test(source)) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "RTF input must start with {\\rtf",
    );
  }
  const tokens = tokenizeRtf(source);

  // The reader needs the metadata it discovers while parsing, so the document
  // context is created up front with a file-name fallback title and patched at
  // the end.
  const ctx = createDocumentContext({
    metadata: { title: titleFromFileName(options.fileName) },
  });
  const reader = new RtfReader(ctx, tokens);
  reader.read();
  const parsedMetadata = reader.metadata;
  if (parsedMetadata.title) ctx.doc.metadata.title = parsedMetadata.title;
  if (parsedMetadata.author) {
    ctx.doc.metadata.creator = parsedMetadata.author;
    ctx.doc.metadata.lastModifiedBy = parsedMetadata.author;
  }
  if (parsedMetadata.subject) ctx.doc.metadata.subject = parsedMetadata.subject;
  if (parsedMetadata.keywords)
    ctx.doc.metadata.keywords = parsedMetadata.keywords;

  ctx.syncIds();
  const doc = ctx.doc;

  const features: FeatureSupport[] = [
    {
      feature: "document.rtf",
      label: "Rich Text Format",
      level: "partial",
      occurrences: 1,
    },
    {
      feature: "document.metadata",
      label: "Document metadata (info group)",
      level: "full",
      occurrences: 1,
    },
    {
      feature: "rtf.fontTable",
      label: "Font table",
      level: "full",
      occurrences: reader.fonts.size,
    },
    {
      feature: "rtf.colorTable",
      label: "Colour table",
      level: "full",
      occurrences: reader.colors.length,
    },
  ];
  for (const [feature, occurrences] of reader.features) {
    features.push({
      feature,
      label: featureLabel(feature),
      level: "partial",
      occurrences,
    });
  }
  const losses = reader.losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "rtf",
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
    "lists.numbering": "Lists",
    table: "Tables",
    "table.rows": "Table rows",
    "table.cells": "Table cells",
    hyperlink: "Hyperlinks",
    pageBreak: "Page breaks",
    "section.break": "Section breaks",
    "rtf.hidden": "Hidden text",
    "rtf.field": "Fields",
    fields: "Fields",
    footnote: "Footnotes",
    "rtf.fontTable": "Font table",
    "rtf.colorTable": "Colour table",
  };
  return labels[feature] ?? feature;
}

/* --------------------------------------------------------------- exporter */

interface RtfExportState {
  fontTable: string[];
  fontIndex: Map<string, number>;
  colorTable: string[];
  colorIndex: Map<string, number>;
}

function colorIndexFor(
  state: RtfExportState,
  color: string | undefined,
): number {
  if (!color) return 0;
  const existing = state.colorIndex.get(color);
  if (existing !== undefined) return existing;
  state.colorTable.push(color);
  const index = state.colorTable.length; // 0 is reserved for "auto"
  state.colorIndex.set(color, index);
  return index;
}

function fontIndexFor(
  state: RtfExportState,
  family: string | undefined,
): number {
  const name = family && family.trim().length > 0 ? family.trim() : "Calibri";
  const existing = state.fontIndex.get(name);
  if (existing !== undefined) return existing;
  state.fontTable.push(name);
  const index = state.fontTable.length - 1;
  state.fontIndex.set(name, index);
  return index;
}

/** Encodes text for RTF: escapes specials and uses `\uN?` for non-ASCII. */
function encodeRtfText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === "{" || char === "}") {
      out += `\\${char}`;
    } else if (char === "\t") {
      out += "\\tab ";
    } else if (char === "\n") {
      out += "\\line ";
    } else if (code < 128) {
      out += char;
    } else if (code <= 255) {
      out += `\\'${code.toString(16).padStart(2, "0")}`;
    } else if (code <= 0xffff) {
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    } else {
      // Surrogate pair: emit both UTF-16 code units.
      const units = char.split("");
      for (const unit of units) {
        const unitCode = unit.charCodeAt(0);
        const signed = unitCode > 32767 ? unitCode - 65536 : unitCode;
        out += `\\u${signed}?`;
      }
    }
  }
  return out;
}

function exportRun(
  inline: Inline,
  doc: DocDocument,
  paragraph: Paragraph,
  state: RtfExportState,
): string {
  if (inline.type !== "text")
    return exportInline(inline, doc, paragraph, state);
  const props = resolveRunProps(doc, {
    paragraphStyle: paragraph.style,
    characterStyle: inline.props.characterStyle,
    direct: inline.props,
  });
  let open = "";
  let close = "";
  if (props.hyperlink && (props.hyperlink.href || props.hyperlink.anchor)) {
    const href = props.hyperlink.href ?? `#${props.hyperlink.anchor ?? ""}`;
    open += `{\\field{\\*\\fldinst HYPERLINK "${href.replace(/"/g, "")}"}{\\fldrslt `;
    close = `}}${close}`;
  }
  const font = fontIndexFor(state, props.fontFamily);
  if (font !== 0) open += `\\f${font} `;
  open += `\\fs${Math.max(2, Math.round((props.fontSize ?? 11) * 2))} `;
  if (props.bold) open += "\\b ";
  if (props.italic) open += "\\i ";
  if (props.underline) open += "\\ul ";
  if (props.strike || props.doubleStrike) open += "\\strike ";
  if (props.vertAlign === "superscript") open += "\\super ";
  else if (props.vertAlign === "subscript") open += "\\sub ";
  const color = colorIndexFor(state, props.color);
  if (color > 0) open += `\\cf${color} `;
  const background = colorIndexFor(state, props.background);
  if (background > 0) open += `\\cb${background} `;
  const highlight = colorIndexFor(state, props.highlight);
  if (highlight > 0) open += `\\highlight${highlight} `;
  return `${open}${encodeRtfText(inline.text)}${close}`;
}

function exportInline(
  inline: Inline,
  doc: DocDocument,
  paragraph: Paragraph,
  state: RtfExportState,
): string {
  switch (inline.type) {
    case "tab":
      return "\\tab ";
    case "break":
      return inline.kind === "page" ? "\\page " : "\\line ";
    case "image":
      // RTF \pict requires hex-encoded image data; keeping it out of the flow is
      // reported by the caller, and the alt text stays searchable.
      return inline.alt ? encodeRtfText(inline.alt) : "";
    case "field": {
      const text = (inline.result ?? [])
        .map((child) => exportInline(child, doc, paragraph, state))
        .join("");
      return text;
    }
    case "noteRef": {
      const notes = [...doc.footnotes, ...doc.endnotes];
      const note = notes.find((entry) => entry.id === inline.noteId);
      if (!note) return "";
      return `{\\footnote ${note.blocks
        .map((block) => exportBlocksInline(block, doc, state))
        .join("\\par ")}}`;
    }
    case "math":
      return encodeRtfText(inline.linear);
    case "shape":
      return "";
    case "unknown":
      return inline.text ? encodeRtfText(inline.text) : "";
    case "commentRef":
    case "bookmark":
      return "";
    default:
      return "";
  }
}

function exportBlocksInline(
  block: Block,
  doc: DocDocument,
  state: RtfExportState,
): string {
  if (block.type !== "paragraph") return "";
  return block.inlines
    .map((inline) => exportInline(inline, doc, block, state))
    .join("");
}

/**
 * Exports a document as RTF 1.9.
 *
 * Text, character formatting, alignment, indents/spacing, hyperlinks, lists
 * (as literal bullet/number text), tables and footnotes are emitted. Images,
 * comments, tracked-change marks and page setup beyond paper size/margins are
 * reported as losses.
 */
export async function exportRtf(
  doc: DocDocument,
  options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  const losses = new LossCollector();
  const state: RtfExportState = {
    fontTable: [],
    fontIndex: new Map(),
    colorTable: [],
    colorIndex: new Map(),
  };
  fontIndexFor(state, doc.styles.defaults.run?.fontFamily ?? "Calibri");
  colorIndexFor(state, undefined);

  const body: string[] = [];
  const numbering = computeNumbering(doc);
  let imageCount = 0;
  let commentCount = 0;
  let revisionCount = 0;
  let tocCount = 0;
  let tableCount = 0;
  let numberingCount = 0;
  const shapeCount = doc.shapes.length;

  const page = doc.sections[0]?.page;
  const sectionHeader = page
    ? `\\paperw${Math.round(ptToTwips(page.width))}\\paperh${Math.round(ptToTwips(page.height))}\\margl${Math.round(
        ptToTwips(page.margins.left),
      )}\\margr${Math.round(ptToTwips(page.margins.right))}\\margt${Math.round(ptToTwips(page.margins.top))}\\margb${Math.round(
        ptToTwips(page.margins.bottom),
      )}`
    : "";

  doc.sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) {
      body.push("\\sect\\sectd");
      losses.partial(
        "sectionBreak",
        "All sections share the first section's page geometry; later section breaks become plain section marks",
        `section[${sectionIndex}]`,
        false,
      );
    }
    for (const block of section.blocks) {
      if (block.type === "table") {
        tableCount += 1;
        body.push(...exportTable(block, doc, state, numbering));
        continue;
      }
      if (block.type === "toc") {
        tocCount += 1;
        continue;
      }
      const props = resolveParagraphProps(doc, block);
      const paragraphParts: string[] = ["\\pard"];
      if (props.alignment === "center") paragraphParts.push("\\qc");
      else if (props.alignment === "right") paragraphParts.push("\\qr");
      else if (props.alignment === "justify") paragraphParts.push("\\qj");
      if (props.indent?.left !== undefined)
        paragraphParts.push(`\\li${Math.round(ptToTwips(props.indent.left))}`);
      if (props.indent?.hanging !== undefined)
        paragraphParts.push(
          `\\fi-${Math.round(ptToTwips(props.indent.hanging))}`,
        );
      else if (props.indent?.firstLine !== undefined)
        paragraphParts.push(
          `\\fi${Math.round(ptToTwips(props.indent.firstLine))}`,
        );
      if (props.spaceBefore)
        paragraphParts.push(`\\sb${Math.round(ptToTwips(props.spaceBefore))}`);
      if (props.spaceAfter)
        paragraphParts.push(`\\sa${Math.round(ptToTwips(props.spaceAfter))}`);
      if (props.outlineLevel !== undefined)
        paragraphParts.push(`\\outlinelevel${props.outlineLevel}`);

      const label = numbering.labels.get(block.id);
      if (label) {
        numberingCount += 1;
        const separator =
          label.suffix === "nothing"
            ? ""
            : label.suffix === "space"
              ? " "
              : "\\tab ";
        paragraphParts.push(encodeRtfText(label.label));
        paragraphParts.push(separator);
      }
      for (const inline of block.inlines) {
        if (inline.type === "image") imageCount += 1;
        if (inline.type === "commentRef") commentCount += 1;
        if (inline.type === "text" && inline.props.revision) revisionCount += 1;
        paragraphParts.push(exportRun(inline, doc, block, state));
      }
      paragraphParts.push("\\par");
      body.push(paragraphParts.join(""));
    }
  });

  for (const comment of doc.comments) {
    body.push("\\pard");
    body.push(
      encodeRtfText(
        `[Comment by ${comment.author}${comment.resolved ? " (resolved)" : ""}] ${comment.blocks
          .map((entry) =>
            entry.type === "paragraph"
              ? entry.inlines
                  .map((inline) => (inline.type === "text" ? inline.text : ""))
                  .join("")
              : "",
          )
          .join(" ")
          .trim()}`,
      ),
    );
    body.push("\\par");
    commentCount += 1;
  }

  if (imageCount > 0) {
    losses.unsupported(
      "image",
      "Images are not hex-encoded into \\pict; only alt text is kept",
      undefined,
      false,
    );
  }
  if (commentCount > 0) {
    losses.partial(
      "comment",
      "Comments are appended as plain paragraphs; anchors and threading are lost",
      undefined,
      false,
    );
  }
  if (revisionCount > 0) {
    losses.unsupported(
      "revisions",
      "Tracked-change marks are not representable in this RTF writer",
      undefined,
      false,
    );
  }
  if (tocCount > 0) {
    losses.partial(
      "toc",
      "Table of contents is not emitted as an RTF field",
      undefined,
      false,
    );
  }
  if (numberingCount > 0) {
    losses.partial(
      "numbering",
      "List labels are emitted as literal text, not as RTF list definitions",
      undefined,
      false,
    );
  }
  if (tableCount > 0) {
    // Cell-level detail: markdown keeps it simple, tables are real RTF tables.
    losses.add({
      feature: "table.cellSpacing",
      level: "partial",
      reason: "Cell margins and borders are approximated by RTF table defaults",
      preserved: false,
    });
  }
  if (shapeCount > 0) {
    losses.fallback(
      "shape",
      "Text boxes and shapes are not emitted as RTF shapes",
      undefined,
      false,
    );
  }
  if (doc.sections.length > 1) {
    losses.partial(
      "pageLayout.multiSection",
      "Only the first section's page geometry is exported",
      undefined,
      false,
    );
  }
  void options;

  const infoParts: string[] = [];
  if (doc.metadata.title)
    infoParts.push(`{\\title ${encodeRtfText(doc.metadata.title)}}`);
  if (doc.metadata.creator)
    infoParts.push(`{\\author ${encodeRtfText(doc.metadata.creator)}}`);
  if (doc.metadata.subject)
    infoParts.push(`{\\subject ${encodeRtfText(doc.metadata.subject)}}`);
  if (doc.metadata.keywords.length > 0)
    infoParts.push(
      `{\\keywords ${encodeRtfText(doc.metadata.keywords.join(", "))}}`,
    );
  if (doc.metadata.description)
    infoParts.push(`{\\doccomm ${encodeRtfText(doc.metadata.description)}}`);

  const fontTable = `{\\fonttbl${state.fontTable
    .map(
      (name, index) => `{\\f${index}\\fnil\\fcharset0 ${encodeRtfText(name)};}`,
    )
    .join("")}}`;
  const colorTable = `{\\colortbl;${state.colorTable
    .filter((color) => color.length > 0)
    .map((color) => colorToRtf(color))
    .join(";")};}`;

  const rtf = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1",
    fontTable,
    colorTable,
    infoParts.length > 0 ? `{\\info${infoParts.join("")}}` : "",
    sectionHeader,
    "\\viewkind4",
    body.join("\n"),
    "}",
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    buffer: Buffer.from(rtf, "latin1"),
    warnings: [],
    losses: losses.all(),
  };
}

function colorToRtf(color: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!match) return "";
  const value = Number.parseInt(match[1], 16);
  return `\\red${(value >> 16) & 0xff}\\green${(value >> 8) & 0xff}\\blue${value & 0xff}`;
}

function exportTable(
  table: Table,
  doc: DocDocument,
  state: RtfExportState,
  numbering: ReturnType<typeof computeNumbering>,
): string[] {
  const out: string[] = [];
  const widths = table.grid.length > 0 ? table.grid : [contentWidthPt(doc)];
  let boundary = 0;
  const boundaries: number[] = widths.map((width) => {
    boundary += width;
    return Math.round(ptToTwips(boundary));
  });
  for (const row of table.rows) {
    const rowParts: string[] = ["\\trowd\\trgaph108"];
    for (const cellBoundary of boundaries)
      rowParts.push(`\\cellx${cellBoundary}`);
    for (const cell of row.cells) {
      const paragraph = cell.blocks.find(
        (block): block is Paragraph => block.type === "paragraph",
      );
      if (paragraph) {
        const label = numbering.labels.get(paragraph.id);
        if (label) rowParts.push(encodeRtfText(label.label), " ");
        for (const inline of paragraph.inlines)
          rowParts.push(exportRun(inline, doc, paragraph, state));
      }
      rowParts.push("\\cell");
    }
    rowParts.push("\\row");
    out.push(rowParts.join(""));
  }
  return out;
}

/* ------------------------------------------------------------- descriptor */

const CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: true,
  styles: "partial",
  tables: "partial",
  images: "none",
  hyperlinks: "partial",
  headersFooters: "none",
  pageLayout: "partial",
  numbering: "partial",
  metadata: "partial",
  comments: "none",
  trackedChanges: "none",
  math: "none",
  notes: [
    "Character and paragraph formatting, tables and HYPERLINK fields are imported.",
    "Pictures, embedded objects, headers/footers and footnote bodies are reported as losses.",
    "Export writes list labels as literal text and cannot encode images.",
  ],
};

const RTF_EXTENSIONS = ["rtf"];

/** RTF format descriptor. */
export const rtfAdapter: FormatAdapter = {
  id: "rtf",
  label: "Rich Text Format (RTF)",
  extensions: RTF_EXTENSIONS,
  mimeTypes: ["application/rtf", "text/rtf"],
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    if (
      fileName &&
      RTF_EXTENSIONS.includes(
        (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] ?? "").toLowerCase(),
      )
    )
      return true;
    const prefix = bytes
      .subarray(0, Math.min(bytes.length, 512))
      .toString("latin1")
      .replace(/^\s+/, "");
    return /^\{\\rtf/i.test(prefix);
  },
  import: importRtf,
  export: exportRtf,
};