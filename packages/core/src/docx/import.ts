import type { Element } from "@xmldom/xmldom";
import type {
  Block,
  CompatibilityReport,
  DocComment,
  DocDocument,
  FeatureSupport,
  HeaderFooter,
  HeaderFooterSet,
  LossEntry,
  MediaAsset,
  Note,
  Section,
  Shape,
  ShapeTextBox,
  Theme,
  TocBlock,
  UnknownPart,
} from "../model/types.js";
import { DOCUMENT_SCHEMA_VERSION } from "../model/types.js";
import { createDefaultStyles } from "../model/create.js";
import { makeIdFactory } from "../model/ids.js";
import { blocksText } from "../model/text.js";
import { readPackage, readText, resolvePartPath } from "./package.js";
import { FormatError } from "../formats/types.js";
import {
  NS,
  all,
  childElements,
  first,
  localNameOf,
  parseXml,
  textOf,
  wAttr,
  wVal,
} from "./xml.js";
import {
  metadataFromParts,
  parseAppProperties,
  parseCoreProperties,
  parseNumbering,
  parseRelationships,
  parseSectionProperties,
  parseSettings,
  parseStyles,
  parseTheme,
  tocFromInstruction,
  type RelationshipMap,
  type SectionSkeleton,
} from "./parsers.js";
import {
  BodyParser,
  type BodyParserHost,
  type SectionSector,
} from "./import-body.js";

export interface ImportOptions {
  fileName?: string;
  /** Force a declared format instead of extension detection. */
  format?: "docx" | "dotx" | "docm";
}

export interface ImportResult {
  document: DocDocument;
  report: CompatibilityReport;
  warnings: string[];
  packageDigest: string;
  /** Parts that exist in the package but are not mapped into the model. */
  unmappedParts: string[];
}

interface FeatureMeta {
  label: string;
  level: FeatureSupport["level"];
  notes?: string;
}

const FEATURE_REGISTRY: Record<string, FeatureMeta> = {
  "paragraph.style": { label: "Paragraph styles", level: "full" },
  "paragraph.borders": { label: "Paragraph borders", level: "full" },
  "paragraph.shading": { label: "Paragraph shading", level: "full" },
  "paragraph.tabs": {
    label: "Tab stops",
    level: "partial",
    notes:
      "Positions and leaders supported; absolute-position tabs collapse to tabs",
  },
  "paragraph.frame": { label: "Framed paragraphs", level: "partial" },
  "lists.numbering": { label: "Lists and numbering", level: "full" },
  "table.borders": { label: "Table borders", level: "full" },
  "table.mergedCells": { label: "Merged table cells", level: "full" },
  "table.headerRow": { label: "Repeating header rows", level: "full" },
  "image.inline": { label: "Inline images", level: "full" },
  "image.floating": { label: "Floating images", level: "full" },
  "image.vml": {
    label: "VML images",
    level: "partial",
    notes: "Converted to images with CSS-derived geometry",
  },
  "shape.textBox": {
    label: "Text boxes",
    level: "partial",
    notes: "Content renders; preset shape geometry approximates to rectangles",
  },
  "shape.group": {
    label: "Grouped drawings",
    level: "fallback",
    notes: "Preserved and rendered as a placeholder",
  },
  "shape.vmlRect": { label: "VML shapes", level: "fallback" },
  chart: {
    label: "Charts",
    level: "fallback",
    notes: "Preserved and rendered as a labelled placeholder",
  },
  smartArt: {
    label: "SmartArt",
    level: "fallback",
    notes: "Preserved and rendered as a labelled placeholder",
  },
  ole: {
    label: "Embedded OLE objects",
    level: "fallback",
    notes: "Preserved, never executed",
  },
  math: {
    label: "Equations (OMML)",
    level: "partial",
    notes:
      "Common OMML constructs render; unsupported constructs fall back to linear text",
  },
  fields: {
    label: "Fields",
    level: "partial",
    notes:
      "PAGE/NUMPAGES/TOC/PAGEREF/SEQ recomputed; unknown fields show cached results",
  },
  hyperlink: { label: "Hyperlinks", level: "full" },
  footnote: { label: "Footnotes", level: "full" },
  endnote: { label: "Endnotes", level: "full" },
  comment: { label: "Comments", level: "full" },
  "revisions.insert": { label: "Tracked insertions", level: "full" },
  "revisions.delete": { label: "Tracked deletions", level: "full" },
  pageBreak: { label: "Page breaks", level: "full" },
  columnBreak: { label: "Column breaks", level: "full" },
  "block.contentControl": {
    label: "Block content controls",
    level: "partial",
    notes: "Content renders; wrapper semantics recorded, not re-exported",
  },
  "inline.contentControl": {
    label: "Inline content controls",
    level: "partial",
  },
  "block.customXml": { label: "Custom XML blocks", level: "partial" },
  "block.altChunk": {
    label: "altChunk",
    level: "unsupported",
    notes:
      "Recorded but not expanded; content stays inside the preserved chunk",
  },
  symbol: { label: "Symbols", level: "partial" },
  "tab.absolutePosition": {
    label: "Absolute position tabs",
    level: "partial",
    notes: "Rendered as a tab stop",
  },
  toc: {
    label: "Table of contents",
    level: "full",
    notes:
      "Detected from the TOC field; page numbers recomputed by the layout engine",
  },
  header: { label: "Headers", level: "full" },
  footer: { label: "Footers", level: "full" },
  "header.firstPage": {
    label: "Different first-page header/footer",
    level: "full",
  },
  "header.evenOdd": {
    label: "Different odd/even headers/footers",
    level: "full",
  },
  "page.borders": { label: "Page borders", level: "full" },
  "page.numbering": {
    label: "Section page numbering",
    level: "partial",
    notes:
      "Start values and formats are preserved; the preview shows decimal numbers",
  },
  columns: { label: "Multiple columns", level: "full" },
};

