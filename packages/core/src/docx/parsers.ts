/**
 * Pure OOXML → model parsers for parts and property bags. The importer class in
 * `import.ts` composes these while walking the document body.
 */
import type {
  AbstractNum,
  BorderSet,
  ColumnSetup,
  DocDefaults,
  DocMetadata,
  DocSettings,
  ListLevel,
  NumberingDefs,
  NumInstance,
  PageSetup,
  ParagraphProps,
  RunProps,
  SectionBreakType,
  StyleDef,
  StyleSheet,
  TableProps,
  Theme,
  TocBlock,
} from "../model/types.js";
import {
  createDefaultNumbering,
  createDefaultStyles,
  DEFAULT_PAGE,
  DEFAULT_THEME,
} from "../model/create.js";
import {
  alignmentFromOoxml,
  boolAttr,
  emu,
  halfPoints,
  highlightToColor,
  matchPagePreset,
  normalizeColor,
  parseBorder,
  parseIntOrUndefined,
  twips,
  underlineFromOoxml,
  vertAlignFromOoxml,
} from "./ooxml.js";
import {
  NS,
  all,
  attr,
  childElements,
  first,
  localNameOf,
  onOff,
  parseXml,
  textOf,
  wAttr,
  wVal,
} from "./xml.js";
import type { Element } from "@xmldom/xmldom";

/* --------------------------------------------------------------- context */

export interface Relationship {
  id: string;
  type: string;
  target: string;
  mode: "Internal" | "External";
  /** Absolute package path for internal relationships. */
  resolvedPath?: string;
}

export type RelationshipMap = Map<string, Relationship>;

export interface ParseContext {
  theme: Theme;
  styles: StyleSheet;
  numbering: NumberingDefs;
  relationships: RelationshipMap;
  /** Part path of the XML currently being parsed (for relative relationship targets). */
  partPath: string;
}

/* ------------------------------------------------------------ helpers */

function resolvePartPath(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = sourcePart.split("/").slice(0, -1);
  const segments = target.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}

export function parseRelationships(
  xml: string | undefined,
  partPath: string,
): RelationshipMap {
  const map: RelationshipMap = new Map();
  if (!xml) return map;
  const doc = parseXml(xml, `${partPath} rels`);
  const relationships = all(doc.documentElement, NS.rel, "Relationship");
  for (const element of relationships) {
    const id = attr(element, null, "Id") ?? "";
    const type = attr(element, null, "Type") ?? "";
    const target = attr(element, null, "Target") ?? "";
    const mode =
      (attr(element, null, "TargetMode") ?? "Internal") === "External"
        ? "External"
        : "Internal";
    if (!id) continue;
    map.set(id, {
      id,
      type,
      target,
      mode,
      resolvedPath:
        mode === "External" ? undefined : resolvePartPath(partPath, target),
    });
  }
  return map;
}

export interface CoreProperties {
  title?: string;
  subject?: string;
  creator?: string;
  lastModifiedBy?: string;
  keywords?: string[];
  description?: string;
  category?: string;
  created?: string;
  modified?: string;
  revision?: string;
}

export function parseCoreProperties(xml: string | undefined): CoreProperties {
  if (!xml) return {};
  const doc = parseXml(xml, "core.xml");
  const root = doc.documentElement;
  const read = (ns: string, name: string): string | undefined => {
    const node = first(root, ns, name);
    const value = node ? textOf(node).trim() : "";
    return value ? value : undefined;
  };
  const keywords = read(NS.cp, "keywords") ?? read(NS.cp, "keywords");
  return {
    title: read(NS.dc, "title"),
    subject: read(NS.dc, "subject"),
    creator: read(NS.dc, "creator"),
    lastModifiedBy: read(NS.cp, "lastModifiedBy"),
    keywords: keywords ? keywords.split(/[,;]\s*/).filter(Boolean) : undefined,
    description: read(NS.dc, "description"),
    category: read(NS.cp, "category"),
    created: read(NS.dcterms, "created"),
    modified: read(NS.dcterms, "modified"),
    revision: read(NS.cp, "revision"),
  };
}

export function parseAppProperties(
  xml: string | undefined,
): Record<string, string> {
  if (!xml) return {};
  const doc = parseXml(xml, "app.xml");
  const out: Record<string, string> = {};
  for (const element of childElements(doc.documentElement)) {
    const name = localNameOf(element);
    const value = textOf(element).trim();
    if (value) out[name] = value;
  }
  return out;
}

export function metadataFromParts(
  core: CoreProperties,
  app: Record<string, string>,
): DocMetadata {
  return {
    title: core.title,
    subject: core.subject,
    creator: core.creator,
    lastModifiedBy: core.lastModifiedBy,
    keywords: core.keywords ?? [],
    description: core.description,
    category: core.category,
    created: core.created,
    modified: core.modified,
    revision: core.revision,
    custom: {},
    app,
  };
}

/* ---------------------------------------------------------------- theme */

