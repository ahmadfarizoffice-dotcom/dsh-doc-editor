/**
 * Read-only preview adapters for spreadsheet and presentation packages.
 *
 * These are intentionally not full model mappings: a spreadsheet cell range and
 * a slide are not WordprocessingML paragraphs. They produce a faithful, readable
 * document (one section per sheet/slide, values as tables, slide text as
 * paragraphs) so XLSX/PPTX content can be listed, searched, converted to
 * HTML/Markdown/TXT or fed to the AI assistant, and they mark the result with
 * `metadata.custom.DSHPreview = "true"` plus a compatibility report so callers
 * can see that formulas are cached values, charts are not rendered, etc.
 */
import type { Element } from "@xmldom/xmldom";
import { readPackage, readText, resolvePartPath } from "../docx/package.js";
import {
  attr,
  childElements,
  descendants,
  first,
  localNameOf,
  parseXml,
  textOf,
} from "../docx/xml.js";
import { NS } from "../docx/xml.js";
import { createListDefinition } from "../model/edit.js";
import { emuToPt } from "../model/types.js";
import type {
  Block,
  DocDocument,
  FeatureSupport,
  Inline,
  ParagraphProps,
  Table,
} from "../model/types.js";
import {
  addImageInline,
  appendSection,
  buildCompatibilityReport,
  buildTable,
  contentWidthPt,
  createDocumentContext,
  ensureStyle,
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
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

/* -------------------------------------------------------------- utilities */

const NS_X = {
  spreadsheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  presentation: "http://schemas.openxmlformats.org/presentationml/2006/main",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  relationship: NS.r,
  officeDocument:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
} as const;

const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLUMNS = 64;
const MAX_SHEET_CELLS = 20_000;
const MAX_SLIDES = 500;

function columnIndex(reference: string): number {
  const match = /^([A-Z]+)/i.exec(reference);
  if (!match) return 0;
  let value = 0;
  for (const char of match[1].toUpperCase())
    value = value * 26 + (char.charCodeAt(0) - 64);
  return Math.max(0, value - 1);
}

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function extensionOf(fileName?: string): string {
  const match = fileName ? /\.([A-Za-z0-9]+)$/.exec(fileName) : null;
  return match ? match[1].toLowerCase() : "";
}

function previewMarker(doc: DocDocument): void {
  doc.metadata.custom.DSHPreview = "true";
}

/* ----------------------------------------------------------- relationships */

interface Relationship {
  id: string;
  type: string;
  target: string;
}

function parseRelationships(
  parts: Map<string, Buffer>,
  partPath: string,
): Map<string, Relationship> {
  const dir = partPath.split("/").slice(0, -1).join("/");
  const base = partPath.split("/").pop() ?? "";
  const relsPath = `${dir ? `${dir}/` : ""}_rels/${base}.rels`;
  const xml = readText(parts, relsPath);
  const out = new Map<string, Relationship>();
  if (!xml) return out;
  const document = parseXml(xml, relsPath);
  for (const relationship of descendants(
    document.documentElement as Element,
    "Relationship",
  )) {
    const id = attr(relationship, null, "Id");
    const target = attr(relationship, null, "Target");
    const type = attr(relationship, null, "Type") ?? "";
    if (id && target) out.set(id, { id, type, target });
  }
  return out;
}

/* ----------------------------------------------------------------- XLSX */

function sharedStrings(parts: Map<string, Buffer>): string[] {
  const xml = readText(parts, "xl/sharedStrings.xml");
  if (!xml) return [];
  const document = parseXml(xml, "xl/sharedStrings.xml");
  const out: string[] = [];
  for (const item of descendants(document.documentElement as Element, "si")) {
    out.push(
      descendants(item, "t")
        .map((node) => textOf(node))
        .join(""),
    );
  }
  return out;
}

interface SheetInfo {
  name: string;
  path: string;
}

function workbookSheets(parts: Map<string, Buffer>): SheetInfo[] {
  const workbookXml = readText(parts, "xl/workbook.xml");
  if (!workbookXml) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "XLSX package is missing xl/workbook.xml",
    );
  }
  const document = parseXml(workbookXml, "xl/workbook.xml");
  const rels = parseRelationships(parts, "xl/workbook.xml");
  const sheets: SheetInfo[] = [];
  for (const sheet of descendants(
    document.documentElement as Element,
    "sheet",
  )) {
    const name = attr(sheet, null, "name") ?? `Sheet${sheets.length + 1}`;
    const relId =
      attr(sheet, NS_X.officeDocument, "id") ?? attr(sheet, null, "r:id");
    const relationship = relId ? rels.get(relId) : undefined;
    const path = relationship
      ? resolvePartPath("xl/workbook.xml", relationship.target)
      : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, path });
  }
  return sheets;
}