const UNMAPPED_PART_PATTERNS: RegExp[] = [
  /^word\/glossary\/document\.xml$/,
  /^word\/people\.xml$/,
  /^word\/vbaProject\.bin$/,
  /^word\/activeX\//,
  /^word\/embeddings\//,
  /^customXml\/itemProps\d+\.xml$/,
  /^word\/webSettings\.xml$/,
  /^word\/fontTable\.xml$/,
  /^word\/stylesWithEffects\.xml$/,
  /^docProps\/thumbnail\./,
  /^_rels\//,
  /^\[Content_Types\]\.xml$/,
];

const PART_DESCRIPTIONS: Array<{
  pattern: RegExp;
  label: string;
  level: FeatureSupport["level"];
}> = [
  {
    pattern: /^word\/vbaProject\.bin$/,
    label: "VBA macros",
    level: "unsupported",
  },
  {
    pattern: /^word\/activeX\//,
    label: "ActiveX controls",
    level: "unsupported",
  },
  {
    pattern: /^word\/embeddings\//,
    label: "Embedded packages",
    level: "unsupported",
  },
  {
    pattern: /^word\/glossary\/document\.xml$/,
    label: "Glossary document",
    level: "unsupported",
  },
  {
    pattern: /^word\/people\.xml$/,
    label: "Comment author roster",
    level: "partial",
  },
  { pattern: /^customXml\//, label: "Custom XML data", level: "unsupported" },
  { pattern: /^word\/charts\//, label: "Chart parts", level: "fallback" },
  { pattern: /^word\/diagrams\//, label: "SmartArt data", level: "fallback" },
  {
    pattern: /^docProps\/thumbnail\./,
    label: "Thumbnail",
    level: "unsupported",
  },
];

/**
 * Imports a WordprocessingML package into the shared document model.
 * Unknown constructs are preserved verbatim and reported; nothing is dropped
 * silently.
 */
export async function importDocx(
  bytes: Buffer | Uint8Array,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const label = options.fileName ? `"${options.fileName}"` : "the document";
  const pkg = await readPackage(bytes, { fileName: options.fileName });
  if (pkg.isEncrypted) {
    throw new FormatError(
      "FORMAT_UNSUPPORTED",
      `${label} is an OLE compound document (encrypted DOCX or legacy .doc). Decrypt it, or convert it with the legacy DOC importer.`,
    );
  }
  const parts = pkg.parts;
  const warnings: string[] = [];

  const rootRels = parseRelationships(readText(parts, "_rels/.rels"), "");
  let mainPath = "word/document.xml";
  for (const rel of rootRels.values()) {
    if (rel.type.endsWith("/officeDocument") && rel.resolvedPath) {
      mainPath = rel.resolvedPath;
      break;
    }
  }
  validateContentTypes(parts, mainPath, label);
  const mainXml = readText(parts, mainPath);
  if (!mainXml)
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} does not contain a Word main document part (looked for ${mainPath})`,
    );

  const documentPartDir = mainPath.split("/").slice(0, -1).join("/");
  const relsCache = new Map<string, RelationshipMap>();
  const relationshipsFor = (partPath: string): RelationshipMap => {
    const cached = relsCache.get(partPath);
    if (cached) return cached;
    const segments = partPath.split("/");
    const fileName = segments.pop() ?? "";
    const relPath = [...segments, "_rels", `${fileName}.rels`].join("/");
    const relXml = readText(parts, relPath);
    const map = parseRelationships(relXml, partPath);
    relsCache.set(partPath, map);
    return map;
  };
  const documentRels = relationshipsFor(mainPath);

  const findRelated = (suffix: string): string | undefined => {
    for (const rel of documentRels.values()) {
      if (rel.type.endsWith(suffix) && rel.resolvedPath)
        return rel.resolvedPath;
    }
    return undefined;
  };

  const themePath = findRelated("/theme");
  const theme: Theme = parseTheme(
    readText(parts, themePath ?? "word/theme/theme1.xml"),
  );
  const numbering = parseNumbering(
    readText(parts, findRelated("/numbering") ?? "word/numbering.xml"),
  );
  const styles = parseStyles(
    readText(parts, findRelated("/styles") ?? "word/styles.xml"),
    theme,
    numbering,
  );
  const settings = parseSettings(
    readText(parts, findRelated("/settings") ?? "word/settings.xml"),
  );

  const corePath = rootRels.get("rId1")?.resolvedPath;
  const core = parseCoreProperties(
    readText(parts, corePath ?? "docProps/core.xml"),
  );
  const appProps = parseAppProperties(readText(parts, "docProps/app.xml"));

  const idFactory = makeIdFactory(0);
  const media: MediaAsset[] = [];
  const mediaByPath = new Map<string, string>();
  const footnotes: Note[] = [];
  const endnotes: Note[] = [];
  const comments: DocComment[] = [];
  const revisions: DocDocument["revisions"] = [];
  const bookmarks: DocDocument["bookmarks"] = [];
  const shapes: Shape[] = [];
  const unknown: UnknownPart[] = [];
  const features = new Map<string, number>();
  const unknownElements = new Map<
    string,
    { count: number; location?: string }
  >();

  const host: BodyParserHost = {
    nextId: (prefix) => idFactory.next(prefix),
    relationshipsFor,
    readPart: (path) => parts.get(path),
    media: {
      register: (target) => {
        const id = idFactory.next("img");
        media.push({
          id,
          fileName: target.fileName,
          contentType: target.contentType,
          data: target.data.toString("base64"),
          byteLength: target.data.byteLength,
          widthPx: target.widthPx,
          heightPx: target.heightPx,
          dpi: target.dpi,
        });
        mediaByPath.set(target.path, id);
        return id;
      },
      lookup: (path) => mediaByPath.get(path),
    },
    notes: { footnotes, endnotes, commentIds: new Set() },
    comments,
    bookmarks,
    shapes,
    revisions,
    unknown,
    recordFeature: (feature) => {
      features.set(feature, (features.get(feature) ?? 0) + 1);
    },
    warn: (message) => warnings.push(message),
    recordUnknownElement: (location, element, xml, reason) => {
      unknown.push({
        id: idFactory.next("unk"),
        location,
        element,
        xml,
        reason,
      });
      const entry = unknownElements.get(element) ?? { count: 0, location };
      entry.count += 1;
      unknownElements.set(element, entry);
    },
    registerShape: (shape) => {
      shapes.push(shape);
      return shape.id;
    },
    theme,
    styles,
    numbering,
  };

  const bodyParser = new BodyParser(host);

  // Attachments first so note references can be remapped while building the body.
  const footnotesPath = findRelated("/footnotes");
  const endnotesPath = findRelated("/endnotes");
  const footnoteMap = new Map<string, string>();
  const endnoteMap = new Map<string, string>();
  if (footnotesPath) {
    const xml = readText(parts, footnotesPath);
    if (xml) {
      const parsed = bodyParser.parseNotePart(xml, footnotesPath, "footnote");
      footnotes.push(...parsed.notes);
      for (const [from, to] of parsed.idMap) footnoteMap.set(from, to);
    }
  }
  if (endnotesPath) {
    const xml = readText(parts, endnotesPath);
    if (xml) {
      const parsed = bodyParser.parseNotePart(xml, endnotesPath, "endnote");
      endnotes.push(...parsed.notes);
      for (const [from, to] of parsed.idMap) endnoteMap.set(from, to);
    }
  }

  const commentsPath = findRelated("/comments");
  if (commentsPath) {
    const xml = readText(parts, commentsPath);
    if (xml) {
      const extended = readText(parts, "word/commentsExtended.xml");
      comments.push(
        ...bodyParser.parseCommentsPart(xml, commentsPath, extended),
      );
      for (const comment of comments) host.notes.commentIds.add(comment.id);
    }
  }

  // Body
  const documentXml = parseXml(mainXml, mainPath);
  const bodyElement = first(documentXml.documentElement, NS.w, "body");
  if (!bodyElement)
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} main document part (${mainPath}) has no w:body element`,
    );
  const bodyChildren = childElements(bodyElement);

  const tocRanges = findTocRanges(bodyChildren);
  const tocStart = new Map<number, { end: number; block: TocBlock }>();
  for (const range of tocRanges) {
    const parsed = tocFromInstruction(range.instr);
    if (!parsed) continue;
    parsed.id = idFactory.next("toc");
    parsed.caption = undefined;
    tocStart.set(range.start, { end: range.end, block: parsed });
    features.set("toc", (features.get("toc") ?? 0) + 1);
  }

  interface SectionDraft {
    blocks: Block[];
    sector: SectionSector | undefined;
    /** True when the section is delimited by explicit section properties. */
    explicit: boolean;
  }
  const drafts: SectionDraft[] = [];
  let currentBlocks: Block[] = [];
  let sawFinalSectPr = false;

  for (let index = 0; index < bodyChildren.length; index += 1) {
    const tocInfo = tocStart.get(index);
    if (tocInfo) {
      currentBlocks.push(tocInfo.block);
      index = tocInfo.end;
      continue;
    }
    const element = bodyChildren[index];
    const name = localNameOf(element);
    if (name === "sectPr") {
      drafts.push({
        blocks: currentBlocks,
        sector: { element, props: {} },
        explicit: true,
      });
      currentBlocks = [];
      sawFinalSectPr = true;
      continue;
    }
    if (name === "p") {
      const parsed = bodyParser.parseParagraph(
        element,
        {
          theme,
          styles,
          numbering,
          relationships: documentRels,
          partPath: mainPath,
        },
        `body/p[${index}]`,
      );
      const previous = currentBlocks[currentBlocks.length - 1];
      // The exporter (like Word) marks the end of a section whose last block is
      // a table, or of an empty section, with a run-less paragraph that only
      // carries w:sectPr. Such a carrier is not body content; dropping it keeps
      // the model structure intact instead of injecting an empty paragraph.
      const carrierOnly =
        parsed.paragraph.inlines.length === 0 &&
        !childElements(element).some((child) => localNameOf(child) !== "pPr");
      if (
        parsed.sector &&
        carrierOnly &&
        (currentBlocks.length === 0 || previous?.type !== "paragraph")
      ) {
        drafts.push({
          blocks: currentBlocks,
          sector: parsed.sector,
          explicit: true,
        });
        currentBlocks = [];
        continue;
      }
      currentBlocks.push(parsed.paragraph);
      if (parsed.sector) {
        drafts.push({
          blocks: currentBlocks,
          sector: parsed.sector,
          explicit: true,
        });
        currentBlocks = [];
      }
      continue;
    }
    if (name === "tbl") {
      currentBlocks.push(
        bodyParser.parseTable(
          element,
          {
            theme,
            styles,
            numbering,
            relationships: documentRels,
            partPath: mainPath,
          },
          `body/tbl[${index}]`,
        ),
      );
      continue;
    }
    if (name === "sdt" || name === "customXml" || name === "altChunk") {
      currentBlocks.push(
        ...bodyParser.parseBlocks(
          [element],
          mainPath,
          `body/${name}[${index}]`,
        ),
      );
      continue;
    }
    if (name === "bookmarkStart" || name === "bookmarkEnd") {
      if (name === "bookmarkStart") {
        const bookmarkName = wAttr(element, "name") ?? "";
        if (bookmarkName && !bookmarkName.startsWith("_")) {
          bookmarks.push({
            name: bookmarkName,
            id: wAttr(element, "id") ?? "",
            paragraphId: "",
          });
        }
      }
      continue;
    }
    // Unknown body-level element: preserve and report.
    host.recordUnknownElement(
      `body/${name}[${index}]`,
      `w:${name}`,
      textOf(element),
      `Unsupported body element <${name}>`,
    );
  }

  if (currentBlocks.length > 0 || drafts.length === 0) {
    drafts.push({ blocks: currentBlocks, sector: undefined, explicit: false });
  }
  if (!sawFinalSectPr && drafts.length > 0) {
    // No explicit final sectPr: use defaults for the last section.
    warnings.push(
      "Document body has no final section properties; A4 defaults applied",
    );
  }

  // Build sections, resolving header/footer parts with inheritance.
  const sections: Section[] = [];
  let previousHeaders: HeaderFooterSet = {};
  let previousFooters: HeaderFooterSet = {};
  let nextBreak: Section["breakBefore"] = "nextPage";

  /**
   * Word inherits a header/footer part into later sections by reference. The
   * model stores one object per section, so an inherited copy must receive fresh
   * part/block ids to keep structural ids globally unique.
   */
  const inheritPart = (
    part: HeaderFooter | undefined,
  ): HeaderFooter | undefined => {
    if (!part) return undefined;
    const clone = structuredClone(part);
    clone.id = idFactory.next("hf");
    rekeyBlockIds(idFactory, clone.blocks);
    return clone;
  };

  const parseHeaderFooterPart = (
    partPath: string,
    kind: "header" | "footer",
  ): HeaderFooter | undefined => {
    const xml = readText(parts, partPath);
    if (!xml) {
      warnings.push(`Missing ${kind} part ${partPath}`);
      return undefined;
    }
    const parsed = parseXml(xml, partPath);
    const root = parsed.documentElement;
    const blocks = bodyParser.parseBlocks(
      childElements(root),
      partPath,
      `${kind}:${partPath}`,
    );
    return { id: idFactory.next("hf"), blocks };
  };

  // Header/footer ids are referenced by rid; cache per rid so sections that
  // share a part share the same header object.
  const headerCache = new Map<string, HeaderFooter | undefined>();
  const footerCache = new Map<string, HeaderFooter | undefined>();

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const skeleton: SectionSkeleton = parseSectionProperties(
      draft.sector?.element,
    );
    const headers: HeaderFooterSet = {};
    const footers: HeaderFooterSet = {};

    for (const variant of ["default", "first", "even"] as const) {
      const headerRid = skeleton.headerRids[variant];
      if (headerRid) {
        const rel = documentRels.get(headerRid);
        if (rel?.resolvedPath) {
          if (!headerCache.has(headerRid)) {
            headerCache.set(
              headerRid,
              parseHeaderFooterPart(rel.resolvedPath, "header"),
            );
          }
          const part = headerCache.get(headerRid);
          if (part) headers[variant] = structuredClone(part);
        }
      }
      const footerRid = skeleton.footerRids[variant];
      if (footerRid) {
        const rel = documentRels.get(footerRid);
        if (rel?.resolvedPath) {
          if (!footerCache.has(footerRid)) {
            footerCache.set(
              footerRid,
              parseHeaderFooterPart(rel.resolvedPath, "footer"),
            );
          }
          const part = footerCache.get(footerRid);
          if (part) footers[variant] = structuredClone(part);
        }
      }
    }

    // Inherit missing variants from the previous section (Word behaviour).
    const effectiveHeaders: HeaderFooterSet = {
      default: headers.default ?? inheritPart(previousHeaders.default),
      first: headers.first ?? inheritPart(previousHeaders.first),
      even: headers.even ?? inheritPart(previousHeaders.even),
    };
    const effectiveFooters: HeaderFooterSet = {
      default: footers.default ?? inheritPart(previousFooters.default),
      first: footers.first ?? inheritPart(previousFooters.first),
      even: footers.even ?? inheritPart(previousFooters.even),
    };
    previousHeaders = effectiveHeaders;
    previousFooters = effectiveFooters;

    const section: Section = {
      id: idFactory.next("s"),
      blocks:
        draft.explicit || draft.blocks.length > 0
          ? draft.blocks
          : [emptyParagraph(idFactory)],
      page: skeleton.page,
      columns: skeleton.columns,
      headers: effectiveHeaders,
      footers: effectiveFooters,
      pageNumbering: skeleton.pageNumbering,
      breakBefore: nextBreak,
      titlePage:
        skeleton.titlePage ||
        Boolean(effectiveHeaders.first || effectiveFooters.first),
      evenAndOdd:
        skeleton.evenAndOdd ||
        Boolean(effectiveHeaders.even || effectiveFooters.even),
      footnoteRestart: skeleton.footnoteRestart,
      endnoteRestart: skeleton.endnoteRestart,
    };
    nextBreak = skeleton.breakBefore;
    sections.push(section);
    if (skeleton.page.borders)
      features.set("page.borders", (features.get("page.borders") ?? 0) + 1);
    if (skeleton.columns.count > 1)
      features.set("columns", (features.get("columns") ?? 0) + 1);
    if (skeleton.pageNumbering?.start !== undefined)
      features.set("page.numbering", (features.get("page.numbering") ?? 0) + 1);
    if (effectiveHeaders.default)
      features.set("header", (features.get("header") ?? 0) + 1);
    if (effectiveFooters.default)
      features.set("footer", (features.get("footer") ?? 0) + 1);
    if (effectiveHeaders.first || effectiveFooters.first)
      features.set(
        "header.firstPage",
        (features.get("header.firstPage") ?? 0) + 1,
      );
    if (effectiveHeaders.even || effectiveFooters.even)
      features.set("header.evenOdd", (features.get("header.evenOdd") ?? 0) + 1);
  }

  // Remap footnote / endnote ids to document ids.
  const remapNotes = (blocks: Block[]) => {
    const walk = (block: Block) => {
      if (block.type === "paragraph") {
        for (const inline of block.inlines) {
          if (inline.type === "noteRef") {
            const mapped =
              inline.noteType === "footnote"
                ? footnoteMap.get(inline.noteId)
                : endnoteMap.get(inline.noteId);
            if (mapped) inline.noteId = mapped;
          }
        }
      } else if (block.type === "table") {
        for (const row of block.rows)
          for (const cell of row.cells) cell.blocks.forEach(walk);
      }
    };
    blocks.forEach(walk);
  };
  for (const section of sections) {
    remapNotes(section.blocks);
    for (const set of [section.headers, section.footers]) {
      for (const variant of ["default", "first", "even"] as const) {
        const part = set[variant];
        if (part) remapNotes(part.blocks);
      }
    }
  }
  for (const note of [...footnotes, ...endnotes]) remapNotes(note.blocks);
  for (const shape of shapes) {
    if (shape.kind === "textbox") remapNotes(shape.blocks);
  }

  // Custom XML parts are preserved verbatim.
  const customXml: DocDocument["customXml"] = [];
  for (const path of parts.keys()) {
    if (/^customXml\/item\d+\.xml$/.test(path)) {
      const xml = readText(parts, path);
      if (xml) customXml.push({ itemPath: path, xml });
    }
  }
  const customProps: Record<string, string> = {};
  const customPropsXml = readText(parts, "docProps/custom.xml");
  if (customPropsXml) {
    try {
      const parsed = parseXml(customPropsXml, "custom.xml");
      for (const property of all(parsed.documentElement, NS.cp, "property")) {
        const name = wAttr(property, "name");
        if (!name) continue;
        const valueNode = childElements(property)[0];
        const value = valueNode ? textOf(valueNode) : "";
        if (value) customProps[name] = value;
      }
    } catch {
      warnings.push("docProps/custom.xml could not be parsed");
    }
  }

  const metadata = metadataFromParts(core, appProps);
  metadata.custom = customProps;

  // Determine unmapped parts for transparency.
  const unmappedParts: string[] = [];
  for (const path of parts.keys()) {
    if (path === mainPath) continue;
    if (
      path === findRelated("/styles") ||
      path === findRelated("/numbering") ||
      path === findRelated("/settings")
    )
      continue;
    if (path === findRelated("/theme")) continue;
    if (
      path === footnotesPath ||
      path === endnotesPath ||
      path === commentsPath
    )
      continue;
    if (
      path === "docProps/core.xml" ||
      path === "docProps/app.xml" ||
      path === "docProps/custom.xml"
    )
      continue;
    if (/^word\/media\//.test(path)) continue;
    if (/^word\/_rels\//.test(path)) continue;
    if (UNMAPPED_PART_PATTERNS.some((pattern) => pattern.test(path))) {
      // Known-but-unmapped parts: report the meaningful ones.
      const description = PART_DESCRIPTIONS.find((entry) =>
        entry.pattern.test(path),
      );
      if (description && description.level !== "unsupported") {
        features.set(
          `part:${description.label}`,
          (features.get(`part:${description.label}`) ?? 0) + 1,
        );
      } else if (description) {
        unknown.push({
          id: idFactory.next("unk"),
          location: `part:${path}`,
          element: path,
          xml: "",
          reason: `${description.label} preserved in the package but not represented in the document model`,
        });
      }
      continue;
    }
    if (
      /^word\/header\d+\.xml$/.test(path) ||
      /^word\/footer\d+\.xml$/.test(path)
    )
      continue;
    if (path === "word/commentsExtended.xml" || path === "word/people.xml")
      continue;
    unmappedParts.push(path);
  }

  const document: DocDocument = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: `doc-${idFactory.next("n")}`,
    metadata,
    theme,
    styles:
      Object.keys(styles.styles).length > 0 ? styles : createDefaultStyles(),
    numbering,
    sections,
    footnotes,
    endnotes,
    comments,
    revisions,
    bookmarks,
    shapes,
    media,
    customXml,
    settings,
    unknown,
    idSeq: idFactory.value(),
  };

  const report = buildReport({
    document,
    fileName: options.fileName,
    features,
    unknownElements,
    unmappedParts,
  });
  // XML 1.0 cannot carry lone UTF-16 surrogates, so they survive a DOCX
  // round-trip only as U+FFFD. Report that explicitly instead of pretending the
  // text was preserved (the JSON snapshot keeps the original code units).
  const replacedTexts: string[] = documentTextSectionsForImport(document);
  if (replacedTexts.some((text) => text.includes("\uFFFD"))) {
    report.losses.push({
      feature: "text.unicode",
      level: "partial",
      reason:
        "U+FFFD replacement characters are present: lone surrogate code units cannot be represented in XML and were replaced",
      preserved: false,
    });
    report.transparent = false;
  }
  document.compatibility = report;

  return {
    document,
    report,
    warnings: [
      ...warnings,
      ...unmappedParts.map(
        (path) => `Unmapped package part preserved verbatim: ${path}`,
      ),
    ],
    packageDigest: pkg.digest,
    unmappedParts,
  };
}

/** Text of every body, header/footer and note part, used for fidelity checks. */
function documentTextSectionsForImport(doc: DocDocument): string[] {
  const parts: string[] = [];
  for (const section of doc.sections) {
    parts.push(blocksText(section.blocks));
    for (const set of [section.headers, section.footers]) {
      for (const variant of ["default", "first", "even"] as const) {
        const part = set[variant];
        if (part) parts.push(blocksText(part.blocks));
      }
    }
  }
  for (const shape of doc.shapes) {
    if (shape.kind === "textbox") parts.push(blocksText(shape.blocks));
  }
  for (const note of [...doc.footnotes, ...doc.endnotes]) {
    parts.push(blocksText(note.blocks));
  }
  return parts;
}

/** Assigns fresh ids to a cloned block tree (header/footer inheritance). */
function rekeyBlockIds(
  idFactory: { next: (prefix: string) => string },
  blocks: Block[],
): void {
  for (const block of blocks) {
    block.id = idFactory.next(
      block.type === "table" ? "tbl" : block.type === "toc" ? "toc" : "p",
    );
    if (block.type === "table") {
      for (const row of block.rows) {
        row.id = idFactory.next("row");
        for (const cell of row.cells) {
          cell.id = idFactory.next("cell");
          rekeyBlockIds(idFactory, cell.blocks);
        }
      }
    }
  }
}

const WORD_MAIN_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  "application/vnd.ms-word.document.macroenabled.main+xml",
  "application/vnd.ms-word.template.macroenabledtemplate.main+xml",
]);