export function parseTheme(xml: string | undefined): Theme {
  const theme = structuredClone(DEFAULT_THEME);
  if (!xml) return theme;
  try {
    const doc = parseXml(xml, "theme");
    const root = doc.documentElement;
    const scheme = first(root, NS.a, "themeElements");
    const fontScheme = first(scheme, NS.a, "fontScheme");
    for (const kind of ["majorFont", "minorFont"] as const) {
      const fontNode = first(fontScheme, NS.a, kind);
      if (!fontNode) continue;
      const latin = attr(first(fontNode, NS.a, "latin"), null, "typeface");
      const ea = attr(first(fontNode, NS.a, "ea"), null, "typeface");
      const cs = attr(first(fontNode, NS.a, "cs"), null, "typeface");
      const key = kind === "majorFont" ? "major" : "minor";
      theme.fonts[key] = {
        latin: latin && latin.trim() ? latin : theme.fonts[key].latin,
        eastAsia: ea && ea.trim() ? ea : theme.fonts[key].eastAsia,
        complexScript: cs && cs.trim() ? cs : theme.fonts[key].complexScript,
      };
    }
    const clrScheme = first(scheme, NS.a, "clrScheme");
    if (clrScheme) {
      for (const entry of childElements(clrScheme)) {
        const name = localNameOf(entry);
        const srgb = attr(first(entry, NS.a, "srgbClr"), null, "val");
        const sys = attr(first(entry, NS.a, "sysClr"), null, "lastClr");
        const value = normalizeColor(srgb ?? sys);
        if (value) theme.colors[name] = value;
      }
    }
    const name = attr(root, null, "name");
    if (name) theme.name = name;
  } catch {
    // A malformed theme is not fatal: defaults keep rendering deterministic.
  }
  return theme;
}

/* ----------------------------------------------------------------- fonts */

const THEME_FONT_REFS: Record<string, string> = {
  "+mn-lt": "minor.latin",
  "+mn-ea": "minor.eastAsia",
  "+mn-cs": "minor.complexScript",
  "+mj-lt": "major.latin",
  "+mj-ea": "major.eastAsia",
  "+mj-cs": "major.complexScript",
};

function resolveThemeFont(reference: string, theme: Theme): string | undefined {
  const mapped = THEME_FONT_REFS[reference];
  if (!mapped) return undefined;
  const [kind, script] = mapped.split(".") as [
    "major" | "minor",
    "latin" | "eastAsia" | "complexScript",
  ];
  return theme.fonts[kind]?.[script];
}

export interface FontSelection {
  latin?: string;
  eastAsia?: string;
  complexScript?: string;
}

export function parseFonts(
  rFonts: Element | undefined,
  theme: Theme,
): FontSelection {
  if (!rFonts) return {};
  const pick = (name: string): string | undefined => {
    const value = wAttr(rFonts, name);
    if (!value) return undefined;
    return resolveThemeFont(value, theme) ?? value;
  };
  return {
    latin: pick("ascii") ?? pick("hAnsi"),
    eastAsia: pick("eastAsia"),
    complexScript: pick("cs"),
  };
}

/* ------------------------------------------------------------ run props */

export function parseRunProps(
  rPr: Element | undefined,
  context: { theme: Theme },
): RunProps {
  if (!rPr) return {};
  const props: RunProps = {};
  const fonts = parseFonts(first(rPr, NS.w, "rFonts"), context.theme);
  if (fonts.latin) props.fontFamily = fonts.latin;
  if (fonts.eastAsia) props.fontFamilyEastAsia = fonts.eastAsia;
  if (fonts.complexScript) props.fontFamilyComplexScript = fonts.complexScript;

  const size = halfPoints(parseIntOrUndefined(wVal(first(rPr, NS.w, "sz"))));
  if (size !== undefined) props.fontSize = size;
  const bold = onOff(first(rPr, NS.w, "b"));
  if (bold !== undefined) props.bold = bold;
  const italic = onOff(first(rPr, NS.w, "i"));
  if (italic !== undefined) props.italic = italic;
  const underlineNode = first(rPr, NS.w, "u");
  if (underlineNode) {
    const style = underlineFromOoxml(wVal(underlineNode) ?? "single");
    if (style !== undefined) props.underline = style;
    const color = normalizeColor(wAttr(underlineNode, "color"));
    if (color) props.underlineColor = color;
  }
  const strike = onOff(first(rPr, NS.w, "strike"));
  if (strike !== undefined) props.strike = strike;
  const dstrike = onOff(first(rPr, NS.w, "dstrike"));
  if (dstrike !== undefined) props.doubleStrike = dstrike;
  const outline = onOff(first(rPr, NS.w, "outline"));
  if (outline !== undefined) props.outline = outline;
  const shadow = onOff(first(rPr, NS.w, "shadow"));
  if (shadow !== undefined) props.shadow = shadow;
  const emboss = onOff(first(rPr, NS.w, "emboss"));
  if (emboss !== undefined) props.emboss = emboss;
  const imprint = onOff(first(rPr, NS.w, "imprint"));
  if (imprint !== undefined) props.imprint = imprint;
  const vertAlign = vertAlignFromOoxml(wVal(first(rPr, NS.w, "vertAlign")));
  if (vertAlign) props.vertAlign = vertAlign;
  const color = normalizeColor(wVal(first(rPr, NS.w, "color")));
  if (color) props.color = color;
  const highlight = highlightToColor(wVal(first(rPr, NS.w, "highlight")));
  if (highlight) props.highlight = highlight;
  const shading = first(rPr, NS.w, "shd");
  const background = normalizeColor(wAttr(shading, "fill"));
  if (background) props.background = background;
  const spacing = twips(parseIntOrUndefined(wVal(first(rPr, NS.w, "spacing"))));
  if (spacing !== undefined) props.charSpacing = spacing;
  const scale = parseIntOrUndefined(wVal(first(rPr, NS.w, "w")));
  if (scale !== undefined) props.charScale = scale;
  const kerning = halfPoints(
    parseIntOrUndefined(wVal(first(rPr, NS.w, "kern"))),
  );
  if (kerning !== undefined) props.kerning = kerning;
  const caps = onOff(first(rPr, NS.w, "caps"));
  if (caps !== undefined) props.caps = caps;
  const smallCaps = onOff(first(rPr, NS.w, "smallCaps"));
  if (smallCaps !== undefined) props.smallCaps = smallCaps;
  const rtl = onOff(first(rPr, NS.w, "rtl"));
  if (rtl !== undefined) props.rtl = rtl;
  const vanish = onOff(first(rPr, NS.w, "vanish"));
  if (vanish !== undefined) props.hidden = vanish;
  const webHidden = onOff(first(rPr, NS.w, "webHidden"));
  if (webHidden !== undefined) props.webHidden = webHidden;
  const specVanish = onOff(first(rPr, NS.w, "specVanish"));
  if (specVanish !== undefined) props.specVanish = specVanish;
  const lang = first(rPr, NS.w, "lang");
  if (lang) {
    const val = wVal(lang);
    if (val) props.language = val;
    const eastAsia = wAttr(lang, "eastAsia");
    if (eastAsia) props.languageEastAsia = eastAsia;
    const bidi = wAttr(lang, "bidi");
    if (bidi) props.languageBidi = bidi;
  }
  const rStyle = wVal(first(rPr, NS.w, "rStyle"));
  if (rStyle) props.characterStyle = rStyle;
  return props;
}

