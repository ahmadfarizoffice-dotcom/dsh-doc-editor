import { DOCUMENT_SCHEMA_VERSION } from "./types.js";
import type {
  AbstractNum,
  DocDocument,
  ListLevel,
  NumInstance,
  NumberingDefs,
  PageSetup,
  RunProps,
  StyleDef,
  StyleSheet,
  Theme,
} from "./types.js";

export const DEFAULT_THEME: Theme = {
  name: "Office",
  fonts: {
    major: {
      latin: "Calibri Light",
      eastAsia: "MS Gothic",
      complexScript: "Arial",
    },
    minor: { latin: "Calibri", eastAsia: "MS Gothic", complexScript: "Arial" },
  },
  colors: {
    dark1: "#000000",
    light1: "#ffffff",
    dark2: "#44546a",
    light2: "#e7e6e6",
    accent1: "#4472c4",
    accent2: "#ed7d31",
    accent3: "#a5a5a5",
    accent4: "#ffc000",
    accent5: "#5b9bd5",
    accent6: "#70ad47",
    hyperlink: "#0563c1",
    followedHyperlink: "#954f72",
  },
};

const BASE_RUN: RunProps = {
  fontFamily: "Calibri",
  fontSize: 11,
  language: "en-US",
};

/** A4 portrait, 1in margins, 0.5in header/footer - Word's international default. */
export const DEFAULT_PAGE: PageSetup = {
  width: 595.3,
  height: 841.9,
  orientation: "portrait",
  preset: "A4",
  margins: {
    top: 72,
    right: 72,
    bottom: 72,
    left: 72,
    header: 36,
    footer: 36,
    gutter: 0,
  },
};

export const PAGE_PRESETS: Record<
  string,
  { width: number; height: number; label: string }
> = {
  A3: { width: 841.9, height: 1190.6, label: "A3" },
  A4: { width: 595.3, height: 841.9, label: "A4" },
  A5: { width: 419.5, height: 595.3, label: "A5" },
  B5: { width: 498.9, height: 708.7, label: "B5 (JIS)" },
  Letter: { width: 612, height: 792, label: "Letter" },
  Legal: { width: 612, height: 1008, label: "Legal" },
  Tabloid: { width: 792, height: 1224, label: "Tabloid" },
  Executive: { width: 522, height: 756, label: "Executive" },
};

function paragraphStyle(
  id: string,
  name: string,
  opts: Partial<StyleDef> & {
    paragraph?: StyleDef["paragraph"];
    run?: RunProps;
  },
): StyleDef {
  return {
    id,
    name,
    type: "paragraph",
    qFormat: true,
    ...opts,
  };
}

