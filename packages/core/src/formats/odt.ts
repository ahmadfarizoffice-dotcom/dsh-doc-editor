/**
 * OpenDocument Text (ODT) adapter.
 *
 * Import reads the package with `readPackage` and maps `content.xml` onto the
 * model: `text:h` → headings, `text:p`/`text:span`/`text:a` → paragraphs and
 * runs (with automatic-style formatting), `text:list` → numbering, tables with
 * spans and covered cells, `draw:frame`/`draw:image` → media assets,
 * `office:annotation` → comments, `text:note` → footnotes, and `meta.xml` /
 * `styles.xml` → metadata, styles and page layout.
 *
 * Export writes a valid ODF 1.2 package (stored `mimetype` first, manifest,
 * content, styles, meta) preserving the model's core features, so ODT and DOCX
 * convert both ways without going through HTML.
 */
import JSZip from "jszip";
import { readPackage } from "../docx/package.js";
import { addImageInline } from "./shared.js";
import {
  attr,
  childElements,
  descendants,
  first,
  localNameOf,
  parseXml,
  textOf,
} from "../docx/xml.js";
import type { Element } from "@xmldom/xmldom";
import { createListDefinition } from "../model/edit.js";
import { DEFAULT_PAGE } from "../model/create.js";
import { resolveRunProps } from "../model/styles.js";
import type {
  Block,
  Border,
  DocComment,
  DocDocument,
  FeatureSupport,
  HyperlinkTarget,
  ImageInline,
  Inline,
  Note,
  PageSetup,
  Paragraph,
  ParagraphProps,
  RunProps,
  Section,
  StyleDef,
  Table,
  TableCell,
} from "../model/types.js";
import {
  buildCompatibilityReport,
  buildTable,
  contentWidthPt,
  createDocumentContext,
  createSection,
  cssLengthToPt,
  importResult,
  LossCollector,
  makeParagraph,
  mergeRun,
  pushText,
  stableStringify,
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

/* ----------------------------------------------------------- namespaces */

const ODF = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  meta: "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
  dc: "http://purl.org/dc/elements/1.1/",
  xlink: "http://www.w3.org/1999/xlink",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
  manifest: "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
  number: "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
} as const;

const MIMETYPE = "application/vnd.oasis.opendocument.text";

function odfAttr(
  node: Element | null | undefined,
  ns: string,
  name: string,
): string | undefined {
  return attr(node, ns, name);
}