/* ------------------------------------------------------ paragraph props */

export function parseTabs(
  pPr: Element,
  context: ParseContext,
): ParagraphProps["tabStops"] {
  const tabs = first(pPr, NS.w, "tabs");
  if (!tabs) return undefined;
  const stops = all(tabs, NS.w, "tab")
    .map((tab) => {
      const position = twips(parseIntOrUndefined(wVal(tab)));
      if (position === undefined) return undefined;
      const alignment = (
        wVal(tab) === undefined ? wAttr(tab, "val") : wAttr(tab, "val")
      ) as string | undefined;
      const value = (alignment ?? "left") as
        "left" | "center" | "right" | "decimal" | "bar" | "clear" | "num";
      const leader = wAttr(tab, "leader") as
        | "none"
        | "dot"
        | "hyphen"
        | "underscore"
        | "heavy"
        | "middleDot"
        | undefined;
      return { position, alignment: value, leader };
    })
    .filter(Boolean) as NonNullable<ParagraphProps["tabStops"]>;
  void context;
  return stops.length > 0 ? stops : undefined;
}

export function parseParagraphProps(
  pPr: Element | undefined,
  context: ParseContext,
): ParagraphProps {
  if (!pPr) return {};
  const props: ParagraphProps = {};
  const alignment = alignmentFromOoxml(wVal(first(pPr, NS.w, "jc")));
  if (alignment) props.alignment = alignment;

  const spacing = first(pPr, NS.w, "spacing");
  if (spacing) {
    const before = twips(parseIntOrUndefined(wAttr(spacing, "before")));
    if (before !== undefined) props.spaceBefore = before;
    const after = twips(parseIntOrUndefined(wAttr(spacing, "after")));
    if (after !== undefined) props.spaceAfter = after;
    const line = parseIntOrUndefined(wAttr(spacing, "line"));
    const rule = wAttr(spacing, "lineRule") ?? "auto";
    if (line !== undefined) {
      if (rule === "exact")
        props.lineSpacing = { rule: "exact", value: twips(line) ?? line };
      else if (rule === "atLeast")
        props.lineSpacing = { rule: "atLeast", value: twips(line) ?? line };
      else props.lineSpacing = { rule: "auto", value: line / 240 };
    }
    const beforeAuto = boolAttr(wAttr(spacing, "beforeAutospacing"));
    if (beforeAuto !== undefined) props.beforeAutospacing = beforeAuto;
    const afterAuto = boolAttr(wAttr(spacing, "afterAutospacing"));
    if (afterAuto !== undefined) props.afterAutospacing = afterAuto;
  }

  const ind = first(pPr, NS.w, "ind");
  if (ind) {
    const indent: NonNullable<ParagraphProps["indent"]> = {};
    const left = twips(
      parseIntOrUndefined(wAttr(ind, "left") ?? wAttr(ind, "start")),
    );
    if (left !== undefined) indent.left = left;
    const right = twips(
      parseIntOrUndefined(wAttr(ind, "right") ?? wAttr(ind, "end")),
    );
    if (right !== undefined) indent.right = right;
    const firstLine = twips(parseIntOrUndefined(wAttr(ind, "firstLine")));
    if (firstLine !== undefined) indent.firstLine = firstLine;
    const hanging = twips(parseIntOrUndefined(wAttr(ind, "hanging")));
    if (hanging !== undefined) indent.hanging = hanging;
    const mirror = boolAttr(wAttr(ind, "mirrorIndents"));
    if (mirror !== undefined) indent.mirror = mirror;
    props.indent = indent;
  }

  const tabs = parseTabs(pPr, context);
  if (tabs) props.tabStops = tabs;

  const pBdr = first(pPr, NS.w, "pBdr");
  if (pBdr) {
    const borders: BorderSet = {};
    for (const name of [
      "top",
      "bottom",
      "left",
      "right",
      "between",
      "bar",
    ] as const) {
      const node = first(pBdr, NS.w, name);
      if (!node) continue;
      borders[name] = parseBorder(node, (key) => wAttr(node, key));
    }
    if (Object.keys(borders).length > 0) props.borders = borders;
  }

  const shd = first(pPr, NS.w, "shd");
  if (shd) {
    const fill = normalizeColor(wAttr(shd, "fill"));
    if (fill)
      props.shading = {
        fill,
        pattern: wAttr(shd, "val"),
        color: normalizeColor(wAttr(shd, "color")),
      };
  }

  const numPr = first(pPr, NS.w, "numPr");
  if (numPr) {
    const numId = wVal(first(numPr, NS.w, "numId"));
    const level = parseIntOrUndefined(wVal(first(numPr, NS.w, "ilvl")));
    if (numId !== undefined) {
      props.numbering = { numId, level: level ?? 0 };
    }
  }

  const keepNext = onOff(first(pPr, NS.w, "keepNext"));
  if (keepNext !== undefined) props.keepNext = keepNext;
  const keepLines = onOff(first(pPr, NS.w, "keepLines"));
  if (keepLines !== undefined) props.keepLines = keepLines;
  const widowControl = onOff(first(pPr, NS.w, "widowControl"));
  if (widowControl !== undefined) props.widowControl = widowControl;
  const pageBreakBefore = onOff(first(pPr, NS.w, "pageBreakBefore"));
  if (pageBreakBefore !== undefined) props.pageBreakBefore = pageBreakBefore;
  const outlineLevel = parseIntOrUndefined(
    wVal(first(pPr, NS.w, "outlineLvl")),
  );
  if (outlineLevel !== undefined) props.outlineLevel = outlineLevel;
  const bidi = onOff(first(pPr, NS.w, "bidi"));
  if (bidi !== undefined) props.bidi = bidi;
  const contextualSpacing = onOff(first(pPr, NS.w, "contextualSpacing"));
  if (contextualSpacing !== undefined)
    props.contextualSpacing = contextualSpacing;
  const snapToGrid = onOff(first(pPr, NS.w, "snapToGrid"));
  if (snapToGrid !== undefined) props.snapToGrid = snapToGrid;
  const suppressLineNumbers = onOff(first(pPr, NS.w, "suppressLineNumbers"));
  if (suppressLineNumbers !== undefined)
    props.suppressLineNumbers = suppressLineNumbers;
  const textDirection = wVal(first(pPr, NS.w, "textDirection"));
  if (textDirection)
    props.textDirection = textDirection as NonNullable<
      ParagraphProps["textDirection"]
    >;

  const framePr = first(pPr, NS.w, "framePr");
  if (framePr) {
    const width = twips(parseIntOrUndefined(wAttr(framePr, "w"))) ?? 0;
    const height = twips(parseIntOrUndefined(wAttr(framePr, "h"))) ?? 0;
    props.frame = {
      width,
      height,
      x: twips(parseIntOrUndefined(wAttr(framePr, "x"))) ?? 0,
      y: twips(parseIntOrUndefined(wAttr(framePr, "y"))) ?? 0,
      hAnchor: wAttr(framePr, "hAnchor") as
        "margin" | "page" | "text" | undefined,
      vAnchor: wAttr(framePr, "vAnchor") as
        "margin" | "page" | "text" | undefined,
      dropCap: wAttr(framePr, "dropCap") as
        "none" | "drop" | "margin" | undefined,
      lines: parseIntOrUndefined(wAttr(framePr, "lines")),
    };
  }

  return props;
}