/** Word-compatible built-in style sheet used for new documents. */
export function createDefaultStyles(): StyleSheet {
  const styles: Record<string, StyleDef> = {
    Normal: {
      id: "Normal",
      name: "Normal",
      type: "paragraph",
      isDefault: true,
      qFormat: true,
      paragraph: { alignment: "left", widowControl: true, spaceAfter: 8 },
      run: { ...BASE_RUN },
    },
    DefaultParagraphFont: {
      id: "DefaultParagraphFont",
      name: "Default Paragraph Font",
      type: "character",
      isDefault: true,
      semiHidden: true,
    },
    Title: paragraphStyle("Title", "Title", {
      basedOn: "Normal",
      next: "Normal",
      run: { fontFamily: "Calibri Light", fontSize: 28, color: "#17365d" },
      paragraph: {
        alignment: "left",
        spaceAfter: 4,
        spaceBefore: 0,
        keepNext: true,
      },
      uiPriority: 10,
    }),
    Subtitle: paragraphStyle("Subtitle", "Subtitle", {
      basedOn: "Normal",
      next: "Normal",
      run: {
        fontFamily: "Calibri Light",
        fontSize: 15,
        color: "#4f81bd",
        italic: true,
      },
      paragraph: { spaceAfter: 8 },
      uiPriority: 11,
    }),
    Quote: paragraphStyle("Quote", "Quote", {
      basedOn: "Normal",
      next: "Normal",
      run: { italic: true, color: "#404040" },
      paragraph: { indent: { left: 36, right: 36 }, spaceAfter: 8 },
      uiPriority: 29,
    }),
    Caption: paragraphStyle("Caption", "caption", {
      basedOn: "Normal",
      next: "Normal",
      run: {
        fontFamily: "Calibri",
        fontSize: 9,
        italic: true,
        color: "#44546a",
      },
      paragraph: { alignment: "left", spaceAfter: 10 },
      uiPriority: 35,
    }),
    Header: paragraphStyle("Header", "header", {
      basedOn: "Normal",
      run: { fontSize: 9, color: "#595959" },
      paragraph: {
        alignment: "left",
        tabStops: [
          { position: 468, alignment: "center" },
          { position: 936, alignment: "right" },
        ],
      },
      semiHidden: true,
    }),
    Footer: paragraphStyle("Footer", "footer", {
      basedOn: "Normal",
      run: { fontSize: 9, color: "#595959" },
      paragraph: {
        alignment: "left",
        tabStops: [
          { position: 468, alignment: "center" },
          { position: 936, alignment: "right" },
        ],
      },
      semiHidden: true,
    }),
    ListBullet: paragraphStyle("ListBullet", "List Bullet", {
      basedOn: "Normal",
      next: "ListBullet",
      paragraph: {
        spaceAfter: 0,
        indent: { left: 36, hanging: 18 },
        numbering: { numId: "1", level: 0 },
      },
      uiPriority: 99,
    }),
    ListNumber: paragraphStyle("ListNumber", "List Number", {
      basedOn: "Normal",
      next: "ListNumber",
      paragraph: {
        spaceAfter: 0,
        indent: { left: 36, hanging: 18 },
        numbering: { numId: "2", level: 0 },
      },
      uiPriority: 99,
    }),
    TableGrid: {
      id: "TableGrid",
      name: "Table Grid",
      type: "table",
      qFormat: true,
      table: {
        borders: {
          top: { style: "single", width: 0.5, color: "#000000" },
          bottom: { style: "single", width: 0.5, color: "#000000" },
          left: { style: "single", width: 0.5, color: "#000000" },
          right: { style: "single", width: 0.5, color: "#000000" },
          between: { style: "single", width: 0.5, color: "#000000" },
        },
        cellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 },
      },
    },
    Hyperlink: {
      id: "Hyperlink",
      name: "Hyperlink",
      type: "character",
      run: { color: "#0563c1", underline: "single" },
      semiHidden: true,
    },
    Strong: {
      id: "Strong",
      name: "Strong",
      type: "character",
      run: { bold: true },
      semiHidden: true,
    },
    Emphasis: {
      id: "Emphasis",
      name: "Emphasis",
      type: "character",
      run: { italic: true },
      semiHidden: true,
    },
  };

  for (let level = 1; level <= 9; level += 1) {
    const sizes = [16, 14, 12.5, 11, 11, 11, 11, 11, 11];
    styles[`Heading${level}`] = paragraphStyle(
      `Heading${level}`,
      `heading ${level}`,
      {
        basedOn: "Normal",
        next: "Normal",
        run: {
          fontFamily: "Calibri Light",
          fontSize: sizes[level - 1],
          color: "#2f5496",
          bold: level >= 4 ? true : false,
        },
        paragraph: {
          spaceBefore: level === 1 ? 24 : 12,
          spaceAfter: 4,
          keepNext: true,
          keepLines: true,
          outlineLevel: level - 1,
        },
        uiPriority: 9,
      },
    );
  }

  return {
    defaults: {
      run: { ...BASE_RUN },
      paragraph: { alignment: "left", spaceAfter: 0, widowControl: true },
      defaultTabStop: 36,
    },
    styles,
  };
}

function bulletLevel(level: number, glyph: string, left: number): ListLevel {
  return {
    level,
    start: 1,
    numFmt: "bullet",
    lvlText: glyph,
    lvlJc: "left",
    suff: "tab",
    paragraph: { indent: { left, hanging: 18 } },
    run: { fontFamily: "Symbol" },
  };
}

function decimalLevel(level: number, text: string, left: number): ListLevel {
  return {
    level,
    start: 1,
    numFmt: "decimal",
    lvlText: text,
    lvlJc: "left",
    suff: "tab",
    paragraph: { indent: { left, hanging: 18 } },
  };
}