function inlineTextOf(element: Element): string {
  // Shared/inline strings can be rich text: concatenate every `t` run.
  return descendants(element, "t")
    .map((node) => textOf(node))
    .join("");
}

interface SheetTable {
  cells: string[][];
  columnCount: number;
  rowCount: number;
  formulas: number;
  dates: number;
  widths: Map<number, number>;
}

function readWorksheet(
  parts: Map<string, Buffer>,
  sheet: SheetInfo,
  shared: string[],
  losses: LossCollector,
): SheetTable {
  const xml = readText(parts, sheet.path);
  if (!xml) {
    losses.unsupported(
      "xlsx.sheet",
      "Worksheet part is missing from the package",
      sheet.path,
      false,
    );
    return {
      cells: [],
      columnCount: 0,
      rowCount: 0,
      formulas: 0,
      dates: 0,
      widths: new Map(),
    };
  }
  const document = parseXml(xml, sheet.path);
  const root = document.documentElement as Element;
  const rows = descendants(root, "row");
  const cells: string[][] = [];
  let columnCount = 0;
  let formulas = 0;
  let dates = 0;
  let cellBudget = MAX_SHEET_CELLS;

  for (const row of rows.slice(0, MAX_SHEET_ROWS)) {
    const rowIndex = Math.max(
      0,
      Number(attr(row, null, "r") ?? rows.indexOf(row) + 1) - 1,
    );
    if (rowIndex >= MAX_SHEET_ROWS) continue;
    const values: string[] = [];
    for (const cell of childElements(row)) {
      if (localNameOf(cell) !== "c") continue;
      if (cellBudget <= 0) break;
      cellBudget -= 1;
      const reference = attr(cell, null, "r") ?? "";
      const index = reference ? columnIndex(reference) : values.length;
      if (index >= MAX_SHEET_COLUMNS) continue;
      const type = attr(cell, null, "t") ?? "n";
      let value = "";
      if (type === "s") {
        const sharedIndex = Number(textOf(first(cell, NS_X.spreadsheet, "v")));
        value = Number.isFinite(sharedIndex) ? (shared[sharedIndex] ?? "") : "";
      } else if (type === "inlineStr") {
        const inline = first(cell, NS_X.spreadsheet, "is");
        value = inline ? inlineTextOf(inline) : "";
      } else {
        const v = first(cell, NS_X.spreadsheet, "v");
        value = v ? textOf(v) : "";
        if (type === "str" && v) value = textOf(v);
        if (type === "b")
          value = value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
        if (type === "d") dates += 1;
      }
      if (childElements(cell).some((child) => localNameOf(child) === "f")) {
        formulas += 1;
        // Cached value in `v` is what Excel last calculated; that is all we have.
      }
      while (values.length < index) values.push("");
      values[index] = value;
      columnCount = Math.max(columnCount, index + 1);
    }
    while (cells.length < rowIndex) cells.push([]);
    cells[rowIndex] = values;
  }

  // Column widths: Excel measures in "characters"; 7pt per character is the
  // conventional approximation for Calibri 11.
  const widths = new Map<number, number>();
  for (const cols of descendants(root, "cols")) {
    for (const col of childElements(cols)) {
      if (localNameOf(col) !== "col") continue;
      const width = Number(attr(col, null, "width"));
      if (!Number.isFinite(width) || width <= 0) continue;
      const min = Math.max(1, Number(attr(col, null, "min") ?? 1));
      const max = Math.max(min, Number(attr(col, null, "max") ?? min));
      for (
        let index = min - 1;
        index < Math.min(max, MAX_SHEET_COLUMNS);
        index += 1
      ) {
        widths.set(index, Math.min(600, width * 7));
      }
    }
  }
  const merges = descendants(root, "mergeCell");
  if (merges.length > 0) {
    losses.partial(
      "xlsx.mergedCells",
      "Merged cell ranges are flattened; the anchor cell keeps its value",
      sheet.name,
      false,
    );
  }
  return {
    cells,
    columnCount: Math.max(columnCount, 1),
    rowCount: cells.length,
    formulas,
    dates,
    widths,
  };
}