/* -------------------------------------------------------------- styles */

function styleTypeFromOoxml(value: string | undefined): StyleDef["type"] {
  switch (value) {
    case "character":
      return "character";
    case "table":
      return "table";
    case "numbering":
      return "numbering";
    default:
      return "paragraph";
  }
}

export function parseStyles(
  xml: string | undefined,
  theme: Theme,
  numbering: NumberingDefs,
): StyleSheet {
  const sheet = createDefaultStyles();
  if (!xml) return sheet;
  const doc = parseXml(xml, "styles.xml");
  const root = doc.documentElement;
  const context: ParseContext = {
    theme,
    styles: sheet,
    numbering,
    relationships: new Map(),
    partPath: "word/styles.xml",
  };

  const docDefaults = first(root, NS.w, "docDefaults");
  if (docDefaults) {
    const defaults: DocDefaults = { ...sheet.defaults };
    const rPrDefault = first(docDefaults, NS.w, "rPrDefault");
    const runProps = parseRunProps(first(rPrDefault, NS.w, "rPr"), context);
    if (Object.keys(runProps).length > 0)
      defaults.run = { ...(sheet.defaults.run ?? {}), ...runProps };
    const pPrDefault = first(docDefaults, NS.w, "pPrDefault");
    const paragraphProps = parseParagraphProps(
      first(pPrDefault, NS.w, "pPr"),
      context,
    );
    if (Object.keys(paragraphProps).length > 0)
      defaults.paragraph = {
        ...(sheet.defaults.paragraph ?? {}),
        ...paragraphProps,
      };
    sheet.defaults = defaults;
  }

  const parsed = new Map<string, StyleDef>();
  for (const styleNode of all(root, NS.w, "style")) {
    const id = wAttr(styleNode, "styleId");
    if (!id) continue;
    const nameNode = first(styleNode, NS.w, "name");
    const style: StyleDef = {
      id,
      name: wVal(nameNode) ?? wAttr(styleNode, "styleId") ?? id,
      type: styleTypeFromOoxml(wAttr(styleNode, "type")),
      basedOn: wVal(first(styleNode, NS.w, "basedOn")),
      next: wVal(first(styleNode, NS.w, "next")),
      link: wVal(first(styleNode, NS.w, "link")),
      isDefault: boolAttr(wAttr(styleNode, "default")) ?? false,
      qFormat: onOff(first(styleNode, NS.w, "qFormat")),
      uiPriority: parseIntOrUndefined(
        wVal(first(styleNode, NS.w, "uiPriority")),
      ),
      semiHidden: onOff(first(styleNode, NS.w, "semiHidden")),
    };
    const pPr = first(styleNode, NS.w, "pPr");
    if (pPr) {
      const props = parseParagraphProps(pPr, context);
      if (Object.keys(props).length > 0) style.paragraph = props;
    }
    const rPr = first(styleNode, NS.w, "rPr");
    if (rPr) {
      const props = parseRunProps(rPr, context);
      if (Object.keys(props).length > 0) style.run = props;
    }
    if (style.type === "table") {
      const tblPr = first(styleNode, NS.w, "tblPr");
      if (tblPr) {
        const tableProps: NonNullable<StyleDef["table"]> = {};
        const tblBorders = first(tblPr, NS.w, "tblBorders");
        if (tblBorders) {
          const borders: BorderSet = {};
          for (const side of [
            "top",
            "left",
            "bottom",
            "right",
            "insideH",
            "insideV",
          ] as const) {
            const node = first(tblBorders, NS.w, side);
            if (!node) continue;
            const key =
              side === "insideH" || side === "insideV" ? "between" : side;
            borders[key] = parseBorder(node, (name) => wAttr(node, name));
          }
          tableProps.borders = borders;
        }
        const cellMar = first(tblPr, NS.w, "tblCellMar");
        if (cellMar) {
          tableProps.cellMargins = parseCellMargins(cellMar);
        }
        const shd = first(tblPr, NS.w, "shd");
        const fill = normalizeColor(wAttr(shd, "fill"));
        if (fill) tableProps.shading = { fill };
        style.table = tableProps;
      }
      // Conditional formats (first row banding etc.) are preserved minimally.
      const conditional: NonNullable<
        NonNullable<StyleDef["table"]>["conditional"]
      > = {};
      for (const cond of all(styleNode, NS.w, "tblStylePr")) {
        const type = wAttr(cond, "type");
        if (!type) continue;
        const entry: NonNullable<(typeof conditional)[string]> = {};
        const condPr = first(cond, NS.w, "rPr");
        if (condPr) entry.run = parseRunProps(condPr, context);
        const condPpr = first(cond, NS.w, "pPr");
        if (condPpr) entry.paragraph = parseParagraphProps(condPpr, context);
        const condShd = normalizeColor(wAttr(first(cond, NS.w, "shd"), "fill"));
        if (condShd) entry.shading = { fill: condShd };
        conditional[type] = entry;
      }
      if (Object.keys(conditional).length > 0) {
        style.table = { ...(style.table ?? {}), conditional };
      }
    }
    parsed.set(id, style);
  }

  // Merge parsed styles over the built-in defaults: documents often reference
  // built-in styles they do not redefine (Heading4..9, ListBullet2, ...).
  for (const [id, style] of parsed) sheet.styles[id] = style;
  return sheet;
}