/** ODF encodes spaces in style names as `_20_`. */
function decodeOdfName(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/_([0-9A-Fa-f]{2})_/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function headingStyleId(name: string | undefined): string | undefined {
  const match = /^heading\s*([1-9])$/i.exec((name ?? "").trim());
  return match ? `Heading${match[1]}` : undefined;
}

function styleIdFromName(name: string | undefined): string {
  const decoded = decodeOdfName(name);
  const heading = headingStyleId(decoded);
  if (heading) return heading;
  if (/^standard$/i.test(decoded) || /^normal$/i.test(decoded)) return "Normal";
  return decoded.length > 0 ? decoded : "Normal";
}

/* ---------------------------------------------------------- style parse */

function parseTextProperties(element: Element | undefined): RunProps {
  const props: RunProps = {};
  if (!element) return props;
  const fontName = odfAttr(element, ODF.style, "font-name");
  if (fontName) props.fontFamily = decodeOdfName(fontName);
  const fontSize = odfAttr(element, ODF.fo, "font-size");
  if (fontSize) {
    const points = cssLengthToPt(fontSize);
    if (points !== undefined) props.fontSize = points;
  }
  const weight = odfAttr(element, ODF.fo, "font-weight");
  if (weight) props.bold = /bold|[6-9]00/i.test(weight);
  const style = odfAttr(element, ODF.fo, "font-style");
  if (style) props.italic = /italic|oblique/i.test(style);
  const color = odfAttr(element, ODF.fo, "color");
  if (color) props.color = color.startsWith("#") ? color.toLowerCase() : color;
  const background = odfAttr(element, ODF.fo, "background-color");
  if (background && background !== "transparent")
    props.background = background.toLowerCase();
  const underline = odfAttr(element, ODF.style, "text-underline-style");
  if (underline && underline !== "none") props.underline = "single";
  const strike = odfAttr(element, ODF.style, "text-line-through-style");
  if (strike && strike !== "none") props.strike = true;
  const position = odfAttr(element, ODF.style, "text-position");
  if (position) {
    if (/super/i.test(position)) props.vertAlign = "superscript";
    else if (/sub/i.test(position)) props.vertAlign = "subscript";
  }
  const transform = odfAttr(element, ODF.fo, "text-transform");
  if (transform === "uppercase") props.caps = true;
  const spacing = odfAttr(element, ODF.fo, "letter-spacing");
  if (spacing) {
    const points = cssLengthToPt(spacing);
    if (points !== undefined) props.charSpacing = points;
  }
  const display = odfAttr(element, ODF.text, "display");
  if (display === "none") props.hidden = true;
  return props;
}

function parseParagraphProperties(
  element: Element | undefined,
): ParagraphProps {
  const props: ParagraphProps = {};
  if (!element) return props;
  const align = odfAttr(element, ODF.fo, "text-align");
  if (align) {
    const value = align.toLowerCase();
    if (value === "center") props.alignment = "center";
    else if (value === "end" || value === "right") props.alignment = "right";
    else if (value === "justify") props.alignment = "justify";
    else if (value === "start" || value === "left") props.alignment = "left";
  }
  const marginLeft = cssLengthToPt(odfAttr(element, ODF.fo, "margin-left"));
  const marginRight = cssLengthToPt(odfAttr(element, ODF.fo, "margin-right"));
  const textIndent = cssLengthToPt(odfAttr(element, ODF.fo, "text-indent"));
  const indent: NonNullable<ParagraphProps["indent"]> = {};
  if (marginLeft !== undefined) indent.left = marginLeft;
  if (marginRight !== undefined) indent.right = marginRight;
  if (textIndent !== undefined) {
    if (textIndent < 0) indent.hanging = Math.abs(textIndent);
    else indent.firstLine = textIndent;
  }
  if (Object.keys(indent).length > 0) props.indent = indent;
  const marginTop = cssLengthToPt(odfAttr(element, ODF.fo, "margin-top"));
  const marginBottom = cssLengthToPt(odfAttr(element, ODF.fo, "margin-bottom"));
  if (marginTop !== undefined) props.spaceBefore = marginTop;
  if (marginBottom !== undefined) props.spaceAfter = marginBottom;
  const lineHeight = odfAttr(element, ODF.fo, "line-height");
  if (lineHeight && lineHeight !== "normal") {
    if (lineHeight.endsWith("%")) {
      const percent = Number.parseFloat(lineHeight);
      if (Number.isFinite(percent))
        props.lineSpacing = { rule: "auto", value: (percent / 100) * 240 };
    } else {
      const points = cssLengthToPt(lineHeight);
      if (points !== undefined)
        props.lineSpacing = { rule: "exact", value: points };
    }
  }
  if (odfAttr(element, ODF.fo, "break-before") === "page")
    props.pageBreakBefore = true;
  if (odfAttr(element, ODF.fo, "keep-with-next") === "always")
    props.keepNext = true;
  const borderBottom = odfAttr(element, ODF.fo, "border-bottom");
  if (borderBottom && borderBottom !== "none") {
    const parsed = parseOdfBorder(borderBottom);
    if (parsed) props.borders = { bottom: parsed };
  }
  return props;
}

function parseOdfBorder(value: string): Border | undefined {
  const match =
    /^\s*([\d.]+)\s*(pt|cm|mm|in)?\s+(solid|dashed|dotted|double)\s+(#[0-9a-fA-F]{6})/i.exec(
      value,
    );
  if (!match) return undefined;
  const width = cssLengthToPt(`${match[1]}${match[2] ?? "pt"}`) ?? 0.5;
  const style = match[3].toLowerCase();
  const borderStyle: Border["style"] =
    style === "dashed"
      ? "dashed"
      : style === "dotted"
        ? "dotted"
        : style === "double"
          ? "double"
          : "single";
  return { style: borderStyle, width, color: match[4].toLowerCase() };
}

/* ---------------------------------------------------------------- import */

interface OdtStyles {
  run: Map<string, RunProps>;
  paragraph: Map<string, ParagraphProps>;
  columnWidth: Map<string, number>;
  cell: Map<
    string,
    { background?: string; vAlign?: "top" | "center" | "bottom" }
  >;
  page?: PageSetup;
  listKind: Map<string, "bullet" | "number">;
}

function collectAutomaticStyles(
  root: Element | undefined,
  styles: OdtStyles,
): void {
  if (!root) return;
  const containers = [root, ...descendantsNamed(root, "automatic-styles")];
  for (const container of containers) {
    for (const style of childElements(container)) {
      if (localNameOf(style) !== "style") continue;
      const name = odfAttr(style, ODF.style, "name");
      if (!name) continue;
      const family = odfAttr(style, ODF.style, "family");
      const textProps = childElements(style).find(
        (child) => localNameOf(child) === "text-properties",
      );
      const paragraphProps = childElements(style).find(
        (child) => localNameOf(child) === "paragraph-properties",
      );
      const columnProps = childElements(style).find(
        (child) => localNameOf(child) === "table-column-properties",
      );
      const cellProps = childElements(style).find(
        (child) => localNameOf(child) === "table-cell-properties",
      );
      if (family === "text" && textProps)
        styles.run.set(name, parseTextProperties(textProps));
      if (family === "paragraph") {
        styles.paragraph.set(name, parseParagraphProperties(paragraphProps));
        const runProps = parseTextProperties(textProps);
        if (Object.keys(runProps).length > 0) styles.run.set(name, runProps);
      }
      if (family === "table-column" && columnProps) {
        const width = cssLengthToPt(
          odfAttr(columnProps, ODF.style, "column-width"),
        );
        if (width !== undefined) styles.columnWidth.set(name, width);
      }
      if (family === "table-cell") {
        const background = odfAttr(cellProps, ODF.fo, "background-color");
        const vertical = odfAttr(cellProps, ODF.style, "vertical-align");
        styles.cell.set(name, {
          background:
            background && background !== "transparent"
              ? background.toLowerCase()
              : undefined,
          vAlign:
            vertical === "middle"
              ? "center"
              : vertical === "bottom"
                ? "bottom"
                : vertical === "top"
                  ? "top"
                  : undefined,
        });
      }
    }
  }
  for (const listStyle of descendantsNamed(root, "list-style")) {
    const name = odfAttr(listStyle, ODF.style, "name");
    if (!name) continue;
    const hasNumber = childElements(listStyle).some(
      (child) => localNameOf(child) === "list-level-style-number",
    );
    const hasBullet = childElements(listStyle).some(
      (child) => localNameOf(child) === "list-level-style-bullet",
    );
    styles.listKind.set(name, hasNumber && !hasBullet ? "number" : "bullet");
  }
  const pageLayout = descendantsNamed(root, "page-layout")[0];
  if (pageLayout) {
    const properties = childElements(pageLayout).find(
      (child) => localNameOf(child) === "page-layout-properties",
    );
    const page = parsePageLayout(properties);
    if (page) styles.page = page;
  }
}

function descendantsNamed(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element) => {
    for (const child of childElements(node)) {
      if (localNameOf(child) === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function parsePageLayout(
  properties: Element | undefined,
): PageSetup | undefined {
  if (!properties) return undefined;
  const width = cssLengthToPt(odfAttr(properties, ODF.fo, "page-width"));
  const height = cssLengthToPt(odfAttr(properties, ODF.fo, "page-height"));
  if (width === undefined || height === undefined) return undefined;
  const orientation =
    odfAttr(properties, ODF.style, "print-orientation") === "landscape"
      ? "landscape"
      : "portrait";
  const margins = {
    top: cssLengthToPt(odfAttr(properties, ODF.fo, "margin-top")) ?? 72,
    right: cssLengthToPt(odfAttr(properties, ODF.fo, "margin-right")) ?? 72,
    bottom: cssLengthToPt(odfAttr(properties, ODF.fo, "margin-bottom")) ?? 72,
    left: cssLengthToPt(odfAttr(properties, ODF.fo, "margin-left")) ?? 72,
    header: cssLengthToPt(odfAttr(properties, ODF.fo, "margin-header")) ?? 36,
    footer: cssLengthToPt(odfAttr(properties, ODF.fo, "margin-footer")) ?? 36,
    gutter: 0,
  };
  return {
    width,
    height,
    orientation,
    margins,
    preset: presetName(width, height),
  };
}

function presetName(width: number, height: number): string | undefined {
  const candidates: Array<[string, number, number]> = [
    ["A4", 595.3, 841.9],
    ["A3", 841.9, 1190.6],
    ["A5", 419.5, 595.3],
    ["Letter", 612, 792],
    ["Legal", 612, 1008],
    ["Tabloid", 792, 1224],
    ["B5 (JIS)", 498.9, 708.7],
  ];
  for (const [name, w, h] of candidates) {
    if (Math.abs(width - w) < 2 && Math.abs(height - h) < 2) return name;
  }
  return undefined;
}

function parseNamedStyles(
  container: Element | undefined,
  doc: DocDocument,
): void {
  if (!container) return;
  for (const style of childElements(container)) {
    if (localNameOf(style) !== "style") continue;
    const family = odfAttr(style, ODF.style, "family");
    if (family !== "paragraph" && family !== "text" && family !== "table")
      continue;
    const name = odfAttr(style, ODF.style, "name");
    if (!name) continue;
    const id = styleIdFromName(name);
    const textProps = childElements(style).find(
      (child) => localNameOf(child) === "text-properties",
    );
    const paragraphProps = childElements(style).find(
      (child) => localNameOf(child) === "paragraph-properties",
    );
    const existing = doc.styles.styles[id];
    const definition: StyleDef = existing ?? {
      id,
      name: decodeOdfName(name),
      type:
        family === "text"
          ? "character"
          : family === "table"
            ? "table"
            : "paragraph",
    };
    if (family === "paragraph") {
      definition.paragraph = {
        ...(definition.paragraph ?? {}),
        ...parseParagraphProperties(paragraphProps),
      };
    }
    const runProps = parseTextProperties(textProps);
    if (Object.keys(runProps).length > 0)
      definition.run = mergeRun(definition.run, runProps);
    if (!existing) doc.styles.styles[id] = definition;
  }
}

function parseMetadata(metaRoot: Element | undefined): {
  title?: string;
  creator?: string;
  description?: string;
  keywords: string[];
  created?: string;
  modified?: string;
  generator?: string;
} {
  const result: {
    keywords: string[];
    title?: string;
    creator?: string;
    description?: string;
    created?: string;
    modified?: string;
    generator?: string;
  } = {
    keywords: [],
  };
  if (!metaRoot) return result;
  const meta = descendantsNamed(metaRoot, "meta")[0] ?? metaRoot;
  for (const child of childElements(meta)) {
    const name = localNameOf(child);
    const value = textOf(child).trim();
    if (!value) continue;
    if (name === "title") result.title = value;
    else if (name === "creator" || name === "initial-creator")
      result.creator = result.creator ?? value;
    else if (name === "description") result.description = value;
    else if (name === "keyword") result.keywords.push(value);
    else if (name === "creation-date") result.created = value;
    else if (name === "date") result.modified = value;
    else if (name === "generator") result.generator = value;
  }
  return result;
}

function imagePayload(
  parts: Map<string, Buffer>,
  href: string,
): Buffer | undefined {
  const normalized = href.replace(/^\.\//, "");
  return parts.get(normalized) ?? parts.get(decodeURIComponent(normalized));
}

class OdtReader {
  readonly losses = new LossCollector();
  readonly features = new Map<string, number>();
  private readonly styles: OdtStyles;
  private readonly parts: Map<string, Buffer>;

  constructor(
    private readonly ctx: DocumentContext,
    styles: OdtStyles,
    parts: Map<string, Buffer>,
  ) {
    this.styles = styles;
    this.parts = parts;
  }

  private count(feature: string, amount = 1): void {
    this.features.set(feature, (this.features.get(feature) ?? 0) + amount);
  }

  readBody(textRoot: Element): void {
    this.convertChildren(textRoot, this.ctx.blocks, { listLevel: 0 });
  }

  private convertChildren(
    parent: Element,
    target: Block[],
    state: { listLevel: number },
  ): void {
    for (const child of childElements(parent))
      this.convertNode(child, target, state);
  }

  private convertNode(
    node: Element,
    target: Block[],
    state: { listLevel: number },
  ): void {
    const name = localNameOf(node);
    if (
      node.namespaceURI !== ODF.text &&
      node.namespaceURI !== ODF.table &&
      node.namespaceURI !== ODF.draw
    ) {
      // Unknown namespace: preserve text as paragraphs, report once.
      this.losses.partial(
        `odt.element:${name}`,
        "Element from an unknown namespace was flattened to its text",
        undefined,
        false,
      );
      this.convertChildren(node, target, state);
      return;
    }
    switch (name) {
      case "h": {
        const level = Math.max(
          1,
          Math.min(9, Number(odfAttr(node, ODF.text, "outline-level")) || 1),
        );
        const props = this.paragraphPropsFor(node);
        props.outlineLevel = level - 1;
        const inlines = this.inlinesOf(
          node,
          {},
          { listLevel: state.listLevel, paragraphStyle: `Heading${level}` },
        );
        target.push(
          makeParagraph(this.ctx, inlines, { style: `Heading${level}`, props }),
        );
        this.count("paragraph.heading");
        return;
      }
      case "p": {
        const inlines = this.inlinesOf(
          node,
          {},
          {
            listLevel: state.listLevel,
            paragraphStyle: this.paragraphStyleName(node),
          },
        );
        const props = this.paragraphPropsFor(node);
        const styleId = this.paragraphStyleId(node);
        if (inlines.length === 0 && Object.keys(props).length === 0) {
          target.push(makeParagraph(this.ctx, [], { style: styleId, props }));
          return;
        }
        target.push(
          makeParagraph(this.ctx, inlines, { style: styleId, props }),
        );
        this.count("paragraph.text");
        return;
      }
      case "list": {
        this.convertList(node, target, state);
        return;
      }
      case "table": {
        target.push(this.convertTable(node, state));
        return;
      }
      case "section":
      case "index-body":
      case "tracked-changes":
      case "variable-decls":
      case "sequence-decls":
      case "user-field-decls":
        if (name === "tracked-changes") {
          this.losses.unsupported(
            "trackedChanges",
            "ODF tracked changes are not imported",
            undefined,
            false,
          );
          return;
        }
        this.convertChildren(node, target, state);
        return;
      case "soft-page-break":
        target.push(makeParagraph(this.ctx, [{ type: "break", kind: "page" }]));
        this.count("pageBreak");
        return;
      case "frame": {
        const image = this.imageFromFrame(node, state);
        if (image) target.push(makeParagraph(this.ctx, [image]));
        return;
      }
      default:
        this.losses.partial(
          `odt.element:${name}`,
          `ODF element <${name}> was flattened to its text content`,
          undefined,
          false,
        );
        this.convertChildren(node, target, state);
        return;
    }
  }

  private paragraphStyleName(node: Element): string {
    return decodeOdfName(odfAttr(node, ODF.text, "style-name"));
  }

  private paragraphStyleId(node: Element): string {
    const name = this.paragraphStyleName(node);
    if (!name) return "Normal";
    const heading = headingStyleId(name);
    if (heading) return heading;
    const id = styleIdFromName(name);
    return this.ctx.doc.styles.styles[id] ? id : "Normal";
  }

  private paragraphPropsFor(node: Element): ParagraphProps {
    const styleName = odfAttr(node, ODF.text, "style-name");
    const fromStyle = styleName
      ? this.styles.paragraph.get(styleName)
      : undefined;
    return { ...(fromStyle ?? {}) };
  }

  private runPropsFor(styleName: string | undefined): RunProps {
    if (!styleName) return {};
    return { ...(this.styles.run.get(styleName) ?? {}) };
  }

  private convertList(
    node: Element,
    target: Block[],
    state: { listLevel: number },
  ): void {
    const styleName = odfAttr(node, ODF.text, "style-name");
    const kind = styleName
      ? (this.styles.listKind.get(styleName) ?? "bullet")
      : "bullet";
    const numId = createListDefinition(this.ctx.doc, { kind });
    this.convertListItems(node, target, state.listLevel, numId);
    this.count("lists.numbering");
  }

  private convertListItems(
    node: Element,
    target: Block[],
    level: number,
    numId: string,
  ): void {
    for (const item of childElements(node)) {
      if (localNameOf(item) !== "list-item") {
        this.losses.partial(
          "odt.list",
          "Non list-item child inside text:list was flattened",
          undefined,
          false,
        );
        this.convertNode(item, target, { listLevel: level });
        continue;
      }
      let numbered = false;
      for (const child of childElements(item)) {
        const name = localNameOf(child);
        if (name === "list") {
          this.convertListItems(child, target, Math.min(8, level + 1), numId);
          continue;
        }
        if (name === "p" || name === "h") {
          const inlines = this.inlinesOf(
            child,
            {},
            {
              listLevel: level,
              paragraphStyle: this.paragraphStyleName(child),
            },
          );
          const props = this.paragraphPropsFor(child);
          const numbering = { numId, level: Math.min(8, level) };
          if (!numbered) {
            target.push(
              makeParagraph(this.ctx, inlines, {
                style: this.paragraphStyleId(child),
                props: {
                  ...props,
                  numbering,
                  indent: { left: 36 + level * 36, hanging: 18 },
                },
              }),
            );
            numbered = true;
          } else {
            target.push(
              makeParagraph(this.ctx, inlines, {
                style: this.paragraphStyleId(child),
                props,
              }),
            );
          }
          continue;
        }
        this.convertNode(child, target, { listLevel: level });
      }
      if (!numbered) {
        target.push(
          makeParagraph(this.ctx, [], {
            props: {
              numbering: { numId, level: Math.min(8, level) },
              indent: { left: 36 + level * 36, hanging: 18 },
            },
          }),
        );
      }
    }
  }

  private convertTable(node: Element, _state: { listLevel: number }): Table {
    const rowGroups = this.tableRowGroups(node);
    const rows: TableCellSpec[][] = [];
    let headerRows = 0;
    for (const group of rowGroups) {
      for (const rowNode of group.rows) {
        const specs: TableCellSpec[] = [];
        for (const cellNode of childElements(rowNode)) {
          const cellName = localNameOf(cellNode);
          if (cellName === "covered-table-cell") {
            const repeat = Math.max(
              1,
              Math.min(
                64,
                Number(
                  odfAttr(cellNode, ODF.table, "number-columns-repeated"),
                ) || 1,
              ),
            );
            for (let index = 0; index < repeat; index += 1) {
              specs.push({
                blocks: [makeParagraph(this.ctx, [])],
                props: { vMerge: "continue" },
              });
            }
            continue;
          }
          if (cellName !== "table-cell") continue;
          const repeat = Math.max(
            1,
            Math.min(
              64,
              Number(odfAttr(cellNode, ODF.table, "number-columns-repeated")) ||
                1,
            ),
          );
          const span = Math.max(
            1,
            Number(odfAttr(cellNode, ODF.table, "number-columns-spanned")) || 1,
          );
          const rowSpan = Math.max(
            1,
            Number(odfAttr(cellNode, ODF.table, "number-rows-spanned")) || 1,
          );
          const blocks: Block[] = [];
          this.convertChildren(cellNode, blocks, { listLevel: 0 });
          if (blocks.length === 0) blocks.push(makeParagraph(this.ctx, []));
          const cellStyleName = odfAttr(cellNode, ODF.table, "style-name");
          const cellStyle = cellStyleName
            ? this.styles.cell.get(cellStyleName)
            : undefined;
          if (rowSpan > 1 || span > 1) this.count("table.mergedCells");
          for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
            specs.push({
              blocks,
              gridSpan: span > 1 ? span : undefined,
              vMerge: rowSpan > 1 ? "restart" : undefined,
              props: cellStyle
                ? {
                    background: cellStyle.background
                      ? { fill: cellStyle.background }
                      : undefined,
                    vAlign: cellStyle.vAlign ?? "top",
                  }
                : undefined,
            });
          }
        }
        if (specs.length === 0) continue;
        rows.push(specs);
        if (group.header) headerRows = rows.length;
      }
    }

    const columns = Math.max(
      1,
      ...rows.map((row) =>
        row.reduce((sum, cell) => sum + Math.max(1, cell.gridSpan ?? 1), 0),
      ),
    );
    const declaredWidths: number[] = [];
    for (const column of childElements(node)) {
      if (localNameOf(column) !== "table-column") continue;
      const repeat = Math.max(
        1,
        Math.min(
          64,
          Number(odfAttr(column, ODF.table, "number-columns-repeated")) || 1,
        ),
      );
      const styleName = odfAttr(column, ODF.table, "style-name");
      const width = styleName
        ? this.styles.columnWidth.get(styleName)
        : undefined;
      for (let index = 0; index < repeat; index += 1)
        declaredWidths.push(width ?? 0);
    }
    const tableWidth = contentWidthPt(this.ctx.doc);
    const columnWidths = new Array(columns)
      .fill(0)
      .map((_, index) => declaredWidths[index] || tableWidth / columns);
    this.count("table");
    if (rows.length === 0) {
      this.losses.partial(
        "table.empty",
        "Table without rows was kept as an empty table",
        undefined,
        false,
      );
      rows.push([{ blocks: [makeParagraph(this.ctx, [])] }]);
    }
    return buildTable(this.ctx, rows, {
      columns,
      columnWidths,
      headerRows: headerRows > 0 ? headerRows : undefined,
    });
  }

  /**
   * Rows of one table, keeping `table:table-header-rows` groups distinct from
   * body rows and skipping nested tables.
   */
  private tableRowGroups(
    node: Element,
  ): Array<{ header: boolean; rows: Element[] }> {
    const groups: Array<{ header: boolean; rows: Element[] }> = [];
    for (const child of childElements(node)) {
      const name = localNameOf(child);
      if (name === "table-row") {
        groups.push({ header: false, rows: [child] });
        continue;
      }
      if (
        name === "table-header-rows" ||
        name === "table-rows" ||
        name === "table-row-group"
      ) {
        const rows = childElements(child).filter(
          (row) =>
            localNameOf(row) === "table-row" ||
            localNameOf(row) === "table-header-rows",
        );
        const flat: Element[] = [];
        for (const row of rows) {
          if (localNameOf(row) === "table-row") flat.push(row);
          else
            flat.push(
              ...childElements(row).filter(
                (nested) => localNameOf(nested) === "table-row",
              ),
            );
        }
        if (flat.length > 0)
          groups.push({ header: name === "table-header-rows", rows: flat });
      }
    }
    return groups;
  }

  private inlinesOf(
    node: Element,
    base: RunProps,
    state: { listLevel: number; paragraphStyle?: string },
  ): Inline[] {
    const out: Inline[] = [];
    this.walkInline(node, base, out, state);
    trimInlines(out);
    return out;
  }

  private walkInline(
    node: Element,
    props: RunProps,
    out: Inline[],
    state: { listLevel: number; paragraphStyle?: string },
  ): void {
    const nodes = node.childNodes;
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const childNode = nodes.item(nodeIndex);
      if (!childNode) continue;
      // ODF stores literal text in text nodes interleaved with markup.
      if (childNode.nodeType === 3) {
        pushText(out, childNode.nodeValue ?? "", props);
        continue;
      }
      if (childNode.nodeType !== 1) continue;
      const child = childNode as Element;
      const name = localNameOf(child);
      if (child.namespaceURI === ODF.text) {
        switch (name) {
          case "span": {
            const styleName = odfAttr(child, ODF.text, "style-name");
            this.walkInline(
              child,
              mergeRun(props, this.runPropsFor(styleName)),
              out,
              state,
            );
            continue;
          }
          case "a": {
            const href = odfAttr(child, ODF.xlink, "href");
            const target: HyperlinkTarget | undefined = href
              ? {
                  href: href.startsWith("#") ? undefined : href,
                  anchor: href.startsWith("#") ? href.slice(1) : undefined,
                  external: !href.startsWith("#"),
                }
              : undefined;
            if (target) {
              this.count("hyperlink");
              this.walkInline(
                child,
                mergeRun(props, {
                  hyperlink: target,
                  color: "#0563c1",
                  underline: "single",
                }),
                out,
                state,
              );
            } else {
              this.walkInline(child, props, out, state);
            }
            continue;
          }
          case "s": {
            const count = Math.max(
              1,
              Math.min(64, Number(odfAttr(child, ODF.text, "c")) || 1),
            );
            pushText(out, " ".repeat(count), props);
            continue;
          }
          case "tab":
            out.push({ type: "tab" });
            continue;
          case "line-break":
            out.push({ type: "break", kind: "line" });
            continue;
          case "soft-page-break":
            out.push({ type: "break", kind: "page" });
            continue;
          case "bookmark":
          case "bookmark-start": {
            const bookmarkName = odfAttr(child, ODF.text, "name") ?? "bookmark";
            out.push({
              type: "bookmark",
              name: bookmarkName,
              bookmarkId: bookmarkName,
              kind: "start",
            });
            if (name === "bookmark")
              out.push({
                type: "bookmark",
                name: bookmarkName,
                bookmarkId: bookmarkName,
                kind: "end",
              });
            this.count("bookmark");
            continue;
          }
          case "bookmark-end": {
            const bookmarkName = odfAttr(child, ODF.text, "name") ?? "bookmark";
            out.push({
              type: "bookmark",
              name: bookmarkName,
              bookmarkId: bookmarkName,
              kind: "end",
            });
            continue;
          }
          case "note": {
            const noteRef = this.noteFromElement(child);
            if (noteRef) out.push(noteRef);
            continue;
          }
          default:
            if (child.localName === "annotation") {
              const ref = this.commentFromElement(child, state);
              if (ref) out.push(ref);
              continue;
            }
            if (child.namespaceURI === ODF.text && textOf(child).length > 0) {
              this.losses.partial(
                `odt.inline:${name}`,
                `Inline ODF element <${name}> was flattened to its text`,
                undefined,
                false,
              );
            }
            this.walkInline(child, props, out, state);
            continue;
        }
      }
      if (child.namespaceURI === ODF.office && name === "annotation") {
        const ref = this.commentFromElement(child, state);
        if (ref) out.push(ref);
        continue;
      }
      if (child.namespaceURI === ODF.draw && name === "frame") {
        const image = this.imageFromFrame(child, state);
        if (image) out.push(image);
        continue;
      }
      if (child.namespaceURI === ODF.text) continue;
      // Other namespaces (dc:, meta:) inside a paragraph are metadata, not text.
      if (child.namespaceURI === ODF.dc || child.namespaceURI === ODF.meta)
        continue;
      this.walkInline(child, props, out, state);
    }
  }

  private noteFromElement(node: Element): Inline | undefined {
    const noteClass =
      odfAttr(node, ODF.text, "note-class") === "endnote"
        ? "endnote"
        : "footnote";
    const id = odfAttr(node, ODF.text, "id") ?? this.ctx.next("fn");
    const blocks: Block[] = [];
    const body = childElements(node).find(
      (child) => localNameOf(child) === "note-body",
    );
    if (body) {
      for (const child of childElements(body))
        this.convertNode(child, blocks, { listLevel: 0 });
    }
    if (blocks.length === 0) blocks.push(makeParagraph(this.ctx, []));
    const note: Note = { id, type: noteClass, blocks };
    if (noteClass === "footnote") this.ctx.doc.footnotes.push(note);
    else this.ctx.doc.endnotes.push(note);
    this.count(noteClass === "footnote" ? "footnote" : "endnote");
    return { type: "noteRef", noteId: id, noteType: noteClass };
  }

  private commentFromElement(
    node: Element,
    _state: { listLevel: number },
  ): Inline | undefined {
    const id = odfAttr(node, ODF.office, "name") ?? this.ctx.next("comment");
    const creator = childElements(node).find(
      (child) => localNameOf(child) === "creator",
    );
    const date = childElements(node).find(
      (child) => localNameOf(child) === "date",
    );
    const blocks: Block[] = [];
    for (const child of childElements(node)) {
      if (child.namespaceURI === ODF.text)
        this.convertNode(child, blocks, { listLevel: 0 });
    }
    if (blocks.length === 0) blocks.push(makeParagraph(this.ctx, []));
    const comment: DocComment = {
      id,
      author: textOf(creator).trim() || "Unknown",
      date: textOf(date).trim() || undefined,
      blocks,
      resolved: false,
    };
    this.ctx.doc.comments.push(comment);
    this.count("comment");
    return { type: "commentRef", commentId: id, kind: "point" };
  }

  private imageFromFrame(
    node: Element,
    state: { listLevel: number; paragraphStyle?: string },
  ): Inline | undefined {
    const image = descendantsNamed(node, "image")[0];
    if (!image) {
      this.losses.fallback(
        "odt.frame",
        "Frames without an image (text boxes, shapes) are not imported",
        undefined,
        false,
      );
      return undefined;
    }
    const href = odfAttr(image, ODF.xlink, "href");
    if (!href) {
      this.losses.partial(
        "image.missing",
        "draw:image without xlink:href",
        undefined,
        false,
      );
      return undefined;
    }
    const payload = imagePayload(this.parts, href);
    if (!payload) {
      this.losses.partial(
        "image.missing",
        "Image payload is missing from the package",
        href,
        false,
      );
      return undefined;
    }
    const width = cssLengthToPt(odfAttr(node, ODF.svg, "width"));
    const height = cssLengthToPt(odfAttr(node, ODF.svg, "height"));
    const inline: ImageInline = addImageInline(this.ctx, {
      data: payload,
      width,
      height,
      fileName: href.replace(/^.*\//, ""),
      alt: odfAttr(node, ODF.svg, "title") ?? odfAttr(image, ODF.svg, "title"),
    });
    this.count("image.inline");
    void state;
    return inline;
  }
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
 * Imports an OpenDocument Text package.
 */
export async function importOdt(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `ODT input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  const pkg = await readPackage(buffer);
  if (pkg.isEncrypted) {
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "ODT input is an OLE container, not an OpenDocument ZIP",
    );
  }
  const parts = pkg.parts;
  const contentXml = parts.get("content.xml")?.toString("utf8");
  if (!contentXml) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "ODT package is missing content.xml",
    );
  }
  const warnings: string[] = [];
  const mimetype = parts.get("mimetype")?.toString("utf8").trim();
  if (mimetype && !mimetype.startsWith(MIMETYPE)) {
    warnings.push(`Unexpected ODT mimetype: ${mimetype}`);
  } else if (!mimetype) {
    warnings.push("ODT package has no mimetype entry");
  }

  const content = parseXml(contentXml, "content.xml");
  const contentRoot = content.documentElement as Element;
  const stylesDoc = parts.get("styles.xml")
    ? parseXml(parts.get("styles.xml")!.toString("utf8"), "styles.xml")
    : undefined;
  const stylesRoot = stylesDoc?.documentElement as Element | undefined;
  const metaDoc = parts.get("meta.xml")
    ? parseXml(parts.get("meta.xml")!.toString("utf8"), "meta.xml")
    : undefined;
  const metaRoot = metaDoc?.documentElement as Element | undefined;

  const metadata = parseMetadata(metaRoot);
  const styles: OdtStyles = {
    run: new Map(),
    paragraph: new Map(),
    columnWidth: new Map(),
    cell: new Map(),
    listKind: new Map(),
  };
  collectAutomaticStyles(contentRoot, styles);
  collectAutomaticStyles(stylesRoot, styles);

  const ctx = createDocumentContext({
    metadata: {
      title: metadata.title ?? titleFromFileName(options.fileName),
      creator: metadata.creator,
      description: metadata.description,
      keywords: metadata.keywords,
      created: metadata.created,
      modified: metadata.modified,
      app: metadata.generator ? { generator: metadata.generator } : undefined,
    },
    page: styles.page,
  });
  parseNamedStyles(
    stylesRoot ? first(stylesRoot, ODF.office, "styles") : undefined,
    ctx.doc,
  );

  const reader = new OdtReader(ctx, styles, parts);
  const textRoot = first(contentRoot, ODF.office, "body");
  const officeText = textRoot ? first(textRoot, ODF.office, "text") : undefined;
  if (officeText) reader.readBody(officeText);
  ctx.syncIds();
  const doc = ctx.doc;

  const features: FeatureSupport[] = [
    {
      feature: "document.odt",
      label: "OpenDocument Text",
      level: "full",
      occurrences: 1,
    },
    {
      feature: "document.metadata",
      label: "Document metadata",
      level: "full",
      occurrences: 1,
    },
    {
      feature: "pageLayout.odf",
      label: "Page layout",
      level: styles.page ? "full" : "partial",
      occurrences: 1,
    },
    {
      feature: "styles.odf",
      label: "Styles",
      level: "partial",
      occurrences: doc.styles.styles
        ? Object.keys(doc.styles.styles).length
        : 0,
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
  const losses = [...reader.losses.all()];
  doc.compatibility = buildCompatibilityReport({
    format: "odt",
    fileName: options.fileName,
    features,
    losses,
    unknownElements: [],
  });
  return importResult(doc, losses, warnings);
}

function titleFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : undefined;
}

function featureLabel(feature: string): string {
  const labels: Record<string, string> = {
    "paragraph.heading": "Headings",
    "paragraph.text": "Paragraphs",
    "lists.numbering": "Lists",
    table: "Tables",
    "table.mergedCells": "Merged table cells",
    "image.inline": "Inline images",
    hyperlink: "Hyperlinks",
    comment: "Comments",
    footnote: "Footnotes",
    endnote: "Endnotes",
    bookmark: "Bookmarks",
    pageBreak: "Page breaks",
    trackedChanges: "Tracked changes",
  };
  return labels[feature] ?? feature;
}

/* --------------------------------------------------------------- exporter */

const CONTENT_NAMESPACES: Record<string, string> = {
  "xmlns:office": ODF.office,
  "xmlns:text": ODF.text,
  "xmlns:table": ODF.table,
  "xmlns:draw": ODF.draw,
  "xmlns:fo": ODF.fo,
  "xmlns:style": ODF.style,
  "xmlns:svg": ODF.svg,
  "xmlns:xlink": ODF.xlink,
  "xmlns:dc": ODF.dc,
  "xmlns:meta": ODF.meta,
  "office:version": "1.2",
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlAttrs(attrs: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    parts.push(
      `${key}="${typeof value === "string" ? xmlEscape(value) : String(value)}"`,
    );
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function pt(value: number): string {
  return `${Math.round(value * 100) / 100}pt`;
}

class OdtWriter {
  readonly losses = new LossCollector();
  private readonly runStyles = new Map<string, { name: string; xml: string }>();
  private readonly paragraphStyles = new Map<
    string,
    { name: string; xml: string }
  >();
  private readonly cellStyles = new Map<
    string,
    { name: string; xml: string }
  >();
  private readonly columnStyles = new Map<
    string,
    { name: string; xml: string }
  >();
  private readonly fontFaces = new Set<string>();
  private readonly mediaFiles = new Map<
    string,
    { path: string; data: Buffer; contentType: string }
  >();
  private readonly listStyles = new Map<"bullet" | "number", string>();
  private tableIndex = 0;
  private readonly noteNumbers = new Map<string, number>();

  constructor(private readonly doc: DocDocument) {
    [...doc.footnotes].forEach((note, index) =>
      this.noteNumbers.set(note.id, index + 1),
    );
    for (const note of doc.endnotes) {
      // Endnotes share the footnote counter in ODF unless a separate class is
      // requested; keep them distinct in the model but numbered together.
      const index = doc.footnotes.length + doc.endnotes.indexOf(note) + 1;
      this.noteNumbers.set(note.id, index);
    }
  }

  /* --------------------------------------------------------- style names */

  private ensureRunStyle(props: RunProps): string | undefined {
    if (Object.keys(props).length === 0) return undefined;
    const key = stableStringify(props);
    const existing = this.runStyles.get(key);
    if (existing) return existing.name;
    const name = `T${this.runStyles.size + 1}`;
    const attributes: Record<string, string> = {};
    if (props.fontFamily) {
      attributes["style:font-name"] = props.fontFamily;
      this.fontFaces.add(props.fontFamily);
    }
    if (props.fontSize !== undefined)
      attributes["fo:font-size"] = pt(props.fontSize);
    if (props.bold) attributes["fo:font-weight"] = "bold";
    if (props.italic) attributes["fo:font-style"] = "italic";
    if (props.underline) {
      attributes["style:text-underline-style"] = "solid";
      attributes["style:text-underline-width"] = "auto";
      attributes["style:text-underline-color"] = "font-color";
    }
    if (props.strike || props.doubleStrike)
      attributes["style:text-line-through-style"] = "solid";
    if (props.color) attributes["fo:color"] = props.color;
    if (props.background) attributes["fo:background-color"] = props.background;
    if (props.caps) attributes["fo:text-transform"] = "uppercase";
    if (props.charSpacing !== undefined)
      attributes["fo:letter-spacing"] = pt(props.charSpacing);
    if (props.vertAlign === "superscript")
      attributes["style:text-position"] = "super 58%";
    else if (props.vertAlign === "subscript")
      attributes["style:text-position"] = "sub 58%";
    const xml = `<style:style style:name="${name}" style:family="text"><style:text-properties${xmlAttrs(attributes)}/></style:style>`;
    this.runStyles.set(key, { name, xml });
    return name;
  }

  private ensureParagraphStyle(
    props: ParagraphProps,
    parentName: string | undefined,
  ): string | undefined {
    if (Object.keys(props).length === 0 || parentName === undefined)
      return parentName;
    const key = `${parentName}|${stableStringify(props)}`;
    const existing = this.paragraphStyles.get(key);
    if (existing) return existing.name;
    const name = `P${this.paragraphStyles.size + 1}`;
    const paragraphAttributes: Record<string, string> = {};
    if (props.alignment === "center")
      paragraphAttributes["fo:text-align"] = "center";
    else if (props.alignment === "right")
      paragraphAttributes["fo:text-align"] = "end";
    else if (props.alignment === "justify")
      paragraphAttributes["fo:text-align"] = "justify";
    if (props.indent?.left !== undefined)
      paragraphAttributes["fo:margin-left"] = pt(props.indent.left);
    if (props.indent?.right !== undefined)
      paragraphAttributes["fo:margin-right"] = pt(props.indent.right);
    if (props.indent?.firstLine !== undefined)
      paragraphAttributes["fo:text-indent"] = pt(props.indent.firstLine);
    if (props.indent?.hanging !== undefined)
      paragraphAttributes["fo:text-indent"] = pt(-props.indent.hanging);
    if (props.spaceBefore !== undefined)
      paragraphAttributes["fo:margin-top"] = pt(props.spaceBefore);
    if (props.spaceAfter !== undefined)
      paragraphAttributes["fo:margin-bottom"] = pt(props.spaceAfter);
    if (props.lineSpacing?.rule === "auto")
      paragraphAttributes["fo:line-height"] =
        `${Math.round((props.lineSpacing.value / 240) * 100)}%`;
    else if (props.lineSpacing)
      paragraphAttributes["fo:line-height"] = pt(props.lineSpacing.value);
    if (props.pageBreakBefore) paragraphAttributes["fo:break-before"] = "page";
    if (props.keepNext) paragraphAttributes["fo:keep-with-next"] = "always";
    if (props.borders?.bottom) {
      paragraphAttributes["fo:border-bottom"] =
        `${pt(props.borders.bottom.width)} solid ${props.borders.bottom.color ?? "#000000"}`;
    }
    const xml = `<style:style style:name="${name}" style:family="paragraph"${
      parentName ? ` style:parent-style-name="${xmlEscape(parentName)}"` : ""
    }><style:paragraph-properties${xmlAttrs(paragraphAttributes)}/></style:style>`;
    this.paragraphStyles.set(key, { name, xml });
    return name;
  }

  private ensureCellStyle(
    cell: TableCell,
    width: number,
    bordered: boolean,
  ): string {
    const attributes: Record<string, string> = {
      "style:vertical-align": cell.props.vAlign ?? "top",
    };
    attributes["fo:padding"] = "0.05cm";
    const key = `${stableStringify(cell.props)}|${Math.round(width)}|${bordered ? "b" : "n"}`;
    const existing = this.cellStyles.get(key);
    if (existing) return existing.name;
    const name = `C${this.cellStyles.size + 1}`;
    const background = cell.props.background?.fill;
    if (background) attributes["fo:background-color"] = background;
    const border = bordered ? ' fo:border="0.5pt solid #000000"' : "";
    const xml = `<style:style style:name="${name}" style:family="table-cell"><style:table-cell-properties${xmlAttrs(
      attributes,
    )}${border}/></style:style>`;
    this.cellStyles.set(key, { name, xml });
    return name;
  }

  private ensureColumnStyle(width: number): string {
    const key = String(Math.round(width));
    const existing = this.columnStyles.get(key);
    if (existing) return existing.name;
    const name = `Col${this.columnStyles.size + 1}`;
    const xml = `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${pt(
      width,
    )}"/></style:style>`;
    this.columnStyles.set(key, { name, xml });
    return name;
  }

  private ensureListStyle(kind: "bullet" | "number"): string {
    const existing = this.listStyles.get(kind);
    if (existing) return existing;
    const name = kind === "bullet" ? "ListBullet" : "ListNumber";
    this.listStyles.set(kind, name);
    return name;
  }

  /* ------------------------------------------------------------- content */

  body(): string {
    const sections = this.doc.sections;
    const parts: string[] = [];
    sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) {
        if (section.breakBefore === "continuous") {
          parts.push('<text:p text:style-name="Standard"/>');
        } else {
          parts.push("<text:p><text:soft-page-break/></text:p>");
        }
        if (
          section.breakBefore === "oddPage" ||
          section.breakBefore === "evenPage"
        ) {
          this.losses.partial(
            `sectionBreak.${section.breakBefore}`,
            "ODF cannot express odd/even page section breaks; a plain page break is used",
            `section[${sectionIndex}]`,
            false,
          );
        }
      }
      parts.push(this.blocks(section.blocks, section));
      if (section.headers.default || section.footers.default) {
        this.losses.unsupported(
          "headerFooter",
          "Headers and footers are not exported by the ODT writer",
          `section[${sectionIndex}]`,
          false,
        );
      }
    });
    return parts.join("\n");
  }

  private blocks(blocks: Block[], section: Section): string {
    const out: string[] = [];
    let index = 0;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.type === "table") {
        out.push(this.table(block));
        index += 1;
        continue;
      }
      if (block.type === "toc") {
        this.losses.partial(
          "toc",
          "Table of contents is not written as an ODF index",
          undefined,
          false,
        );
        index += 1;
        continue;
      }
      if (block.props.numbering) {
        const rendered = this.list(
          blocks,
          index,
          block.props.numbering.level,
          block.props.numbering.numId,
        );
        out.push(rendered.xml);
        index = rendered.next;
        continue;
      }
      out.push(this.paragraph(block, section));
      index += 1;
    }
    return out.join("\n");
  }

  private paragraph(paragraph: Paragraph, _section: Section): string {
    const styleName = this.namedStyleFor(paragraph.style);
    const directProps: ParagraphProps = { ...paragraph.props };
    const directStyle = this.ensureParagraphStyle(directProps, styleName);
    const styleAttribute = directStyle ?? styleName;
    const attributes: Record<string, string> = {};
    if (styleAttribute) attributes["text:style-name"] = styleAttribute;
    const heading = headingLevelOfStyleId(this.doc, paragraph.style);
    if (heading !== undefined)
      attributes["text:outline-level"] = String(heading);
    // Numbering level indentation is baked into the list style; direct props
    // that only mirror the numbering are not re-emitted.
    const tag = heading !== undefined ? "text:h" : "text:p";
    const content = paragraph.inlines
      .map((inline) => this.inline(inline, paragraph))
      .join("");
    return `<${tag}${xmlAttrs(attributes)}>${content}</${tag}>`;
  }

  private namedStyleFor(styleId: string | undefined): string {
    const style = styleId ? this.doc.styles.styles[styleId] : undefined;
    const name = style?.name ?? styleId ?? "Normal";
    if (styleId === "Normal" || !styleId) return "Standard";
    const heading = headingLevelOfStyleId(this.doc, styleId);
    if (heading !== undefined) return `Heading ${heading}`;
    return name;
  }

  private list(
    blocks: Block[],
    start: number,
    level: number,
    numId: string,
  ): { xml: string; next: number } {
    const firstBlock = blocks[start];
    if (!firstBlock || firstBlock.type !== "paragraph")
      return { xml: "", next: start + 1 };
    const kind = this.listKind(numId, firstBlock);
    const styleName = this.ensureListStyle(kind);
    const items: string[] = [];
    let index = start;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.type !== "paragraph" || !block.props.numbering) break;
      if (block.props.numbering.numId !== numId) break;
      const blockLevel = block.props.numbering.level;
      if (blockLevel < level) break;
      if (blockLevel > level) {
        const nested = this.list(blocks, index, blockLevel, numId);
        if (items.length > 0) {
          items[items.length - 1] = items[items.length - 1].replace(
            "</text:list-item>",
            `${nested.xml}</text:list-item>`,
          );
        } else {
          items.push(`<text:list-item>${nested.xml}</text:list-item>`);
        }
        index = nested.next;
        continue;
      }
      const styleNameForItem = this.ensureParagraphStyle(
        block.props,
        undefined,
      );
      const attributes: Record<string, string> = {};
      if (styleNameForItem) attributes["text:style-name"] = styleNameForItem;
      const content = block.inlines
        .map((inline) => this.inline(inline, block))
        .join("");
      items.push(
        `<text:list-item><text:p${xmlAttrs(attributes)}>${content}</text:p></text:list-item>`,
      );
      index += 1;
    }
    return {
      xml: `<text:list${xmlAttrs({ "text:style-name": styleName })}>${items.join("")}</text:list>`,
      next: index,
    };
  }

  private listKind(numId: string, paragraph: Paragraph): "bullet" | "number" {
    const num = this.doc.numbering.nums[numId];
    const abstract = num
      ? this.doc.numbering.abstract[num.abstractId]
      : undefined;
    const level =
      abstract?.levels.find(
        (entry) => entry.level === (paragraph.props.numbering?.level ?? 0),
      ) ?? abstract?.levels[0];
    return level && level.numFmt !== "bullet" && level.numFmt !== "none"
      ? "number"
      : "bullet";
  }

  private table(table: Table): string {
    this.tableIndex += 1;
    const name = `Table${this.tableIndex}`;
    if (
      table.rows.some((row) =>
        row.cells.some((cell) => cell.props.vMerge === "continue"),
      )
    ) {
      this.losses.fallback(
        "table.verticalMerge",
        "Vertical merges are exported with number-rows-spanned and covered cells",
        undefined,
        true,
      );
    }
    const columns: string[] = [];
    for (const width of table.grid.length > 0
      ? table.grid
      : [contentWidthPt(this.doc)]) {
      columns.push(
        `<table:table-column table:style-name="${this.ensureColumnStyle(width)}"/>`,
      );
    }
    const rowXml: string[] = [];
    for (const row of table.rows) {
      const cells: string[] = [];
      for (let index = 0; index < row.cells.length; index += 1) {
        const cell = row.cells[index];
        if (cell.props.vMerge === "continue") {
          cells.push("<table:covered-table-cell/>");
          continue;
        }
        const width =
          cell.props.width?.value ??
          table.grid[index] ??
          contentWidthPt(this.doc) / Math.max(1, row.cells.length);
        const span = cell.props.gridSpan ?? 1;
        let rowSpan = 1;
        if (cell.props.vMerge === "restart") {
          let scan = table.rows.indexOf(row) + 1;
          while (
            scan < table.rows.length &&
            table.rows[scan]?.cells[index]?.props.vMerge === "continue"
          ) {
            rowSpan += 1;
            scan += 1;
          }
        }
        const attributes: Record<string, string> = {};
        attributes["table:style-name"] = this.ensureCellStyle(
          cell,
          width,
          table.props.borders !== undefined,
        );
        if (span > 1) attributes["table:number-columns-spanned"] = String(span);
        if (rowSpan > 1)
          attributes["table:number-rows-spanned"] = String(rowSpan);
        const content = this.blocks(cell.blocks, this.doc.sections[0]);
        cells.push(
          `<table:table-cell${xmlAttrs(attributes)}>${content}</table:table-cell>`,
        );
      }
      rowXml.push(`<table:table-row>${cells.join("")}</table:table-row>`);
    }
    let headerCount = 0;
    while (
      headerCount < rowXml.length &&
      table.rows[headerCount]?.props.isHeader
    )
      headerCount += 1;
    const headerXml =
      headerCount > 0
        ? `<table:table-header-rows>${rowXml.slice(0, headerCount).join("")}</table:table-header-rows>`
        : "";
    const bodyXml = rowXml.slice(headerCount).join("");
    return `<table:table${xmlAttrs({ "table:name": name, "table:style-name": "TableGrid" })}>${columns.join(
      "",
    )}${headerXml}${bodyXml}</table:table>`;
  }

  private inline(inline: Inline, paragraph: Paragraph): string {
    switch (inline.type) {
      case "text":
        return this.textInline(inline.text, inline.props, paragraph);
      case "tab":
        return "<text:tab/>";
      case "break":
        return inline.kind === "page"
          ? "<text:soft-page-break/>"
          : "<text:line-break/>";
      case "image": {
        const asset = this.doc.media.find(
          (entry) => entry.id === inline.mediaId,
        );
        if (!asset) {
          this.losses.unsupported(
            "image.missing",
            "Image media is not in the document",
            `image:${inline.mediaId}`,
            false,
          );
          return `<text:span>${xmlEscape(inline.alt ?? "")}</text:span>`;
        }
        const path = this.registerMedia(asset);
        const frame = `<draw:frame draw:style-name="ImageFrame" svg:width="${pt(inline.width)}" svg:height="${pt(
          inline.height,
        )}"${inline.alt ? ` svg:title="${xmlEscape(inline.alt)}"` : ""}><draw:image xlink:href="${xmlEscape(
          path,
        )}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
        if (inline.anchor?.type === "floating") {
          this.losses.partial(
            "image.floating",
            "Floating images are exported as anchored frames",
            `image:${inline.mediaId}`,
            false,
          );
        }
        return frame;
      }
      case "field": {
        const cached = (inline.result ?? [])
          .map((child) =>
            child.type === "text"
              ? child.text
              : child.type === "tab"
                ? "\t"
                : "",
          )
          .join("");
        this.losses.partial(
          "fields",
          "Field results are exported as plain text; ODF fields are not generated",
          undefined,
          false,
        );
        return this.textInline(cached, {}, paragraph);
      }
      case "noteRef": {
        const note = [...this.doc.footnotes, ...this.doc.endnotes].find(
          (entry) => entry.id === inline.noteId,
        );
        if (!note) {
          this.losses.unsupported(
            "notes.reference",
            "Note reference has no note body",
            `note:${inline.noteId}`,
            false,
          );
          return "";
        }
        const index = this.noteNumbers.get(note.id) ?? 1;
        const body = note.blocks
          .map((block) =>
            block.type === "paragraph"
              ? this.paragraph(block, this.doc.sections[0])
              : "",
          )
          .join("");
        return `<text:note text:note-class="${note.type === "footnote" ? "footnote" : "endnote"}" text:id="${xmlEscape(
          note.id,
        )}"><text:note-citation>${index}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`;
      }
      case "commentRef": {
        const comment = this.doc.comments.find(
          (entry) => entry.id === inline.commentId,
        );
        if (!comment) {
          this.losses.unsupported(
            "comment.missing",
            "Comment anchor has no comment body",
            `comment:${inline.commentId}`,
            false,
          );
          return "";
        }
        if (inline.kind === "rangeEnd") {
          this.losses.partial(
            "comment.range",
            "ODF annotations are point anchors; range ends are dropped",
            `comment:${comment.id}`,
            false,
          );
          return "";
        }
        if (inline.kind === "rangeStart") return "";
        const body = comment.blocks
          .map((block) =>
            block.type === "paragraph"
              ? this.paragraph(block, this.doc.sections[0])
              : "",
          )
          .join("");
        return `<office:annotation office:name="${xmlEscape(comment.id)}"><dc:creator>${xmlEscape(
          comment.author,
        )}</dc:creator>${comment.date ? `<dc:date>${xmlEscape(comment.date)}</dc:date>` : ""}${body}</office:annotation>`;
      }
      case "bookmark": {
        if (inline.kind === "start")
          return `<text:bookmark-start text:name="${xmlEscape(inline.name)}"/>`;
        return `<text:bookmark-end text:name="${xmlEscape(inline.name)}"/>`;
      }
      case "math":
        this.losses.fallback(
          "math",
          "Equations are exported as linear text",
          undefined,
          false,
        );
        return this.textInline(inline.linear, {}, paragraph);
      case "shape": {
        this.losses.fallback(
          "shape",
          "Shapes and text boxes are not exported as ODF frames",
          `shape:${inline.shapeId}`,
          false,
        );
        return "";
      }
      case "unknown": {
        this.losses.fallback(
          "unknown.inline",
          "Uninterpreted inline content is exported as text",
          inline.element,
          true,
        );
        return inline.text ? this.textInline(inline.text, {}, paragraph) : "";
      }
      default:
        return "";
    }
  }

  private textInline(
    text: string,
    props: RunProps,
    _paragraph: Paragraph,
  ): string {
    if (text.length === 0) return "";
    // Only direct formatting needs a character style; inherited formatting is
    // already carried by the paragraph style. Hyperlink marks and revision
    // marks are not character formatting in ODF.
    const direct: RunProps = { ...props };
    delete direct.revision;
    delete direct.hyperlink;
    const styleName = this.ensureRunStyle(direct);
    const parts = splitSpaces(text).map((part) =>
      part.kind === "spaces"
        ? `<text:s text:c="${part.count}"/>`
        : xmlEscape(part.text),
    );
    const body = parts.join("");
    const link = props.hyperlink;
    if (link && (link.href || link.anchor)) {
      const href = link.href ?? `#${link.anchor ?? ""}`;
      return `<text:a xlink:type="simple" xlink:href="${xmlEscape(href)}">${body}</text:a>`;
    }
    if (styleName)
      return `<text:span text:style-name="${styleName}">${body}</text:span>`;
    return body;
  }

  private registerMedia(asset: import("../model/types.js").MediaAsset): string {
    const existing = this.mediaFiles.get(asset.id);
    if (existing) return existing.path;
    const extension = mediaExtension(asset.contentType, asset.fileName);
    const path = `Pictures/${asset.id}.${extension}`;
    this.mediaFiles.set(asset.id, {
      path,
      data: Buffer.from(asset.data, "base64"),
      contentType: asset.contentType,
    });
    return path;
  }

  automaticStyles(): string {
    const blocks: string[] = [];
    for (const style of this.runStyles.values()) blocks.push(style.xml);
    for (const style of this.paragraphStyles.values()) blocks.push(style.xml);
    for (const style of this.cellStyles.values()) blocks.push(style.xml);
    for (const style of this.columnStyles.values()) blocks.push(style.xml);
    for (const kind of this.listStyles.keys()) blocks.push(listStyleXml(kind));
    blocks.push(
      '<style:style style:name="TableGrid" style:family="table"><style:table-properties table:border-model="collapsing" style:width="16cm"/></style:style>',
      '<style:style style:name="TableHeaderRow" style:family="table-row"><style:table-row-properties fo:keep-with-next="always"/></style:style>',
      '<style:style style:name="ImageFrame" style:family="graphic"><style:graphic-properties style:run-through="foreground" style:wrap="none" style:vertical-pos="top" style:vertical-rel="baseline" style:horizontal-pos="left" style:horizontal-rel="paragraph"/></style:style>',
    );
    return blocks.join("\n");
  }

  fontFaceDeclarations(): string {
    const faces: string[] = [];
    for (const family of [...this.fontFaces].sort((a, b) =>
      a.localeCompare(b),
    )) {
      faces.push(
        `<style:font-face style:name="${xmlEscape(family)}" svg:font-family="${xmlEscape(family)}" style:font-family-generic="swiss"/>`,
      );
    }
    return faces.join("\n");
  }

  /** Media parts for the manifest and archive. */
  mediaParts(): Array<{ path: string; data: Buffer; contentType: string }> {
    return [...this.mediaFiles.values()];
  }
}