function sheetBlocks(
  ctx: DocumentContext,
  sheet: SheetInfo,
  table: SheetTable,
  losses: LossCollector,
): Block[] {
  const blocks: Block[] = [];
  const title = makeParagraph(
    ctx,
    [{ type: "text", text: `Sheet: ${sheet.name}`, props: {} }],
    { style: "Heading1" },
  );
  title.props = { outlineLevel: 0 };
  blocks.push(title);

  if (
    table.rowCount === 0 ||
    table.cells.every((row) => row.every((value) => value.length === 0))
  ) {
    losses.partial(
      "xlsx.emptySheet",
      "Worksheet has no populated cells",
      sheet.name,
      true,
    );
    blocks.push(makeParagraph(ctx, []));
    return blocks;
  }

  const columns = Math.max(1, Math.min(MAX_SHEET_COLUMNS, table.columnCount));
  const defaultWidth = contentWidthPt(ctx.doc) / columns;
  const grid = new Array(columns)
    .fill(defaultWidth)
    .map((_, index) => table.widths.get(index) ?? defaultWidth);
  const rowSpecs: TableCellSpec[][] = [];
  for (let rowIndex = 0; rowIndex < table.cells.length; rowIndex += 1) {
    const row = table.cells[rowIndex] ?? [];
    const specs: TableCellSpec[] = [];
    for (let column = 0; column < columns; column += 1) {
      const text = row[column] ?? "";
      const inlines: Inline[] = [];
      pushText(inlines, text, {});
      specs.push({
        blocks: [makeParagraph(ctx, inlines)],
        props: { width: { value: grid[column], type: "dxa" } },
      });
    }
    rowSpecs.push(specs);
  }
  const built: Table = buildTable(ctx, rowSpecs, {
    columns,
    columnWidths: grid,
    headerRows: 1,
    style: "TableGrid",
  });
  blocks.push(built);
  return blocks;
}