export function parseCellMargins(
  node: Element | undefined,
): { top: number; right: number; bottom: number; left: number } | undefined {
  if (!node) return undefined;
  const read = (name: string): number =>
    twips(parseIntOrUndefined(wAttr(first(node, NS.w, name), "w"))) ?? 0;
  const margins = {
    top: read("top"),
    right: read("right"),
    bottom: read("bottom"),
    left: read("left"),
  };
  return margins;
}

/* ----------------------------------------------------------- numbering */

export function parseNumbering(xml: string | undefined): NumberingDefs {
  const result = createDefaultNumbering();
  if (!xml) return result;
  const doc = parseXml(xml, "numbering.xml");
  const root = doc.documentElement;
  const abstract: Record<string, AbstractNum> = {};
  const nums: Record<string, NumInstance> = {};

  for (const abstractNode of all(root, NS.w, "abstractNum")) {
    const id = wAttr(abstractNode, "abstractNumId");
    if (!id) continue;
    const levels: ListLevel[] = [];
    for (const lvlNode of all(abstractNode, NS.w, "lvl")) {
      const level = parseIntOrUndefined(wAttr(lvlNode, "ilvl")) ?? 0;
      const pPr = first(lvlNode, NS.w, "pPr");
      const pStyle = wVal(first(lvlNode, NS.w, "pStyle"));
      const numFmt = wVal(first(lvlNode, NS.w, "numFmt")) ?? "decimal";
      const start =
        parseIntOrUndefined(wVal(first(lvlNode, NS.w, "start"))) ?? 1;
      const lvlText = wVal(first(lvlNode, NS.w, "lvlText")) ?? "";
      const lvlJc = (wVal(first(lvlNode, NS.w, "lvlJc")) ??
        "left") as ListLevel["lvlJc"];
      const suff = wVal(first(lvlNode, NS.w, "suff")) as ListLevel["suff"];
      const restartAfter = parseIntOrUndefined(
        wVal(first(lvlNode, NS.w, "lvlRestart")),
      );
      const isLegal = onOff(first(lvlNode, NS.w, "isLgl"));
      const pictureBulletId = wVal(first(lvlNode, NS.w, "lvlPicBulletId"));
      const context: ParseContext = {
        theme: DEFAULT_THEME,
        styles: createDefaultStyles(),
        numbering: result,
        relationships: new Map(),
        partPath: "word/numbering.xml",
      };
      const paragraph = pPr ? parseParagraphProps(pPr, context) : undefined;
      const run = parseRunProps(first(lvlNode, NS.w, "rPr"), context);
      levels.push({
        level,
        start,
        numFmt,
        lvlText,
        lvlJc,
        suff: suff ?? "tab",
        pStyle,
        paragraph,
        run: Object.keys(run).length > 0 ? run : undefined,
        restartAfter,
        isLegal,
        pictureBulletId,
      });
    }
    abstract[id] = {
      id,
      multiLevelType: wVal(
        first(abstractNode, NS.w, "multiLevelType"),
      ) as AbstractNum["multiLevelType"],
      levels,
    };
  }

  for (const numNode of all(root, NS.w, "num")) {
    const id = wAttr(numNode, "numId");
    if (!id) continue;
    const abstractId = wVal(first(numNode, NS.w, "abstractNumId")) ?? "";
    const instance: NumInstance = { id, abstractId };
    const overrides: NonNullable<NumInstance["levelOverrides"]> = {};
    for (const overrideNode of all(numNode, NS.w, "lvlOverride")) {
      const level = parseIntOrUndefined(wAttr(overrideNode, "ilvl")) ?? 0;
      const startOverride = parseIntOrUndefined(
        wVal(first(overrideNode, NS.w, "startOverride")),
      );
      const lvlNode = first(overrideNode, NS.w, "lvl");
      const patch: NonNullable<(typeof overrides)[number]> = {};
      if (startOverride !== undefined) patch.start = startOverride;
      if (lvlNode) {
        const numFmt = wVal(first(lvlNode, NS.w, "numFmt"));
        if (numFmt) patch.numFmt = numFmt;
        const lvlText = wVal(first(lvlNode, NS.w, "lvlText"));
        if (lvlText !== undefined) patch.lvlText = lvlText;
      }
      overrides[level] = patch;
    }
    if (Object.keys(overrides).length > 0) instance.levelOverrides = overrides;
    nums[id] = instance;
  }

  // Documents without numbering definitions keep the built-in defaults.
  if (Object.keys(abstract).length > 0) result.abstract = abstract;
  if (Object.keys(nums).length > 0) result.nums = nums;
  return result;
}