function headingLevelOfStyleId(
  doc: DocDocument,
  styleId: string | undefined,
): number | undefined {
  if (!styleId) return undefined;
  const match = /^Heading([1-9])$/.exec(styleId);
  if (match) return Number(match[1]);
  const style = doc.styles.styles[styleId];
  if (style?.paragraph?.outlineLevel !== undefined)
    return style.paragraph.outlineLevel + 1;
  return undefined;
}

function listStyleXml(kind: "bullet" | "number"): string {
  const name = kind === "bullet" ? "ListBullet" : "ListNumber";
  const levels: string[] = [];
  for (let level = 1; level <= 9; level += 1) {
    const indent = 0.635 * level;
    if (kind === "bullet") {
      levels.push(
        `<text:list-level-style-bullet text:level="${level}" text:bullet-char="\u2022"><style:list-level-properties text:space-before="${indent.toFixed(
          3,
        )}cm" text:min-label-width="0.635cm"/></text:list-level-style-bullet>`,
      );
    } else {
      levels.push(
        `<text:list-level-style-number text:level="${level}" style:num-format="1" style:num-suffix="."><style:list-level-properties text:space-before="${indent.toFixed(
          3,
        )}cm" text:min-label-width="0.635cm"/></text:list-level-style-number>`,
      );
    }
  }
  return `<text:list-style style:name="${name}">${levels.join("")}</text:list-style>`;
}