/**
 * A DOCX package must declare its WordprocessingML main part. Packages without
 * a sane `[Content_Types].xml` are rejected instead of being imported as if the
 * declaration were optional.
 */
function validateContentTypes(
  parts: Map<string, Buffer>,
  mainPath: string,
  label: string,
): void {
  const xml = readText(parts, "[Content_Types].xml");
  if (!xml) {
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} is missing [Content_Types].xml and does not declare its main document part`,
    );
  }
  let document;
  try {
    document = parseXml(xml, "[Content_Types].xml");
  } catch {
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} has an unreadable [Content_Types].xml`,
    );
  }
  const root = document.documentElement;
  if (!root || localNameOf(root) !== "Types") {
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} has a malformed [Content_Types].xml (no Types root element)`,
    );
  }
  const normalizedMain = mainPath.replace(/^\/+/, "").toLowerCase();
  let declared = false;
  for (const child of childElements(root)) {
    if (localNameOf(child) !== "Override") continue;
    const target = (child.getAttribute("PartName") ?? "")
      .replace(/^\/+/, "")
      .toLowerCase();
    if (target !== normalizedMain) continue;
    const contentType = (child.getAttribute("ContentType") ?? "").toLowerCase();
    if (WORD_MAIN_CONTENT_TYPES.has(contentType)) declared = true;
  }
  if (!declared) {
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} does not declare a WordprocessingML main document part (${mainPath}) in [Content_Types].xml`,
    );
  }
}