/* ------------------------------------------------------------ settings */

export function parseSettings(xml: string | undefined): DocSettings {
  const settings: DocSettings = {
    defaultTabStop: 36,
    evenAndOddHeaders: false,
    trackRevisions: false,
    autoHyphenation: false,
  };
  if (!xml) return settings;
  const doc = parseXml(xml, "settings.xml");
  const root = doc.documentElement;
  const tabStop = twips(
    parseIntOrUndefined(wVal(first(root, NS.w, "defaultTabStop"))),
  );
  if (tabStop !== undefined) settings.defaultTabStop = tabStop;
  settings.evenAndOddHeaders =
    onOff(first(root, NS.w, "evenAndOddHeaders")) ?? false;
  settings.trackRevisions = onOff(first(root, NS.w, "trackChanges")) ?? false;
  settings.autoHyphenation =
    onOff(first(root, NS.w, "autoHyphenation")) ?? false;
  const themeLang = first(root, NS.w, "themeFontLang");
  const language = themeLang
    ? (wAttr(themeLang, "val") ?? undefined)
    : undefined;
  if (language) settings.defaultLanguage = language;
  const compat = first(root, NS.w, "compat");
  if (compat) {
    for (const setting of all(compat, NS.w, "compatSetting")) {
      if (wAttr(setting, "name") === "compatibilityMode") {
        settings.compatibilityMode = wVal(setting);
      }
    }
  }
  return settings;
}

/* ------------------------------------------------------------- sectPr */

export interface SectionSkeleton {
  page: PageSetup;
  columns: ColumnSetup;
  pageNumbering?: PageSetup extends never
    ? never
    : { start?: number; format?: string };
  titlePage: boolean;
  evenAndOdd: boolean;
  headerRids: Partial<Record<"default" | "first" | "even", string>>;
  footerRids: Partial<Record<"default" | "first" | "even", string>>;
  breakBefore: SectionBreakType;
  footnoteRestart?: "continuous" | "eachSect" | "eachPage";
  endnoteRestart?: "continuous" | "eachSect" | "eachPage";
}