/** Imports a spreadsheet as a preview document: one section per sheet. */
export async function importXlsxPreview(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `XLSX input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  if (!isZip(buffer)) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "XLSX input is not a ZIP package",
    );
  }
  const pkg = await readPackage(buffer);
  if (pkg.isEncrypted)
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "Encrypted workbooks are not supported",
    );
  const parts = pkg.parts;
  const losses = new LossCollector();
  const shared = sharedStrings(parts);
  const sheets = workbookSheets(parts);
  if (sheets.length === 0)
    losses.partial(
      "xlsx.sheets",
      "Workbook declares no worksheets",
      undefined,
      false,
    );

  const ctx = createDocumentContext({
    metadata: {
      title: titleFromName(options.fileName) ?? "Spreadsheet preview",
      custom: { DSHPreview: "true" },
    },
  });
  ensureStyle(ctx.doc, {
    id: "TableGrid",
    name: "Table Grid",
    type: "table",
  });

  let totalFormulas = 0;
  let totalDates = 0;
  const sheetSummaries: Array<{ name: string; rows: number; columns: number }> =
    [];
  sheets.slice(0, 50).forEach((sheet, index) => {
    const table = readWorksheet(parts, sheet, shared, losses);
    totalFormulas += table.formulas;
    totalDates += table.dates;
    sheetSummaries.push({
      name: sheet.name,
      rows: table.rowCount,
      columns: table.columnCount,
    });
    const blocks = sheetBlocks(ctx, sheet, table, losses);
    if (index === 0) {
      ctx.blocks.push(...blocks);
    } else {
      const target: Block[] = [];
      appendSection(ctx, target, { breakBefore: "nextPage" });
      target.push(...blocks);
    }
  });
  if (sheets.length > 50) {
    losses.unsupported(
      "xlsx.sheetLimit",
      "Only the first 50 worksheets are previewed",
      undefined,
      false,
    );
  }

  losses.partial(
    "xlsx.formula",
    "Formulas are shown as their cached values; the model has no calculation engine",
    undefined,
    true,
  );
  losses.unsupported(
    "xlsx.chart",
    "Charts are not rendered in the preview",
    undefined,
    false,
  );
  losses.unsupported(
    "xlsx.image",
    "Images and shapes are not rendered in the preview",
    undefined,
    false,
  );
  losses.unsupported(
    "xlsx.conditionalFormat",
    "Conditional formatting and number formats are not applied",
    undefined,
    false,
  );
  if (totalDates > 0) {
    losses.partial(
      "xlsx.date",
      "Date cells are shown as their raw serial value or cached text",
      undefined,
      true,
    );
  }

  ctx.syncIds();
  const doc = ctx.doc;
  previewMarker(doc);
  doc.settings.compatibilityMode = "15";

  const features: FeatureSupport[] = [
    {
      feature: "preview.only",
      label: "Preview document",
      level: "partial",
      occurrences: 1,
      notes:
        "The spreadsheet is projected into a readable document; it is not a spreadsheet editor",
    },
    {
      feature: "xlsx.sheet",
      label: "Worksheets",
      level: "partial",
      occurrences: sheets.length,
    },
    {
      feature: "table",
      label: "Cell tables",
      level: "partial",
      occurrences: sheets.length,
    },
    {
      feature: "xlsx.sharedStrings",
      label: "Shared strings",
      level: "full",
      occurrences: shared.length,
    },
    {
      feature: "xlsx.formula",
      label: "Formulas (cached values)",
      level: "partial",
      occurrences: totalFormulas,
    },
  ];
  const lossesList = losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "xlsx-preview",
    fileName: options.fileName,
    features,
    losses: lossesList,
    unknownElements: [],
  });
  return importResult(doc, lossesList, [
    "Spreadsheet preview: one section per sheet with a heading and a table of cached cell values.",
  ]);
}

function titleFromName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : undefined;
}

/* ----------------------------------------------------------------- PPTX */

interface SlideInfo {
  index: number;
  path: string;
}

function presentationSlides(parts: Map<string, Buffer>): {
  slides: SlideInfo[];
  width?: number;
  height?: number;
} {
  const presentationXml = readText(parts, "ppt/presentation.xml");
  if (!presentationXml) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "PPTX package is missing ppt/presentation.xml",
    );
  }
  const document = parseXml(presentationXml, "ppt/presentation.xml");
  const root = document.documentElement as Element;
  const rels = parseRelationships(parts, "ppt/presentation.xml");
  const slides: SlideInfo[] = [];
  for (const slideId of descendants(root, "sldId")) {
    const relId =
      attr(slideId, NS_X.officeDocument, "id") ?? attr(slideId, null, "r:id");
    const relationship = relId ? rels.get(relId) : undefined;
    if (!relationship) continue;
    slides.push({
      index: slides.length + 1,
      path: resolvePartPath("ppt/presentation.xml", relationship.target),
    });
  }
  const size = first(root, NS_X.presentation, "sldSz");
  const cx = Number(attr(size, null, "cx") ?? 0);
  const cy = Number(attr(size, null, "cy") ?? 0);
  return {
    slides,
    width: cx > 0 ? emuToPt(cx) : undefined,
    height: cy > 0 ? emuToPt(cy) : undefined,
  };
}

function paragraphFromTextBody(
  ctx: DocumentContext,
  textBody: Element,
  style: string,
  losses: LossCollector,
): Block[] {
  const blocks: Block[] = [];
  for (const paragraphNode of childElements(textBody)) {
    if (localNameOf(paragraphNode) !== "p") continue;
    const inlines: Inline[] = [];
    let bullet: "bullet" | "number" | undefined;
    const properties = childElements(paragraphNode).find(
      (child) => localNameOf(child) === "pPr",
    );
    if (properties) {
      for (const child of childElements(properties)) {
        const name = localNameOf(child);
        if (name === "buChar") bullet = "bullet";
        else if (name === "buAutoNum") bullet = "number";
      }
    }
    for (const child of childElements(paragraphNode)) {
      const name = localNameOf(child);
      if (name === "r" || name === "fld") {
        const runProperties = childElements(child).find(
          (entry) => localNameOf(entry) === "rPr",
        );
        const runProps: import("../model/types.js").RunProps = {};
        if (runProperties) {
          if (attr(runProperties, null, "b") === "1") runProps.bold = true;
          if (attr(runProperties, null, "i") === "1") runProps.italic = true;
          if (attr(runProperties, null, "u") === "sng")
            runProps.underline = "single";
          if (attr(runProperties, null, "strike") === "sngStrike")
            runProps.strike = true;
          const color = descendants(runProperties, "srgbClr")[0];
          if (color)
            runProps.color = `#${(attr(color, null, "val") ?? "000000").toLowerCase()}`;
        }
        const textNodes = descendants(child, "t");
        if (textNodes.length > 0)
          pushText(
            inlines,
            textNodes.map((node) => textOf(node)).join(""),
            runProps,
          );
        continue;
      }
      if (name === "br") {
        inlines.push({ type: "break", kind: "line" });
        continue;
      }
    }
    const props: ParagraphProps = {};
    if (bullet) {
      const numId = createListDefinition(ctx.doc, { kind: bullet });
      props.numbering = { numId, level: 0 };
      props.indent = { left: 36, hanging: 18 };
    }
    const text = inlines
      .map((inline) =>
        inline.type === "text"
          ? inline.text
          : inline.type === "break"
            ? "\n"
            : "",
      )
      .join("");
    if (text.trim().length === 0 && !bullet) {
      blocks.push(makeParagraph(ctx, []));
      continue;
    }
    blocks.push(makeParagraph(ctx, inlines, { style, props }));
    if (bullet)
      losses.partial(
        "pptx.bullets",
        "Slide bullets become document list items",
        undefined,
        true,
      );
  }
  return blocks;
}