function emptyParagraph(idFactory: {
  next: (prefix: string) => string;
}): Block {
  return {
    type: "paragraph",
    id: idFactory.next("p"),
    style: "Normal",
    props: {},
    inlines: [],
  };
}

/* ----------------------------------------------------------- TOC ranges */

interface FieldNode {
  type: "begin" | "separate" | "end" | "instr";
  text: string;
}

function fieldNodes(element: Element): FieldNode[] {
  const out: FieldNode[] = [];
  const walk = (node: Element) => {
    for (const child of childElements(node)) {
      const name = localNameOf(child);
      if (name === "fldChar") {
        const type = wAttr(child, "fldCharType");
        if (type === "begin") out.push({ type: "begin", text: "" });
        else if (type === "separate") out.push({ type: "separate", text: "" });
        else if (type === "end") out.push({ type: "end", text: "" });
      } else if (name === "instrText") {
        out.push({ type: "instr", text: textOf(child) });
      } else {
        walk(child);
      }
    }
  };
  walk(element);
  return out;
}

interface TocRange {
  start: number;
  end: number;
  instr: string;
}

/**
 * Finds TOC field ranges across body-level elements. The cached field result
 * is replaced by a generated TocBlock so the layout engine can recompute page
 * numbers instead of trusting stale cached values.
 */