type SpacePart =
  { kind: "text"; text: string } | { kind: "spaces"; count: number };

/** Splits text into literal chunks and runs of spaces (encoded as `<text:s/>`). */
function splitSpaces(text: string): SpacePart[] {
  const parts: SpacePart[] = [];
  const pattern = /( {2,})/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex)
      parts.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    parts.push({ kind: "spaces", count: match[1].length });
    lastIndex = match.index + match[1].length;
  }
  if (lastIndex < text.length)
    parts.push({ kind: "text", text: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

function mediaExtension(contentType: string, fileName: string): string {
  const fromName = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/tiff": "tiff",
  };
  return map[contentType] ?? "bin";
}

function namedStylesXml(doc: DocDocument): string {
  const used = new Set<string>(["Normal"]);
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.type === "paragraph" && block.style) used.add(block.style);
      if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            for (const inner of cell.blocks)
              if (inner.type === "paragraph" && inner.style)
                used.add(inner.style);
          }
        }
      }
    }
  }
  const parts: string[] = [
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"><style:paragraph-properties fo:margin-bottom="0.2cm"/><style:text-properties fo:font-size="11pt" style:font-name="Calibri"/></style:style>',
  ];
  const fontFaces = new Set<string>(["Calibri"]);
  for (const styleId of [...used].sort((a, b) => a.localeCompare(b))) {
    if (styleId === "Normal") continue;
    const style = doc.styles.styles[styleId];
    if (!style) continue;
    const name = /^Heading[1-9]$/.test(styleId)
      ? `Heading ${styleId.slice(7)}`
      : style.name;
    const runProps = style.run ?? {};
    const paragraphProps = style.paragraph ?? {};
    if (runProps.fontFamily) fontFaces.add(runProps.fontFamily);
    const textAttributes: Record<string, string> = {};
    if (runProps.fontFamily)
      textAttributes["style:font-name"] = runProps.fontFamily;
    if (runProps.fontSize !== undefined)
      textAttributes["fo:font-size"] = pt(runProps.fontSize);
    if (runProps.bold) textAttributes["fo:font-weight"] = "bold";
    if (runProps.italic) textAttributes["fo:font-style"] = "italic";
    if (runProps.color) textAttributes["fo:color"] = runProps.color;
    const paragraphAttributes: Record<string, string> = {};
    if (paragraphProps.alignment === "center")
      paragraphAttributes["fo:text-align"] = "center";
    else if (paragraphProps.alignment === "right")
      paragraphAttributes["fo:text-align"] = "end";
    else if (paragraphProps.alignment === "justify")
      paragraphAttributes["fo:text-align"] = "justify";
    if (paragraphProps.spaceBefore !== undefined)
      paragraphAttributes["fo:margin-top"] = pt(paragraphProps.spaceBefore);
    if (paragraphProps.spaceAfter !== undefined)
      paragraphAttributes["fo:margin-bottom"] = pt(paragraphProps.spaceAfter);
    if (paragraphProps.indent?.left !== undefined)
      paragraphAttributes["fo:margin-left"] = pt(paragraphProps.indent.left);
    if (paragraphProps.keepNext)
      paragraphAttributes["fo:keep-with-next"] = "always";
    if (paragraphProps.outlineLevel !== undefined)
      paragraphAttributes["fo:break-before"] = "auto";
    parts.push(
      `<style:style style:name="${xmlEscape(name)}" style:family="paragraph"${
        style.basedOn
          ? ` style:parent-style-name="${xmlEscape(style.basedOn === "Normal" ? "Standard" : style.name)}"`
          : ""
      }><style:paragraph-properties${xmlAttrs(paragraphAttributes)}/><style:text-properties${xmlAttrs(textAttributes)}/></style:style>`,
    );
  }
  const faces = [...fontFaces]
    .sort((a, b) => a.localeCompare(b))
    .map(
      (family) =>
        `<style:font-face style:name="${xmlEscape(family)}" svg:font-family="${xmlEscape(family)}"/>`,
    )
    .join("");
  return `<office:font-face-decls>${faces}</office:font-face-decls><office:styles>${parts.join("")}</office:styles>`;
}