function placeholderStyle(shape: Element): string {
  const placeholder = descendants(shape, "ph")[0];
  const type = attr(placeholder, null, "type") ?? "";
  if (type === "title" || type === "ctrTitle") return "Title";
  if (type === "subTitle") return "Subtitle";
  return "Normal";
}

function slideBlocks(
  ctx: DocumentContext,
  slideXml: Element,
  slidePath: string,
  parts: Map<string, Buffer>,
  losses: LossCollector,
): Block[] {
  const blocks: Block[] = [];
  const slideRels = parseRelationships(parts, slidePath);
  const tree = descendants(slideXml, "spTree")[0];
  if (!tree) return blocks;

  const visit = (node: Element) => {
    for (const shape of childElements(node)) {
      const name = localNameOf(shape);
      if (name === "grpSp" || name === "spTree") {
        visit(shape);
        continue;
      }
      if (name === "sp") {
        const textBody = descendants(shape, "txBody")[0];
        if (textBody) {
          blocks.push(
            ...paragraphFromTextBody(
              ctx,
              textBody,
              placeholderStyle(shape),
              losses,
            ),
          );
        }
        continue;
      }
      if (name === "graphicFrame") {
        const tableNode = descendants(shape, "tbl")[0];
        if (tableNode) {
          const built = pptxTable(ctx, tableNode, losses);
          if (built) blocks.push(built);
          continue;
        }
        const graphicData = descendants(shape, "graphicData")[0];
        const uri = attr(graphicData, null, "uri") ?? "";
        losses.unsupported(
          "pptx.chart",
          `Graphic frames are not rendered (${uri.includes("chart") ? "chart" : "diagram"})`,
          slidePath,
          false,
        );
        continue;
      }
      if (name === "pic") {
        const image = pptxImage(
          ctx,
          shape,
          slideRels,
          parts,
          losses,
          slidePath,
        );
        if (image) blocks.push(makeParagraph(ctx, [image]));
        continue;
      }
      if (name === "cxnSp" || name === "contentPart") {
        losses.fallback(
          "pptx.shape",
          "Connectors and embedded content parts are not rendered",
          slidePath,
          false,
        );
      }
    }
  };
  visit(tree);
  if (blocks.length === 0) blocks.push(makeParagraph(ctx, []));
  return blocks;
}