function findTocRanges(children: Element[]): TocRange[] {
  const ranges: TocRange[] = [];
  const stack: string[] = [];
  let start = -1;

  for (let index = 0; index < children.length; index += 1) {
    const element = children[index];
    const name = localNameOf(element);

    if (name === "p") {
      // Self-contained TOC field: w:fldSimple
      const simple = first(element, NS.w, "fldSimple");
      if (simple) {
        const instr = wAttr(simple, "instr") ?? "";
        if (/^\s*TOC\b/i.test(instr)) {
          ranges.push({ start: index, end: index, instr });
          continue;
        }
      }
    }

    for (const node of fieldNodes(element)) {
      if (node.type === "begin") {
        stack.push("");
        if (stack.length === 1) start = index;
      } else if (node.type === "instr") {
        if (stack.length > 0) {
          stack[stack.length - 1] += node.text;
        }
      } else if (node.type === "end") {
        const top = stack.pop() ?? "";
        if (stack.length === 0 && start >= 0) {
          if (/^\s*TOC\b/i.test(top)) {
            ranges.push({ start, end: index, instr: top });
          }
          start = -1;
        }
      }
    }
  }
  return ranges;
}

/* ------------------------------------------------------------- reporting */

interface ReportInput {
  document: DocDocument;
  fileName?: string;
  features: Map<string, number>;
  unknownElements: Map<string, { count: number; location?: string }>;
  unmappedParts: string[];
}