export function parseSectionProperties(
  sectPr: Element | undefined,
): SectionSkeleton {
  const page: PageSetup = {
    ...DEFAULT_PAGE,
    margins: { ...DEFAULT_PAGE.margins },
  };
  const skeleton: SectionSkeleton = {
    page,
    columns: { count: 1, space: 36, equalWidth: true },
    titlePage: false,
    evenAndOdd: false,
    headerRids: {},
    footerRids: {},
    breakBefore: "nextPage",
  };
  if (!sectPr) return skeleton;

  const pgSz = first(sectPr, NS.w, "pgSz");
  if (pgSz) {
    const width = parseIntOrUndefined(wAttr(pgSz, "w"));
    const height = parseIntOrUndefined(wAttr(pgSz, "h"));
    const orientation = wAttr(pgSz, "orient");
    if (width !== undefined && height !== undefined) {
      page.width = twips(width) ?? page.width;
      page.height = twips(height) ?? page.height;
      page.orientation =
        orientation === "landscape" || page.width > page.height
          ? "landscape"
          : "portrait";
      if (page.orientation === "portrait" && page.width > page.height) {
        const swap = page.width;
        page.width = page.height;
        page.height = swap;
      }
      page.preset = matchPagePreset(page.width, page.height);
    }
  }

  const pgMar = first(sectPr, NS.w, "pgMar");
  if (pgMar) {
    const read = (name: string, fallback: number): number =>
      twips(parseIntOrUndefined(wAttr(pgMar, name))) ?? fallback;
    page.margins = {
      top: read("top", page.margins.top),
      right: read("right", page.margins.right),
      bottom: read("bottom", page.margins.bottom),
      left: read("left", page.margins.left),
      header: read("header", page.margins.header),
      footer: read("footer", page.margins.footer),
      gutter: read("gutter", 0),
    };
  }

  const pgBorders = first(sectPr, NS.w, "pgBorders");
  if (pgBorders) {
    const borders: NonNullable<PageSetup["borders"]> = {};
    for (const side of ["top", "left", "bottom", "right"] as const) {
      const node = first(pgBorders, NS.w, side);
      if (!node) continue;
      borders[side] = parseBorder(node, (name) => wAttr(node, name));
    }
    const offsetFrom = wAttr(pgBorders, "offsetFrom") as
      "page" | "text" | undefined;
    const display = wAttr(pgBorders, "display") as NonNullable<
      PageSetup["borders"]
    >["display"];
    const zOrder = wAttr(pgBorders, "zOrder") as "front" | "back" | undefined;
    if (offsetFrom) borders.offsetFrom = offsetFrom;
    if (display) borders.display = display;
    if (zOrder) borders.zOrder = zOrder;
    if (Object.keys(borders).length > 0) page.borders = borders;
  }

  const cols = first(sectPr, NS.w, "cols");
  if (cols) {
    const count = parseIntOrUndefined(wAttr(cols, "num")) ?? 1;
    const space = twips(parseIntOrUndefined(wAttr(cols, "space"))) ?? 36;
    const equalWidth = boolAttr(wAttr(cols, "equalWidth")) ?? true;
    const separator = boolAttr(wAttr(cols, "sep")) ?? false;
    const widths = all(cols, NS.w, "col")
      .map((col) => twips(parseIntOrUndefined(wAttr(col, "w"))))
      .filter((value): value is number => value !== undefined);
    skeleton.columns = {
      count,
      space,
      equalWidth,
      separator,
      widths: widths.length ? widths : undefined,
    };
  }

  const pgNumType = first(sectPr, NS.w, "pgNumType");
  if (pgNumType) {
    const start = parseIntOrUndefined(wAttr(pgNumType, "start"));
    const format = wAttr(pgNumType, "fmt");
    skeleton.pageNumbering = { start, format };
  }

  skeleton.titlePage = onOff(first(sectPr, NS.w, "titlePg")) ?? false;
  skeleton.evenAndOdd =
    onOff(first(sectPr, NS.w, "evenAndOddHeaders")) ?? false;
  const type = wVal(first(sectPr, NS.w, "type"));
  if (type) skeleton.breakBefore = mapSectionBreak(type);

  for (const reference of all(sectPr, NS.w, "headerReference")) {
    const kind = wAttr(reference, "type") as
      "default" | "first" | "even" | undefined;
    const rid = attr(reference, NS.r, "id");
    if (kind && rid) skeleton.headerRids[kind] = rid;
  }
  for (const reference of all(sectPr, NS.w, "footerReference")) {
    const kind = wAttr(reference, "type") as
      "default" | "first" | "even" | undefined;
    const rid = attr(reference, NS.r, "id");
    if (kind && rid) skeleton.footerRids[kind] = rid;
  }

  const footnotePr = first(sectPr, NS.w, "footnotePr");
  if (footnotePr) {
    const restart = wVal(first(footnotePr, NS.w, "numRestart"));
    if (restart) skeleton.footnoteRestart = mapRestart(restart);
  }
  const endnotePr = first(sectPr, NS.w, "endnotePr");
  if (endnotePr) {
    const restart = wVal(first(endnotePr, NS.w, "numRestart"));
    if (restart) skeleton.endnoteRestart = mapRestart(restart);
  }

  return skeleton;
}

function mapSectionBreak(value: string): SectionBreakType {
  switch (value) {
    case "continuous":
      return "continuous";
    case "evenPage":
      return "evenPage";
    case "oddPage":
      return "oddPage";
    default:
      return "nextPage";
  }
}

function mapRestart(value: string): "continuous" | "eachSect" | "eachPage" {
  if (value === "eachSect") return "eachSect";
  if (value === "eachPage") return "eachPage";
  return "continuous";
}

/* ------------------------------------------------------------- tables */

export interface ParsedTableProperties {
  props: TableProps;
  grid: number[];
}