export function createDefaultNumbering(): NumberingDefs {
  const bulletGlyphs = ["\u{F0B7}", "o", "\u{F0A7}"];
  const bulletLevels: ListLevel[] = [];
  for (let level = 0; level < 9; level += 1) {
    bulletLevels.push(
      bulletLevel(level, bulletGlyphs[level % 3], 36 + level * 36),
    );
  }
  const decimalLevels: ListLevel[] = [];
  for (let level = 0; level < 9; level += 1) {
    const text =
      ["%1.", "%1.%2.", "%1.%2.%3."][level % 3] +
      (level < 3 ? "" : `.${level + 1}.`);
    decimalLevels.push(decimalLevel(level, text, 36 + level * 36));
  }

  const abstract: Record<string, AbstractNum> = {
    "1": { id: "1", multiLevelType: "hybridMultilevel", levels: bulletLevels },
    "2": { id: "2", multiLevelType: "hybridMultilevel", levels: decimalLevels },
  };
  const nums: Record<string, NumInstance> = {
    "1": { id: "1", abstractId: "1" },
    "2": { id: "2", abstractId: "2" },
  };
  return { abstract, nums };
}

export interface CreateDocumentOptions {
  title?: string;
  author?: string;
  pageSize?: keyof typeof PAGE_PRESETS | { width: number; height: number };
  margins?: Partial<PageSetup["margins"]>;
  landscape?: boolean;
  /** Seed content: paragraph strings (empty string = blank paragraph). */
  paragraphs?: string[];
  language?: string;
  now?: Date;
}

/** Creates a new, empty document with Word-compatible defaults. */
export function createDocument(
  options: CreateDocumentOptions = {},
): DocDocument {
  const now = (options.now ?? new Date()).toISOString();
  const styles = createDefaultStyles();
  if (options.language) {
    styles.defaults.run = {
      ...styles.defaults.run,
      language: options.language,
    };
  }

  let page: PageSetup = {
    ...DEFAULT_PAGE,
    margins: { ...DEFAULT_PAGE.margins },
  };
  if (options.pageSize) {
    if (typeof options.pageSize === "string") {
      const preset = PAGE_PRESETS[options.pageSize];
      if (preset) {
        page = {
          ...page,
          width: preset.width,
          height: preset.height,
          preset: options.pageSize,
        };
      }
    } else {
      page = {
        ...page,
        width: options.pageSize.width,
        height: options.pageSize.height,
        preset: "custom",
      };
    }
  }
  if (options.landscape) {
    page = {
      ...page,
      orientation: "landscape",
      width: page.height,
      height: page.width,
    };
  }
  if (options.margins) {
    page = { ...page, margins: { ...page.margins, ...options.margins } };
  }

  const inlines = (options.paragraphs ?? [""]).map((text, index) =>
    text.length === 0 ? [] : [{ type: "text" as const, text, props: {} }],
  );
  void inlines;

  const doc: DocDocument = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: "doc-1",
    metadata: {
      title: options.title ?? "Untitled document",
      creator: options.author,
      lastModifiedBy: options.author,
      keywords: [],
      custom: {},
      created: now,
      modified: now,
      revision: "1",
    },
    theme: structuredClone(DEFAULT_THEME),
    styles,
    numbering: createDefaultNumbering(),
    sections: [
      {
        id: "s1",
        breakBefore: "nextPage",
        titlePage: false,
        evenAndOdd: false,
        page,
        columns: { count: 1, space: 36, equalWidth: true },
        headers: {},
        footers: {},
        blocks: (options.paragraphs ?? [""]).map((text, index) => ({
          type: "paragraph" as const,
          id: `p${index + 1}`,
          style: "Normal",
          props: {},
          inlines:
            text.length === 0
              ? []
              : [{ type: "text" as const, text, props: {} }],
        })),
      },
    ],
    footnotes: [],
    endnotes: [],
    comments: [],
    revisions: [],
    bookmarks: [],
    shapes: [],
    media: [],
    customXml: [],
    settings: {
      defaultTabStop: 36,
      evenAndOddHeaders: false,
      trackRevisions: false,
      autoHyphenation: false,
      defaultLanguage: options.language ?? "en-US",
      compatibilityMode: "15",
    },
    unknown: [],
    idSeq: (options.paragraphs ?? [""]).length,
  };
  return doc;
}