function buildReport(input: ReportInput): CompatibilityReport {
  const features: FeatureSupport[] = [];
  for (const [feature, count] of input.features) {
    const meta = FEATURE_REGISTRY[feature];
    const description = meta ?? {
      label: feature.replace(/^part:/, ""),
      level: "partial" as const,
    };
    features.push({
      feature,
      label: description.label,
      level: description.level,
      occurrences: count,
      notes: description.notes,
    });
  }
  // Always report the structural baseline so consumers see explicit coverage.
  const baseline: Array<[string, string, FeatureSupport["level"]]> = [
    ["document.package", "OOXML package", "full"],
    ["document.sections", "Sections", "full"],
    ["document.metadata", "Document metadata", "full"],
  ];
  for (const [feature, label, level] of baseline) {
    if (!features.some((entry) => entry.feature === feature)) {
      features.push({ feature, label, level, occurrences: 1 });
    }
  }

  const losses: LossEntry[] = [];
  for (const [element, entry] of input.unknownElements) {
    losses.push({
      feature: element,
      level: "fallback",
      reason: `Unsupported element preserved verbatim and reported; rendering uses a text fallback`,
      location: entry.location,
      preserved: true,
    });
  }
  for (const part of input.unmappedParts) {
    losses.push({
      feature: part,
      level: "unsupported",
      reason:
        "Part is preserved in the package but not represented in the document model",
      location: `part:${part}`,
      preserved: true,
    });
  }
  for (const part of input.document.unknown.filter((entry) =>
    entry.element.includes("/"),
  )) {
    losses.push({
      feature: part.element,
      level: "unsupported",
      reason: part.reason,
      location: part.location,
      preserved: true,
    });
  }

  const unknownElements = [...input.unknownElements.entries()].map(
    ([element, entry]) => ({
      element,
      count: entry.count,
      location: entry.location,
    }),
  );

  return {
    sourceFormat: "docx",
    sourceName: input.fileName,
    generatedAt: new Date().toISOString(),
    engine: "@dsh-doc/core",
    features: features.sort((a, b) => a.feature.localeCompare(b.feature)),
    losses,
    unknownElements,
    transparent: losses.every((loss) => loss.preserved !== false),
  };
}

export { resolvePartPath, wVal };