export function parseTableProperties(tbl: Element): ParsedTableProperties {
  const props: TableProps = { alignment: "left" };
  const tblPr = first(tbl, NS.w, "tblPr");
  if (tblPr) {
    const style = wVal(first(tblPr, NS.w, "tblStyle"));
    if (style) props.style = style;
    const alignment = alignmentFromOoxml(wVal(first(tblPr, NS.w, "jc")));
    if (alignment === "left" || alignment === "center" || alignment === "right")
      props.alignment = alignment;
    const tblW = first(tblPr, NS.w, "tblW");
    if (tblW) {
      const type = (wAttr(tblW, "type") ?? "auto") as "auto" | "dxa" | "pct";
      const value = parseIntOrUndefined(wAttr(tblW, "w"));
      if (value !== undefined) {
        if (type === "pct") props.width = { value: value / 50, type: "pct" };
        else if (type === "dxa")
          props.width = { value: twips(value) ?? 0, type: "dxa" };
        else props.width = { value: twips(value) ?? 0, type: "auto" };
      }
    }
    const layout = wVal(first(tblPr, NS.w, "tblLayout"));
    if (layout === "fixed" || layout === "autofit") props.layout = layout;
    const indent = twips(
      parseIntOrUndefined(wAttr(first(tblPr, NS.w, "tblInd"), "w")),
    );
    if (indent !== undefined) props.indent = indent;
    const tblBorders = first(tblPr, NS.w, "tblBorders");
    if (tblBorders) {
      const borders: BorderSet = {};
      for (const side of [
        "top",
        "left",
        "bottom",
        "right",
        "insideH",
        "insideV",
      ] as const) {
        const node = first(tblBorders, NS.w, side);
        if (!node) continue;
        const key = side === "insideH" || side === "insideV" ? "between" : side;
        borders[key] = parseBorder(node, (name) => wAttr(node, name));
      }
      if (Object.keys(borders).length > 0) props.borders = borders;
    }
    const cellSpacing = twips(
      parseIntOrUndefined(wAttr(first(tblPr, NS.w, "tblCellSpacing"), "w")),
    );
    if (cellSpacing !== undefined) props.cellSpacing = cellSpacing;
    const cellMar = parseCellMargins(first(tblPr, NS.w, "tblCellMar"));
    if (cellMar) props.cellMargins = cellMar;
    const shd = first(tblPr, NS.w, "shd");
    const fill = normalizeColor(wAttr(shd, "fill"));
    if (fill) props.shading = { fill };
    const tblpPr = first(tblPr, NS.w, "tblpPr");
    if (tblpPr) {
      props.floating = {
        x: {
          offset: twips(parseIntOrUndefined(wAttr(tblpPr, "tblpX"))) ?? 0,
          relativeTo: "page",
        },
        y: {
          offset: twips(parseIntOrUndefined(wAttr(tblpPr, "tblpY"))) ?? 0,
          relativeTo: "page",
        },
      };
    }
    const tblLook = first(tblPr, NS.w, "tblLook");
    if (tblLook) {
      props.look = {
        firstRow: boolAttr(wAttr(tblLook, "firstRow")),
        lastRow: boolAttr(wAttr(tblLook, "lastRow")),
        firstColumn: boolAttr(wAttr(tblLook, "firstColumn")),
        lastColumn: boolAttr(wAttr(tblLook, "lastColumn")),
        noHBand: boolAttr(wAttr(tblLook, "noHBand")),
        noVBand: boolAttr(wAttr(tblLook, "noVBand")),
      };
    }
  }

  const grid: number[] = [];
  const tblGrid = first(tbl, NS.w, "tblGrid");
  if (tblGrid) {
    for (const col of all(tblGrid, NS.w, "gridCol")) {
      const value = twips(parseIntOrUndefined(wAttr(col, "w")));
      if (value !== undefined) grid.push(value);
    }
  }

  return { props, grid };
}

export function parseTableStyle(
  doc: StyleSheet,
  styleId: string | undefined,
): NonNullable<StyleDef["table"]> | undefined {
  if (!styleId) return undefined;
  const chain: StyleDef[] = [];
  let current = styleId;
  let guard = 0;
  while (current && guard < 32) {
    const style = doc.styles[current];
    if (!style) break;
    chain.unshift(style);
    current = style.basedOn ?? "";
    guard += 1;
  }
  if (chain.length === 0) return undefined;
  const merged: NonNullable<StyleDef["table"]> = {};
  for (const style of chain) {
    if (!style.table) continue;
    if (style.table.borders)
      merged.borders = { ...(merged.borders ?? {}), ...style.table.borders };
    if (style.table.cellMargins)
      merged.cellMargins = {
        ...(merged.cellMargins ?? {}),
        ...style.table.cellMargins,
      };
    if (style.table.shading) merged.shading = style.table.shading;
    if (style.table.conditional)
      merged.conditional = {
        ...(merged.conditional ?? {}),
        ...style.table.conditional,
      };
  }
  return merged;
}

/* ------------------------------------------------------------------ TOC */

export function tocFromInstruction(instruction: string): TocBlock | undefined {
  const normalized = instruction.trim();
  if (!/^TOC\b/i.test(normalized)) return undefined;
  const levelMatch = /\\o\s+"?(\d)-(\d)"?/.exec(normalized);
  const minLevel = levelMatch ? Number(levelMatch[1]) : 1;
  const maxLevel = levelMatch ? Number(levelMatch[2]) : 3;
  const hyperlinks = /\\h\b/.test(normalized);
  const tabLeader = /\\n\b/.test(normalized) ? "none" : "dot";
  return {
    type: "toc",
    id: "",
    minLevel,
    maxLevel,
    hyperlinks,
    pageNumbers: true,
    tabLeader,
    instruction: normalized,
  };
}

export function emuToPtValue(value: number | undefined): number | undefined {
  return emu(value);
}