function pptxTable(
  ctx: DocumentContext,
  tableNode: Element,
  losses: LossCollector,
): Table | undefined {
  const rows: TableCellSpec[][] = [];
  for (const row of childElements(tableNode)) {
    if (localNameOf(row) !== "tr") continue;
    const specs: TableCellSpec[] = [];
    for (const cell of childElements(row)) {
      if (localNameOf(cell) !== "tc") continue;
      const textBody = descendants(cell, "txBody")[0];
      const blocks = textBody
        ? paragraphFromTextBody(ctx, textBody, "Normal", losses)
        : [];
      specs.push({
        blocks: blocks.length > 0 ? blocks : [makeParagraph(ctx, [])],
      });
    }
    if (specs.length > 0) rows.push(specs);
  }
  if (rows.length === 0) return undefined;
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const width = contentWidthPt(ctx.doc) / columns;
  return buildTable(ctx, rows, {
    columns,
    columnWidths: new Array(columns).fill(width),
  });
}

function pptxImage(
  ctx: DocumentContext,
  shape: Element,
  rels: Map<string, Relationship>,
  parts: Map<string, Buffer>,
  losses: LossCollector,
  slidePath: string,
): Inline | undefined {
  const blip = descendants(shape, "blip")[0];
  const relId = blip
    ? (attr(blip, NS_X.relationship, "embed") ?? attr(blip, null, "r:embed"))
    : undefined;
  const relationship = relId ? rels.get(relId) : undefined;
  if (!relationship) {
    losses.partial(
      "pptx.image",
      "Slide picture has no resolvable media relationship",
      slidePath,
      false,
    );
    return undefined;
  }
  const path = resolvePartPath(slidePath, relationship.target);
  const data = parts.get(path);
  if (!data) {
    losses.partial(
      "pptx.image",
      "Slide picture payload is missing from the package",
      path,
      false,
    );
    return undefined;
  }
  const extent = descendants(shape, "ext")[0];
  const cx = Number(attr(extent, null, "cx") ?? 0);
  const cy = Number(attr(extent, null, "cy") ?? 0);
  return addImageInline(ctx, {
    data,
    fileName: path.split("/").pop(),
    width: cx > 0 ? emuToPt(cx) : undefined,
    height: cy > 0 ? emuToPt(cy) : undefined,
    alt: descendants(shape, "cNvPr")
      .map((node) => attr(node, null, "descr") ?? "")
      .find((value) => value.length > 0),
  });
}