function pageLayoutXml(section: Section): string {
  const page = section.page;
  const orientation =
    page.orientation === "landscape" ? "landscape" : "portrait";
  const attributes: Record<string, string> = {
    "fo:page-width": pt(page.width),
    "fo:page-height": pt(page.height),
    "style:print-orientation": orientation,
    "fo:margin-top": pt(page.margins.top),
    "fo:margin-bottom": pt(page.margins.bottom),
    "fo:margin-left": pt(page.margins.left),
    "fo:margin-right": pt(page.margins.right),
  };
  return `<style:page-layout style:name="pm1"><style:page-layout-properties${xmlAttrs(
    attributes,
  )}/></style:page-layout>`;
}

/**
 * Exports a document as an OpenDocument Text package (ODF 1.2).
 *
 * The archive contains an uncompressed `mimetype` entry first, the manifest,
 * `content.xml` (body + automatic styles), `styles.xml` (named styles, page
 * layout, master page), `meta.xml` and any referenced `Pictures/*` parts.
 */
export async function exportOdt(
  doc: DocDocument,
  options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  const writer = new OdtWriter(doc);
  const body = writer.body();
  const section = doc.sections[0] ?? createSection(DEFAULT_PAGE, []);

  const contentXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<office:document-content${xmlAttrs(CONTENT_NAMESPACES)}>`,
    `<office:font-face-decls>${writer.fontFaceDeclarations()}</office:font-face-decls>`,
    `<office:automatic-styles>${writer.automaticStyles()}</office:automatic-styles>`,
    `<office:body><office:text>${body}</office:text></office:body>`,
    "</office:document-content>",
  ].join("\n");

  const stylesXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<office:document-styles${xmlAttrs(CONTENT_NAMESPACES)}>`,
    namedStylesXml(doc),
    `<office:automatic-styles>${pageLayoutXml(section)}</office:automatic-styles>`,
    '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>',
    "</office:document-styles>",
  ].join("\n");

  const metaParts: string[] = [
    "<meta:generator>dsh-doc-editor</meta:generator>",
  ];
  if (doc.metadata.title)
    metaParts.push(`<dc:title>${xmlEscape(doc.metadata.title)}</dc:title>`);
  if (doc.metadata.creator)
    metaParts.push(
      `<dc:creator>${xmlEscape(doc.metadata.creator)}</dc:creator>`,
    );
  if (doc.metadata.description)
    metaParts.push(
      `<dc:description>${xmlEscape(doc.metadata.description)}</dc:description>`,
    );
  for (const keyword of doc.metadata.keywords)
    metaParts.push(`<meta:keyword>${xmlEscape(keyword)}</meta:keyword>`);
  if (doc.metadata.created)
    metaParts.push(
      `<meta:creation-date>${xmlEscape(doc.metadata.created)}</meta:creation-date>`,
    );
  if (doc.metadata.modified)
    metaParts.push(`<dc:date>${xmlEscape(doc.metadata.modified)}</dc:date>`);
  if (doc.metadata.subject)
    metaParts.push(
      `<dc:subject>${xmlEscape(doc.metadata.subject)}</dc:subject>`,
    );
  const metaXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<office:document-meta${xmlAttrs(CONTENT_NAMESPACES)}>`,
    `<office:meta>${metaParts.join("")}</office:meta>`,
    "</office:document-meta>",
  ].join("\n");

  const media = writer.mediaParts();
  const manifestEntries = [
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${MIMETYPE}"/>`,
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    ...media.map(
      (entry) =>
        `<manifest:file-entry manifest:full-path="${xmlEscape(entry.path)}" manifest:media-type="${xmlEscape(
          entry.contentType,
        )}"/>`,
    ),
  ];
  const manifestXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<manifest:manifest${xmlAttrs({ "xmlns:manifest": ODF.manifest, "manifest:version": "1.2" })}>`,
    manifestEntries.join(""),
    "</manifest:manifest>",
  ].join("\n");

  const archive = new JSZip();
  const date = archiveDate(doc, options);
  archive.file("mimetype", MIMETYPE, { compression: "STORE", date });
  archive.file("META-INF/manifest.xml", manifestXml, {
    compression: "DEFLATE",
    date,
  });
  archive.file("content.xml", contentXml, { compression: "DEFLATE", date });
  archive.file("styles.xml", stylesXml, { compression: "DEFLATE", date });
  archive.file("meta.xml", metaXml, { compression: "DEFLATE", date });
  for (const entry of media) {
    archive.file(entry.path, entry.data, { compression: "DEFLATE", date });
  }
  const buffer = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: MIMETYPE,
  });

  return { buffer, warnings: [], losses: writer.losses.all() };
}

function archiveDate(doc: DocDocument, options: FormatExportOptions): Date {
  if (options.preserveTimestamps) {
    const stamp = doc.metadata.modified ?? doc.metadata.created;
    if (stamp) {
      const date = new Date(stamp);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  // Deterministic archive timestamps keep exports byte-stable across runs.
  return new Date(Date.UTC(1980, 0, 1));
}

/* ------------------------------------------------------------- descriptor */

const CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: true,
  styles: "partial",
  tables: "full",
  images: "full",
  hyperlinks: "full",
  headersFooters: "none",
  pageLayout: "full",
  numbering: "partial",
  metadata: "full",
  comments: "partial",
  trackedChanges: "none",
  math: "none",
  notes: [
    "First-class ODT export: valid ODF 1.2 package with stored mimetype, manifest, content, styles and meta.",
    "Headings, paragraphs, lists, tables with spans, images, hyperlinks, footnotes and comments round-trip.",
    "Headers/footers, tracked changes and math are not exported.",
  ],
};

const ODT_EXTENSIONS = ["odt", "ott"];

/** ODT format descriptor. */
export const odtAdapter: FormatAdapter = {
  id: "odt",
  label: "OpenDocument Text (ODT)",
  extensions: ODT_EXTENSIONS,
  mimeTypes: [MIMETYPE, "application/vnd.oasis.opendocument.text-template"],
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    const extension = fileName
      ? (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] ?? "").toLowerCase()
      : "";
    if (ODT_EXTENSIONS.includes(extension)) return true;
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
      return false;
    // The stored mimetype entry is the first local file, so the media type is
    // visible in the archive prefix.
    const prefix = bytes
      .subarray(0, Math.min(bytes.length, 512))
      .toString("latin1");
    return prefix.includes(MIMETYPE);
  },
  import: importOdt,
  export: exportOdt,
};

/* Unused imports kept explicit for readability of the public surface. */