/** Imports a presentation as a preview document: one section per slide. */
export async function importPptxPreview(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `PPTX input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  if (!isZip(buffer)) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "PPTX input is not a ZIP package",
    );
  }
  const pkg = await readPackage(buffer);
  if (pkg.isEncrypted)
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "Encrypted presentations are not supported",
    );
  const parts = pkg.parts;
  const losses = new LossCollector();
  const presentation = presentationSlides(parts);
  if (presentation.slides.length === 0) {
    losses.partial(
      "pptx.slides",
      "Presentation declares no slides",
      undefined,
      false,
    );
  }

  const ctx = createDocumentContext({
    metadata: {
      title: titleFromName(options.fileName) ?? "Presentation preview",
      custom: { DSHPreview: "true" },
    },
    page:
      presentation.width && presentation.height
        ? {
            width: presentation.width,
            height: presentation.height,
            orientation:
              presentation.width > presentation.height
                ? "landscape"
                : "portrait",
            margins: {
              top: 36,
              right: 36,
              bottom: 36,
              left: 36,
              header: 18,
              footer: 18,
              gutter: 0,
            },
            preset: "custom",
          }
        : undefined,
  });

  const total = presentation.slides.length;
  presentation.slides.slice(0, MAX_SLIDES).forEach((slide, index) => {
    const xml = readText(parts, slide.path);
    const blocks: Block[] = [
      makeParagraph(
        ctx,
        [{ type: "text", text: `Slide ${slide.index}`, props: {} }],
        {
          style: "Heading1",
          props: { outlineLevel: 0 },
        },
      ),
    ];
    if (xml) {
      const document = parseXml(xml, slide.path);
      blocks.push(
        ...slideBlocks(
          ctx,
          document.documentElement as Element,
          slide.path,
          parts,
          losses,
        ),
      );
    } else {
      losses.unsupported(
        "pptx.slide",
        "Slide part is missing from the package",
        slide.path,
        false,
      );
    }
    if (index === 0) {
      ctx.blocks.push(...blocks);
    } else {
      const target: Block[] = [];
      appendSection(ctx, target, { breakBefore: "nextPage" });
      target.push(...blocks);
    }
  });
  if (total > MAX_SLIDES) {
    losses.unsupported(
      "pptx.slideLimit",
      `Only the first ${MAX_SLIDES} slides are previewed`,
      undefined,
      false,
    );
  }
  losses.unsupported(
    "pptx.notes",
    "Speaker notes are not previewed",
    undefined,
    false,
  );
  losses.unsupported(
    "pptx.transition",
    "Animations, transitions and slide masters are not rendered",
    undefined,
    false,
  );

  ctx.syncIds();
  const doc = ctx.doc;
  previewMarker(doc);
  doc.settings.compatibilityMode = "15";

  const features: FeatureSupport[] = [
    {
      feature: "preview.only",
      label: "Preview document",
      level: "partial",
      occurrences: 1,
      notes:
        "The presentation is projected into a readable document; it is not a slide editor",
    },
    {
      feature: "pptx.slide",
      label: "Slides",
      level: "partial",
      occurrences: total,
    },
    {
      feature: "pptx.text",
      label: "Slide text frames",
      level: "full",
      occurrences: total,
    },
    {
      feature: "pptx.table",
      label: "Slide tables",
      level: "partial",
      occurrences: total,
    },
  ];
  const lossesList = losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "pptx-preview",
    fileName: options.fileName,
    features,
    losses: lossesList,
    unknownElements: [],
  });
  return importResult(doc, lossesList, [
    "Presentation preview: one section per slide with a heading, slide text and tables.",
  ]);
}

/* ------------------------------------------------------------ descriptors */

const XLSX_CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: false,
  styles: "none",
  tables: "partial",
  images: "none",
  hyperlinks: "none",
  headersFooters: "none",
  pageLayout: "none",
  numbering: "none",
  metadata: "partial",
  comments: "none",
  trackedChanges: "none",
  math: "none",
  notes: [
    "Preview only: one section per worksheet with a heading and a table of cached cell values.",
    "Formulas are shown as their cached values; charts, images and number formats are not rendered.",
  ],
};

const PPTX_CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: false,
  styles: "partial",
  tables: "partial",
  images: "partial",
  hyperlinks: "none",
  headersFooters: "none",
  pageLayout: "partial",
  numbering: "partial",
  metadata: "partial",
  comments: "none",
  trackedChanges: "none",
  math: "none",
  notes: [
    "Preview only: one section per slide with a 'Slide N' heading, text frames and tables.",
    "Images are embedded; charts, SmartArt, notes and transitions are reported as losses.",
  ],
};

const XLSX_EXTENSIONS = ["xlsx", "xlsm", "xltx", "xltm"];
const PPTX_EXTENSIONS = ["pptx", "pptm", "potx", "potm"];

function zipPrefixHas(bytes: Buffer, needle: string): boolean {
  if (!isZip(bytes)) return false;
  return bytes
    .subarray(0, Math.min(bytes.length, 4096))
    .toString("latin1")
    .includes(needle);
}

/** XLSX preview format descriptor. */
export const xlsxPreviewAdapter: FormatAdapter = {
  id: "xlsx-preview",
  label: "Excel workbook (preview)",
  extensions: XLSX_EXTENSIONS,
  mimeTypes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  readOnly: true,
  capabilities: XLSX_CAPABILITIES,
  detect(bytes, fileName) {
    if (XLSX_EXTENSIONS.includes(extensionOf(fileName))) return true;
    return zipPrefixHas(bytes, "xl/") || zipPrefixHas(bytes, "spreadsheetml");
  },
  import: importXlsxPreview,
};

/** PPTX preview format descriptor. */
export const pptxPreviewAdapter: FormatAdapter = {
  id: "pptx-preview",
  label: "PowerPoint presentation (preview)",
  extensions: PPTX_EXTENSIONS,
  mimeTypes: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  readOnly: true,
  capabilities: PPTX_CAPABILITIES,
  detect(bytes, fileName) {
    if (PPTX_EXTENSIONS.includes(extensionOf(fileName))) return true;
    return zipPrefixHas(bytes, "ppt/") || zipPrefixHas(bytes, "presentationml");
  },
  import: importPptxPreview,
};

/** Exposed for tests: the marker property key written by both previews. */
export const PREVIEW_MARKER_KEY = "DSHPreview";
