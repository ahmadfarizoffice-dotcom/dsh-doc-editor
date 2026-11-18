/**
 * DOCX writer. Serializes the shared document model back to WordprocessingML.
 * Unknown inline constructs preserved by the importer are re-emitted verbatim so
 * round-trips never silently drop content.
 */
import type {
  Block,
  DocDocument,
  HeaderFooter,
  ImageInline,
  Inline,
  MathNode,
  Paragraph,
  RunProps,
  Section,
  ShapeTextBox,
  Table,
  TocBlock,
} from "../model/types.js";
import { ptToTwips } from "../model/types.js";
import { documentOutline } from "../model/query.js";
import { writePackage } from "./package.js";
import { NS, XmlBuilder } from "./xml.js";
import {
  alignmentToOoxml,
  borderStyleToOoxml,
  colorToHighlight,
  colorOrUndefined,
  underlineToOoxml,
  vertAlignToOoxml,
} from "./ooxml.js";

export type DocxFlavor = "docx" | "dotx" | "docm";

export interface ExportOptions {
  flavor?: DocxFlavor;
  /** Page numbers for TOC entries, from the layout engine. */
  pageNumbers?: Map<string, number>;
  /** Include the comments part and anchors (default true). */
  includeComments?: boolean;
  /** Keep stored timestamps instead of refreshing them. */
  preserveTimestamps?: boolean;
}

export interface ExportResult {
  buffer: Buffer;
  warnings: string[];
  /** Package parts recorded as unmapped and therefore not re-emitted. */
  droppedParts: string[];
}

/* ------------------------------------------------------------- namespace */

const ROOT_NAMESPACES: Record<string, string> = {
  "xmlns:w": NS.w,
  "xmlns:r": NS.r,
  "xmlns:a": NS.a,
  "xmlns:wp": NS.wp,
  "xmlns:pic": NS.pic,
  "xmlns:m": NS.m,
  "xmlns:wps": NS.wps,
  "xmlns:wpg": NS.wpg,
  "xmlns:mc": NS.mc,
  "xmlns:v": NS.v,
  "xmlns:o": NS.o,
  "xmlns:w10": NS.w10,
  "xmlns:w14": NS.w14,
  "xmlns:w15": NS.w15,
  "xmlns:wp14": NS.wp14,
  "mc:Ignorable": "w14 wp14",
};

const REL_TYPES = {
  officeDocument: `${NS.r}/officeDocument`,
  styles: `${NS.r}/styles`,
  numbering: `${NS.r}/numbering`,
  settings: `${NS.r}/settings`,
  theme: `${NS.r}/theme`,
  fontTable: `${NS.r}/fontTable`,
  header: `${NS.r}/header`,
  footer: `${NS.r}/footer`,
  footnotes: `${NS.r}/footnotes`,
  endnotes: `${NS.r}/endnotes`,
  comments: `${NS.r}/comments`,
  commentsExtended:
    "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
  core: `${NS.r}/metadata/core-properties`,
  app: `${NS.r}/extended-properties`,
  custom: `${NS.r}/custom-properties`,
  hyperlink: `${NS.r}/hyperlink`,
  image: `${NS.r}/image`,
};

/* ---------------------------------------------------------------- writer */

class PackageWriter {
  readonly rels = new Map<
    string,
    Map<string, { id: string; type: string; target: string; mode?: "External" }>
  >();
  readonly media = new Map<string, Buffer>();
  private readonly counters = new Map<string, number>();

  private relMap(partPath: string) {
    let map = this.rels.get(partPath);
    if (!map) {
      map = new Map();
      this.rels.set(partPath, map);
    }
    return map;
  }

  addRelationship(
    partPath: string,
    type: string,
    target: string,
    mode?: "External",
  ): string {
    const count = (this.counters.get(partPath) ?? 0) + 1;
    this.counters.set(partPath, count);
    const id = `rId${count}`;
    this.relMap(partPath).set(id, { id, type, target, mode });
    return id;
  }

  addImage(
    partPath: string,
    mediaId: string,
    fileName: string,
    data: Buffer,
  ): string {
    if (!this.media.has(mediaId)) this.media.set(mediaId, data);
    const target = `media/${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    for (const rel of this.relMap(partPath).values()) {
      if (rel.target === target) return rel.id;
    }
    return this.addRelationship(partPath, REL_TYPES.image, target);
  }
}

interface ExportContext {
  doc: DocDocument;
  writer: PackageWriter;
  partPath: string;
  nextId(): number;
  commentNumber: Map<string, number>;
  revisionNumber: Map<string, number>;
  headingBookmarks: Map<string, string>;
  /** Footnote/endnote model ids mapped to OOXML numeric ids. */
  noteNumbers: Map<string, number>;
  /** Bookmark model ids mapped to OOXML numeric ids. */
  bookmarkNumbers: Map<string, number>;
  pageNumbers?: Map<string, number>;
  headerFooterRids: Map<
    number,
    { headers: Record<string, string>; footers: Record<string, string> }
  >;
  warnings: string[];
}

function noteIdFor(context: ExportContext, noteId: string): number {
  const existing = context.noteNumbers.get(noteId);
  if (existing !== undefined) return existing;
  const next = context.noteNumbers.size + 2;
  context.noteNumbers.set(noteId, next);
  return next;
}

function bookmarkIdFor(context: ExportContext, bookmarkId: string): number {
  const existing = context.bookmarkNumbers.get(bookmarkId);
  if (existing !== undefined) return existing;
  const next = context.bookmarkNumbers.size + 1;
  context.bookmarkNumbers.set(bookmarkId, next);
  return next;
}

function colorAttr(color: string | undefined): string | undefined {
  const normalized = colorOrUndefined(color);
  return normalized ? normalized.replace("#", "") : undefined;
}

/* ------------------------------------------------------------- run props */

function runPropsXml(builder: XmlBuilder, props: RunProps | undefined): void {
  if (!props) return;
  const meaningful = Object.entries(props).some(
    ([key, value]) =>
      value !== undefined && key !== "hyperlink" && key !== "revision",
  );
  if (!meaningful) return;

  builder.open("w:rPr");
  if (props.characterStyle)
    builder.leaf("w:rStyle", { "w:val": props.characterStyle });
  if (
    props.fontFamily ||
    props.fontFamilyEastAsia ||
    props.fontFamilyComplexScript
  ) {
    builder.leaf("w:rFonts", {
      "w:ascii": props.fontFamily,
      "w:hAnsi": props.fontFamily,
      "w:eastAsia": props.fontFamilyEastAsia,
      "w:cs": props.fontFamilyComplexScript,
    });
  }
  if (props.bold !== undefined)
    builder.leaf("w:b", { "w:val": props.bold ? "1" : "0" });
  if (props.italic !== undefined)
    builder.leaf("w:i", { "w:val": props.italic ? "1" : "0" });
  if (props.caps) builder.leaf("w:caps", { "w:val": "1" });
  if (props.smallCaps) builder.leaf("w:smallCaps", { "w:val": "1" });
  if (props.strike) builder.leaf("w:strike", { "w:val": "1" });
  if (props.doubleStrike) builder.leaf("w:dstrike", { "w:val": "1" });
  if (props.outline) builder.leaf("w:outline", { "w:val": "1" });
  if (props.shadow) builder.leaf("w:shadow", { "w:val": "1" });
  if (props.emboss) builder.leaf("w:emboss", { "w:val": "1" });
  if (props.imprint) builder.leaf("w:imprint", { "w:val": "1" });
  if (props.rtl) builder.leaf("w:rtl", { "w:val": "1" });
  if (props.hidden) builder.leaf("w:vanish", { "w:val": "1" });
  if (props.webHidden) builder.leaf("w:webHidden", { "w:val": "1" });
  if (props.specVanish) builder.leaf("w:specVanish", { "w:val": "1" });
  if (props.color) builder.leaf("w:color", { "w:val": colorAttr(props.color) });
  if (props.charSpacing !== undefined)
    builder.leaf("w:spacing", { "w:val": Math.round(props.charSpacing * 20) });
  if (props.charScale !== undefined)
    builder.leaf("w:w", { "w:val": props.charScale });
  if (props.kerning !== undefined)
    builder.leaf("w:kern", { "w:val": Math.round(props.kerning * 2) });
  if (props.fontSize !== undefined) {
    builder.leaf("w:sz", { "w:val": Math.round(props.fontSize * 2) });
    builder.leaf("w:szCs", { "w:val": Math.round(props.fontSize * 2) });
  }
  const highlight = colorToHighlight(props.highlight);
  if (highlight && highlight !== "none")
    builder.leaf("w:highlight", { "w:val": highlight });
  if (props.background) {
    builder.leaf("w:shd", {
      "w:val": "clear",
      "w:color": "auto",
      "w:fill": colorAttr(props.background),
    });
  }
  if (props.underline !== undefined) {
    builder.leaf("w:u", {
      "w:val": underlineToOoxml(props.underline) ?? "single",
      "w:color": colorAttr(props.underlineColor),
    });
  }
  const vertAlign = vertAlignToOoxml(props.vertAlign);
  if (vertAlign) builder.leaf("w:vertAlign", { "w:val": vertAlign });
  if (props.language || props.languageEastAsia || props.languageBidi) {
    builder.leaf("w:lang", {
      "w:val": props.language,
      "w:eastAsia": props.languageEastAsia,
      "w:bidi": props.languageBidi,
    });
  }
  builder.close("w:rPr");
}

function revisionId(
  revision: import("../model/types.js").RevisionMark,
  context: ExportContext,
): number {
  const existing = context.revisionNumber.get(revision.id);
  if (existing !== undefined) return existing;
  const id = context.nextId();
  context.revisionNumber.set(revision.id, id);
  return id;
}

/* ------------------------------------------------------- paragraph props */

function paragraphPropsXml(
  builder: XmlBuilder,
  paragraph: Paragraph,
  context: ExportContext,
  sectionTail?: { section: Section; sectionIndex: number },
): void {
  const props = paragraph.props;
  if (
    !paragraph.style &&
    Object.keys(props).length === 0 &&
    !paragraph.revision &&
    !sectionTail
  ) {
    return;
  }

  builder.open("w:pPr");
  if (paragraph.style) builder.leaf("w:pStyle", { "w:val": paragraph.style });
  if (props.numbering) {
    builder.open("w:numPr");
    builder.leaf("w:ilvl", { "w:val": props.numbering.level });
    builder.leaf("w:numId", { "w:val": props.numbering.numId });
    builder.close("w:numPr");
  }
  if (paragraph.revision) {
    builder.open("w:rPr");
    builder.leaf(`w:${paragraph.revision.kind === "delete" ? "del" : "ins"}`, {
      "w:id": revisionId(paragraph.revision, context),
      "w:author": paragraph.revision.author ?? "Unknown",
      "w:date": paragraph.revision.date,
    });
    builder.close("w:rPr");
  }
  const jc = alignmentToOoxml(props.alignment);
  if (jc) builder.leaf("w:jc", { "w:val": jc });
  if (
    props.spaceBefore !== undefined ||
    props.spaceAfter !== undefined ||
    props.lineSpacing ||
    props.beforeAutospacing !== undefined ||
    props.afterAutospacing !== undefined
  ) {
    const attrs: Record<string, string | number | undefined> = {};
    if (props.spaceBefore !== undefined)
      attrs["w:before"] = ptToTwips(props.spaceBefore);
    if (props.spaceAfter !== undefined)
      attrs["w:after"] = ptToTwips(props.spaceAfter);
    if (props.lineSpacing) {
      attrs["w:line"] =
        props.lineSpacing.rule === "auto"
          ? Math.round(props.lineSpacing.value * 240)
          : ptToTwips(props.lineSpacing.value);
      attrs["w:lineRule"] = props.lineSpacing.rule;
    }
    if (props.beforeAutospacing !== undefined)
      attrs["w:beforeAutospacing"] = props.beforeAutospacing ? "1" : "0";
    if (props.afterAutospacing !== undefined)
      attrs["w:afterAutospacing"] = props.afterAutospacing ? "1" : "0";
    builder.leaf("w:spacing", attrs);
  }
  if (props.indent) {
    builder.leaf("w:ind", {
      "w:left":
        props.indent.left !== undefined
          ? ptToTwips(props.indent.left)
          : undefined,
      "w:right":
        props.indent.right !== undefined
          ? ptToTwips(props.indent.right)
          : undefined,
      "w:firstLine":
        props.indent.firstLine !== undefined
          ? ptToTwips(props.indent.firstLine)
          : undefined,
      "w:hanging":
        props.indent.hanging !== undefined
          ? ptToTwips(props.indent.hanging)
          : undefined,
      "w:mirrorIndents": props.indent.mirror ? "1" : undefined,
    });
  }
  if (props.tabStops && props.tabStops.length > 0) {
    builder.open("w:tabs");
    for (const tab of props.tabStops) {
      builder.leaf("w:tab", {
        "w:val": tab.alignment,
        "w:pos": ptToTwips(tab.position),
        "w:leader": tab.leader,
      });
    }
    builder.close("w:tabs");
  }
  if (props.borders) {
    builder.open("w:pBdr");
    for (const side of [
      "top",
      "left",
      "bottom",
      "right",
      "between",
      "bar",
    ] as const) {
      const border = props.borders[side];
      if (!border) continue;
      builder.leaf(`w:${side}`, {
        "w:val": borderStyleToOoxml(border.style),
        "w:sz": Math.max(2, Math.round(border.width * 8)),
        "w:space":
          border.space !== undefined ? Math.round(border.space) : undefined,
        "w:color": colorAttr(border.color) ?? "auto",
      });
    }
    builder.close("w:pBdr");
  }
  if (props.shading?.fill) {
    builder.leaf("w:shd", {
      "w:val": props.shading.pattern ?? "clear",
      "w:color": "auto",
      "w:fill": colorAttr(props.shading.fill),
    });
  }
  const flags: Array<[string, boolean | undefined]> = [
    ["w:keepNext", props.keepNext],
    ["w:keepLines", props.keepLines],
    ["w:pageBreakBefore", props.pageBreakBefore],
    ["w:widowControl", props.widowControl],
    ["w:bidi", props.bidi],
    ["w:contextualSpacing", props.contextualSpacing],
    ["w:snapToGrid", props.snapToGrid],
    ["w:suppressLineNumbers", props.suppressLineNumbers],
  ];
  for (const [name, value] of flags) {
    if (value !== undefined) builder.leaf(name, { "w:val": value ? "1" : "0" });
  }
  if (props.outlineLevel !== undefined)
    builder.leaf("w:outlineLvl", { "w:val": props.outlineLevel });
  if (props.textDirection)
    builder.leaf("w:textDirection", { "w:val": props.textDirection });
  if (props.frame) {
    builder.leaf("w:framePr", {
      "w:w": ptToTwips(props.frame.width),
      "w:h": ptToTwips(props.frame.height),
      "w:x": ptToTwips(props.frame.x),
      "w:y": ptToTwips(props.frame.y),
      "w:hAnchor": props.frame.hAnchor,
      "w:vAnchor": props.frame.vAnchor,
      "w:dropCap": props.frame.dropCap,
      "w:lines": props.frame.lines,
    });
  }
  if (sectionTail) {
    const sectionBuilder = new XmlBuilder();
    sectionPropertiesXml(
      sectionBuilder,
      sectionTail.section,
      sectionTail.sectionIndex,
      context,
    );
    builder.raw(sectionBuilder.toString());
  }
  builder.close("w:pPr");
}

/* ------------------------------------------------------------------ runs */

function runXml(
  builder: XmlBuilder,
  inline: Inline,
  context: ExportContext,
): void {
  switch (inline.type) {
    case "text": {
      const revision = inline.props.revision;
      const textTag = revision?.kind === "delete" ? "w:delText" : "w:t";
      const props = { ...inline.props };
      delete props.revision;
      if (
        revision &&
        (revision.kind === "insert" || revision.kind === "delete")
      ) {
        builder.open(revision.kind === "delete" ? "w:del" : "w:ins", {
          "w:id": revisionId(revision, context),
          "w:author": revision.author ?? "Unknown",
          "w:date": revision.date,
        });
      }
      builder.open("w:r");
      runPropsXml(builder, props);
      builder.leaf(textTag, { "xml:space": "preserve" }, inline.text);
      builder.close("w:r");
      if (
        revision &&
        (revision.kind === "insert" || revision.kind === "delete")
      ) {
        builder.close(revision.kind === "delete" ? "w:del" : "w:ins");
      }
      return;
    }
    case "tab":
      builder.open("w:r");
      runPropsXml(builder, inline.props);
      builder.leaf("w:tab");
      builder.close("w:r");
      return;
    case "break":
      builder.open("w:r");
      runPropsXml(builder, inline.props);
      builder.leaf(
        "w:br",
        inline.kind === "line" ? undefined : { "w:type": inline.kind },
      );
      builder.close("w:r");
      return;
    case "image":
      imageXml(builder, inline, context);
      return;
    case "field":
      fieldXml(builder, inline, context);
      return;
    case "noteRef":
      builder.open("w:r");
      builder.open("w:rPr");
      builder.leaf("w:rStyle", { "w:val": "FootnoteReference" });
      builder.leaf("w:vertAlign", { "w:val": "superscript" });
      builder.close("w:rPr");
      builder.leaf(
        inline.noteType === "footnote"
          ? "w:footnoteReference"
          : "w:endnoteReference",
        { "w:id": noteIdFor(context, inline.noteId) },
      );
      builder.close("w:r");
      return;
    case "commentRef": {
      const number = context.commentNumber.get(inline.commentId);
      if (number === undefined) return;
      if (inline.kind === "rangeStart")
        builder.leaf("w:commentRangeStart", { "w:id": number });
      else if (inline.kind === "rangeEnd")
        builder.leaf("w:commentRangeEnd", { "w:id": number });
      else {
        builder.open("w:r");
        builder.open("w:rPr");
        builder.leaf("w:rStyle", { "w:val": "CommentReference" });
        builder.close("w:rPr");
        builder.leaf("w:commentReference", { "w:id": number });
        builder.close("w:r");
      }
      return;
    }
    case "bookmark":
      if (inline.kind === "start") {
        builder.leaf("w:bookmarkStart", {
          "w:id": bookmarkIdFor(context, inline.bookmarkId),
          "w:name":
            inline.name ||
            `Bookmark${bookmarkIdFor(context, inline.bookmarkId)}`,
        });
      } else {
        builder.leaf("w:bookmarkEnd", {
          "w:id": bookmarkIdFor(context, inline.bookmarkId),
        });
      }
      return;
    case "math":
      mathXml(builder, inline.math, context);
      return;
    case "shape": {
      const shape = context.doc.shapes.find(
        (entry) => entry.id === inline.shapeId,
      );
      if (shape) textboxXml(builder, shape, context);
      return;
    }
    case "unknown":
      builder.raw(inline.raw);
      return;
    default:
      return;
  }
}

function fieldXml(
  builder: XmlBuilder,
  inline: Extract<Inline, { type: "field" }>,
  context: ExportContext,
): void {
  if (inline.simple) {
    builder.open("w:fldSimple", { "w:instr": inline.instr });
    for (const child of inline.result ?? []) runXml(builder, child, context);
    builder.close("w:fldSimple");
    return;
  }
  builder.open("w:r");
  builder.leaf("w:fldChar", { "w:fldCharType": "begin" });
  builder.close("w:r");
  builder.open("w:r");
  builder.leaf("w:instrText", { "xml:space": "preserve" }, ` ${inline.instr} `);
  builder.close("w:r");
  builder.open("w:r");
  builder.leaf("w:fldChar", { "w:fldCharType": "separate" });
  builder.close("w:r");
  for (const child of inline.result ?? []) runXml(builder, child, context);
  builder.open("w:r");
  builder.leaf("w:fldChar", { "w:fldCharType": "end" });
  builder.close("w:r");
}

/* ---------------------------------------------------------------- images */

function imageXml(
  builder: XmlBuilder,
  inline: ImageInline,
  context: ExportContext,
): void {
  const asset = context.doc.media.find((entry) => entry.id === inline.mediaId);
  if (!asset) {
    context.warnings.push(
      `Image ${inline.mediaId} has no media payload; skipped`,
    );
    return;
  }
  const rid = context.writer.addImage(
    context.partPath,
    asset.id,
    asset.fileName,
    Buffer.from(asset.data, "base64"),
  );
  const cx = Math.round(inline.width * 12700);
  const cy = Math.round(inline.height * 12700);
  const docPrId = context.nextId();
  const anchor = inline.anchor ?? { type: "inline" };

  builder.open("w:r");
  builder.open("w:drawing");
  const floating = anchor.type === "floating";
  let wrapper = "wp:inline";
  if (floating) {
    wrapper = "wp:anchor";
    builder.open("wp:anchor", {
      distT: 0,
      distB: 0,
      distL: 0,
      distR: 0,
      simplePos: "0",
      relativeHeight: anchor.zOrder ?? 251659264,
      behindDoc: anchor.behindText ? "1" : "0",
      locked: anchor.lockAnchor ? "1" : "0",
      layoutInCell: "1",
      allowOverlap: "1",
    });
    builder.leaf("wp:simplePos", {
      x: Math.round((anchor.simplePosition?.x ?? 0) * 12700),
      y: Math.round((anchor.simplePosition?.y ?? 0) * 12700),
    });
    const horizontal = anchor.position?.horizontal;
    builder.open("wp:positionH", {
      relativeFrom: horizontal?.relativeTo ?? "column",
    });
    if (horizontal?.align)
      builder.leaf("wp:align", undefined, horizontal.align);
    else
      builder.leaf(
        "wp:posOffset",
        undefined,
        String(Math.round((horizontal?.offset ?? 0) * 12700)),
      );
    builder.close("wp:positionH");
    const vertical = anchor.position?.vertical;
    builder.open("wp:positionV", {
      relativeFrom: vertical?.relativeTo ?? "paragraph",
    });
    if (vertical?.align) builder.leaf("wp:align", undefined, vertical.align);
    else
      builder.leaf(
        "wp:posOffset",
        undefined,
        String(Math.round((vertical?.offset ?? 0) * 12700)),
      );
    builder.close("wp:positionV");
  } else {
    builder.open("wp:inline", { distT: 0, distB: 0, distL: 0, distR: 0 });
  }
  builder.leaf("wp:extent", { cx, cy });
  builder.leaf("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 });
  if (floating) {
    const wrap = anchor.wrap;
    if (!wrap || wrap.type === "none") builder.leaf("wp:wrapNone");
    else
      builder.leaf("wp:wrapSquare", {
        wrapText: (wrap as { wrapSide?: string }).wrapSide ?? "both",
      });
  }
  builder.leaf("wp:docPr", {
    id: docPrId,
    name: `Picture ${docPrId}`,
    descr: inline.alt,
    title: inline.title,
  });
  builder.leaf("wp:cNvGraphicFramePr");
  builder.open("a:graphic");
  builder.open("a:graphicData", {
    uri: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  });
  builder.open("pic:pic");
  builder.open("pic:nvPicPr");
  builder.leaf("pic:cNvPr", { id: docPrId, name: asset.fileName });
  builder.leaf("pic:cNvPicPr");
  builder.close("pic:nvPicPr");
  builder.open("pic:blipFill");
  builder.leaf("a:blip", { "r:embed": rid });
  builder.open("a:stretch");
  builder.leaf("a:fillRect");
  builder.close("a:stretch");
  builder.close("pic:blipFill");
  builder.open("pic:spPr");
  builder.leaf("a:xfrm", { rot: 0 });
  builder.leaf("a:off", { x: 0, y: 0 });
  builder.leaf("a:ext", { cx, cy });
  builder.leaf("a:prstGeom", { prst: "rect" });
  builder.close("pic:spPr");
  builder.close("pic:pic");
  builder.close("a:graphicData");
  builder.close("a:graphic");
  builder.close(wrapper);
  builder.close("w:drawing");
  builder.close("w:r");
}

function textboxXml(
  builder: XmlBuilder,
  shape: ShapeTextBox,
  context: ExportContext,
): void {
  const cx = Math.round(shape.width * 12700);
  const cy = Math.round(shape.height * 12700);
  const anchor = shape.anchor ?? { type: "inline" };
  const floating = anchor.type === "floating";
  builder.open("w:r");
  builder.open("w:drawing");
  if (floating) {
    builder.open("wp:anchor", {
      distT: 0,
      distB: 0,
      distL: 0,
      distR: 0,
      simplePos: "0",
      relativeHeight: anchor.zOrder ?? 251659264,
      behindDoc: anchor.behindText ? "1" : "0",
      locked: "0",
      layoutInCell: "1",
      allowOverlap: "1",
    });
    builder.leaf("wp:simplePos", { x: 0, y: 0 });
    builder.open("wp:positionH", {
      relativeFrom: anchor.position?.horizontal?.relativeTo ?? "column",
    });
    builder.leaf(
      "wp:align",
      undefined,
      anchor.position?.horizontal?.align ?? "left",
    );
    builder.close("wp:positionH");
    builder.open("wp:positionV", {
      relativeFrom: anchor.position?.vertical?.relativeTo ?? "paragraph",
    });
    builder.leaf(
      "wp:posOffset",
      undefined,
      String(Math.round((anchor.position?.vertical?.offset ?? 0) * 12700)),
    );
    builder.close("wp:positionV");
    builder.leaf("wp:extent", { cx, cy });
    builder.leaf("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 });
    builder.leaf("wp:wrapSquare", { wrapText: "both" });
  } else {
    builder.open("wp:inline");
    builder.leaf("wp:extent", { cx, cy });
    builder.leaf("wp:effectExtent", { l: 0, t: 0, r: 0, b: 0 });
  }
  builder.leaf("wp:docPr", {
    id: context.nextId(),
    name: `Text Box ${shape.id}`,
  });
  builder.leaf("wp:cNvGraphicFramePr");
  builder.open("a:graphic");
  builder.open("a:graphicData", {
    uri: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  });
  builder.open("wps:wsp");
  builder.open("wps:cNvSpPr");
  builder.leaf("a:spLocks", { noChangeArrowheads: "1" });
  builder.close("wps:cNvSpPr");
  builder.open("wps:spPr");
  builder.leaf("a:xfrm", { rot: 0 });
  builder.leaf("a:off", { x: 0, y: 0 });
  builder.leaf("a:ext", { cx, cy });
  builder.leaf("a:prstGeom", { prst: shape.preset ?? "rect" });
  if (shape.fill) {
    builder.open("a:solidFill");
    builder.leaf("a:srgbClr", { val: colorAttr(shape.fill) ?? "FFFFFF" });
    builder.close("a:solidFill");
  }
  builder.close("wps:spPr");
  builder.open("wps:txbx");
  builder.open("w:txbxContent");
  for (const block of shape.blocks) blockXml(builder, block, context);
  builder.close("w:txbxContent");
  builder.close("wps:txbx");
  builder.open("wps:bodyPr");
  builder.leaf("a:noAutofit");
  builder.close("wps:bodyPr");
  builder.close("wps:wsp");
  builder.close("a:graphicData");
  builder.close("a:graphic");
  builder.close(floating ? "wp:anchor" : "wp:inline");
  builder.close("w:drawing");
  builder.close("w:r");
}

/* ------------------------------------------------------------------ math */

function mathXml(
  builder: XmlBuilder,
  nodes: MathNode[],
  context: ExportContext,
): void {
  builder.open("w:r");
  builder.open("m:oMath");
  for (const node of nodes) mathNodeXml(builder, node, context);
  builder.close("m:oMath");
  builder.close("w:r");
}

function mathNodeXml(
  builder: XmlBuilder,
  node: MathNode,
  context: ExportContext,
): void {
  switch (node.kind) {
    case "run":
      builder.open("m:r");
      builder.leaf("m:t", { "xml:space": "preserve" }, node.text);
      builder.close("m:r");
      return;
    case "fraction":
      builder.open("m:f");
      builder.open("m:num");
      for (const child of node.numerator) mathNodeXml(builder, child, context);
      builder.close("m:num");
      builder.open("m:den");
      for (const child of node.denominator)
        mathNodeXml(builder, child, context);
      builder.close("m:den");
      builder.close("m:f");
      return;
    case "superscript":
      builder.open("m:sSup");
      builder.open("m:e");
      for (const child of node.base) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.open("m:sup");
      for (const child of node.superscript)
        mathNodeXml(builder, child, context);
      builder.close("m:sup");
      builder.close("m:sSup");
      return;
    case "subscript":
      builder.open("m:sSub");
      builder.open("m:e");
      for (const child of node.base) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.open("m:sub");
      for (const child of node.subscript) mathNodeXml(builder, child, context);
      builder.close("m:sub");
      builder.close("m:sSub");
      return;
    case "subsup":
      builder.open("m:sSubSup");
      builder.open("m:e");
      for (const child of node.base) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.open("m:sub");
      for (const child of node.sub) mathNodeXml(builder, child, context);
      builder.close("m:sub");
      builder.open("m:sup");
      for (const child of node.sup) mathNodeXml(builder, child, context);
      builder.close("m:sup");
      builder.close("m:sSubSup");
      return;
    case "radical":
      builder.open("m:rad");
      builder.open("m:deg");
      for (const child of node.degree) mathNodeXml(builder, child, context);
      builder.close("m:deg");
      builder.open("m:e");
      for (const child of node.radicand) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:rad");
      return;
    case "delimited":
      builder.open("m:d");
      builder.open("m:dPr");
      if (node.begin) builder.leaf("m:begChr", { "m:val": node.begin });
      if (node.end) builder.leaf("m:endChr", { "m:val": node.end });
      if (node.separator) builder.leaf("m:sepChr", { "m:val": node.separator });
      builder.close("m:dPr");
      builder.open("m:e");
      for (const child of node.children) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:d");
      return;
    case "function":
      builder.open("m:func");
      builder.open("m:fName");
      builder.open("m:r");
      builder.leaf("m:t", undefined, node.name);
      builder.close("m:r");
      builder.close("m:fName");
      builder.open("m:e");
      for (const child of node.argument) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:func");
      return;
    case "nary":
      builder.open("m:nary");
      builder.open("m:naryPr");
      builder.leaf("m:chr", { "m:val": node.operator });
      builder.close("m:naryPr");
      builder.open("m:sub");
      for (const child of node.sub ?? []) mathNodeXml(builder, child, context);
      builder.close("m:sub");
      builder.open("m:sup");
      for (const child of node.sup ?? []) mathNodeXml(builder, child, context);
      builder.close("m:sup");
      builder.open("m:e");
      for (const child of node.body) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:nary");
      return;
    case "bar":
      builder.open("m:bar");
      builder.open("m:barPr");
      builder.leaf("m:pos", {
        "m:val": node.position === "bottom" ? "bot" : "top",
      });
      builder.close("m:barPr");
      builder.open("m:e");
      for (const child of node.body) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:bar");
      return;
    case "accent":
      builder.open("m:acc");
      builder.open("m:accPr");
      builder.leaf("m:chr", { "m:val": node.char });
      builder.close("m:accPr");
      builder.open("m:e");
      for (const child of node.body) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:acc");
      return;
    case "matrix":
      builder.open("m:m");
      for (const row of node.rows) {
        builder.open("m:mr");
        for (const cell of row) {
          builder.open("m:e");
          for (const child of cell) mathNodeXml(builder, child, context);
          builder.close("m:e");
        }
        builder.close("m:mr");
      }
      builder.close("m:m");
      return;
    case "group":
      builder.open("m:eqArr");
      builder.open("m:e");
      for (const child of node.children) mathNodeXml(builder, child, context);
      builder.close("m:e");
      builder.close("m:eqArr");
      return;
    case "space":
      builder.open("m:r");
      builder.leaf("m:t", { "xml:space": "preserve" }, " ");
      builder.close("m:r");
      return;
    case "unknown":
      builder.open("m:r");
      builder.leaf("m:t", { "xml:space": "preserve" }, node.linear);
      builder.close("m:r");
      return;
    default:
      return;
  }
}

/* ---------------------------------------------------------------- tables */

function tableXml(
  builder: XmlBuilder,
  table: Table,
  context: ExportContext,
): void {
  builder.open("w:tbl");
  builder.open("w:tblPr");
  if (table.props.style)
    builder.leaf("w:tblStyle", { "w:val": table.props.style });
  if (table.props.alignment) {
    builder.leaf("w:jc", {
      "w:val": alignmentToOoxml(table.props.alignment) ?? "left",
    });
  }
  if (table.props.width) {
    builder.leaf("w:tblW", {
      "w:w":
        table.props.width.type === "pct"
          ? Math.round(table.props.width.value * 50)
          : ptToTwips(table.props.width.value),
      "w:type": table.props.width.type,
    });
  }
  if (table.props.indent !== undefined) {
    builder.leaf("w:tblInd", {
      "w:w": ptToTwips(table.props.indent),
      "w:type": "dxa",
    });
  }
  if (table.props.borders) {
    builder.open("w:tblBorders");
    for (const side of ["top", "left", "bottom", "right"] as const) {
      const border = table.props.borders[side];
      if (!border) continue;
      builder.leaf(`w:${side}`, {
        "w:val": borderStyleToOoxml(border.style),
        "w:sz": Math.max(2, Math.round(border.width * 8)),
        "w:space": 0,
        "w:color": colorAttr(border.color) ?? "auto",
      });
    }
    const between = table.props.borders.between;
    if (between) {
      for (const tag of ["w:insideH", "w:insideV"] as const) {
        builder.leaf(tag, {
          "w:val": borderStyleToOoxml(between.style),
          "w:sz": Math.max(2, Math.round(between.width * 8)),
          "w:space": 0,
          "w:color": colorAttr(between.color) ?? "auto",
        });
      }
    }
    builder.close("w:tblBorders");
  }
  if (table.props.cellMargins) {
    builder.open("w:tblCellMar");
    for (const side of ["top", "left", "bottom", "right"] as const) {
      const value = table.props.cellMargins[side];
      if (value === undefined) continue;
      builder.leaf(`w:${side}`, { "w:w": ptToTwips(value), "w:type": "dxa" });
    }
    builder.close("w:tblCellMar");
  }
  if (table.props.layout)
    builder.leaf("w:tblLayout", { "w:type": table.props.layout });
  if (table.props.shading?.fill) {
    builder.leaf("w:shd", {
      "w:val": "clear",
      "w:fill": colorAttr(table.props.shading.fill),
    });
  }
  builder.leaf("w:tblLook", {
    "w:val": "04A0",
    "w:firstRow": table.props.look?.firstRow === false ? "0" : "1",
    "w:lastRow": table.props.look?.lastRow ? "1" : "0",
    "w:firstColumn": table.props.look?.firstColumn ? "1" : "0",
    "w:lastColumn": table.props.look?.lastColumn ? "1" : "0",
    "w:noHBand": table.props.look?.noHBand ? "1" : "0",
    "w:noVBand": table.props.look?.noVBand ? "1" : "0",
  });
  builder.close("w:tblPr");

  builder.open("w:tblGrid");
  for (const width of table.grid)
    builder.leaf("w:gridCol", { "w:w": ptToTwips(width) });
  builder.close("w:tblGrid");

  for (const row of table.rows) {
    builder.open("w:tr");
    if (
      row.props.height !== undefined ||
      row.props.isHeader ||
      row.props.cantSplit ||
      row.props.gridBefore ||
      row.props.gridAfter ||
      row.props.alignment ||
      row.props.shading
    ) {
      builder.open("w:trPr");
      if (row.props.gridBefore)
        builder.leaf("w:gridBefore", { "w:val": row.props.gridBefore });
      if (row.props.gridAfter)
        builder.leaf("w:gridAfter", { "w:val": row.props.gridAfter });
      if (row.props.isHeader) builder.leaf("w:tblHeader");
      if (row.props.cantSplit) builder.leaf("w:cantSplit");
      if (row.props.height !== undefined) {
        builder.leaf("w:trHeight", {
          "w:val": ptToTwips(row.props.height),
          "w:hRule": row.props.heightRule ?? "atLeast",
        });
      }
      if (row.props.alignment)
        builder.leaf("w:jc", {
          "w:val": alignmentToOoxml(row.props.alignment),
        });
      if (row.props.shading?.fill) {
        builder.leaf("w:shd", {
          "w:val": "clear",
          "w:fill": colorAttr(row.props.shading.fill),
        });
      }
      builder.close("w:trPr");
    }
    for (const cell of row.cells) {
      builder.open("w:tc");
      builder.open("w:tcPr");
      if (cell.props.width) {
        builder.leaf("w:tcW", {
          "w:w":
            cell.props.width.type === "pct"
              ? Math.round(cell.props.width.value * 50)
              : ptToTwips(cell.props.width.value),
          "w:type": cell.props.width.type,
        });
      }
      if (cell.props.gridSpan && cell.props.gridSpan > 1) {
        builder.leaf("w:gridSpan", { "w:val": cell.props.gridSpan });
      }
      if (cell.props.vMerge === "restart")
        builder.leaf("w:vMerge", { "w:val": "restart" });
      else if (cell.props.vMerge === "continue") builder.leaf("w:vMerge");
      if (cell.props.background?.fill) {
        builder.leaf("w:shd", {
          "w:val": cell.props.background.pattern ?? "clear",
          "w:color": "auto",
          "w:fill": colorAttr(cell.props.background.fill),
        });
      }
      if (cell.props.borders) {
        builder.open("w:tcBorders");
        for (const side of ["top", "left", "bottom", "right"] as const) {
          const border = cell.props.borders[side];
          if (!border) continue;
          builder.leaf(`w:${side}`, {
            "w:val": borderStyleToOoxml(border.style),
            "w:sz": Math.max(2, Math.round(border.width * 8)),
            "w:space": 0,
            "w:color": colorAttr(border.color) ?? "auto",
          });
        }
        builder.close("w:tcBorders");
      }
      if (cell.props.margins) {
        builder.open("w:tcMar");
        for (const side of ["top", "left", "bottom", "right"] as const) {
          const value = cell.props.margins[side];
          if (value === undefined) continue;
          builder.leaf(`w:${side}`, {
            "w:w": ptToTwips(value),
            "w:type": "dxa",
          });
        }
        builder.close("w:tcMar");
      }
      if (cell.props.vAlign)
        builder.leaf("w:vAlign", { "w:val": cell.props.vAlign });
      if (cell.props.textDirection)
        builder.leaf("w:textDirection", { "w:val": cell.props.textDirection });
      if (cell.props.fitText) builder.leaf("w:tcFitText");
      if (cell.props.wrapText === false) builder.leaf("w:noWrap");
      builder.close("w:tcPr");
      for (const block of cell.blocks) blockXml(builder, block, context);
      builder.close("w:tc");
    }
    builder.close("w:tr");
  }
  builder.close("w:tbl");
}

/* ---------------------------------------------------------------- blocks */

interface HyperlinkGroup {
  target?: NonNullable<RunProps["hyperlink"]>;
  inlines: Inline[];
}

function groupHyperlinks(inlines: Inline[]): HyperlinkGroup[] {
  const groups: HyperlinkGroup[] = [];
  for (const inline of inlines) {
    const target = (inline as { props?: RunProps }).props?.hyperlink;
    if (!target) {
      groups.push({ inlines: [inline] });
      continue;
    }
    const last = groups[groups.length - 1];
    if (
      last &&
      last.target &&
      last.target.href === target.href &&
      last.target.anchor === target.anchor &&
      last.target.tooltip === target.tooltip
    ) {
      last.inlines.push(inline);
    } else {
      groups.push({ target, inlines: [inline] });
    }
  }
  return groups;
}

function paragraphXml(
  builder: XmlBuilder,
  paragraph: Paragraph,
  context: ExportContext,
  sectionTail?: { section: Section; sectionIndex: number },
): void {
  builder.open("w:p");
  const bookmarkName = context.headingBookmarks.get(paragraph.id);
  if (bookmarkName) {
    builder.leaf("w:bookmarkStart", {
      "w:id": context.nextId(),
      "w:name": bookmarkName,
    });
  }
  paragraphPropsXml(builder, paragraph, context, sectionTail);
  for (const group of groupHyperlinks(paragraph.inlines)) {
    if (group.target) {
      const rid = group.target.href
        ? context.writer.addRelationship(
            context.partPath,
            REL_TYPES.hyperlink,
            group.target.href,
            "External",
          )
        : undefined;
      builder.open("w:hyperlink", {
        "r:id": rid,
        "w:anchor": group.target.anchor,
        "w:tooltip": group.target.tooltip,
        "w:history": "1",
      });
      for (const inline of group.inlines) runXml(builder, inline, context);
      builder.close("w:hyperlink");
    } else {
      for (const inline of group.inlines) runXml(builder, inline, context);
    }
  }
  if (bookmarkName) {
    builder.leaf("w:bookmarkEnd", { "w:id": context.nextId() });
  }
  builder.close("w:p");
}

function blockXml(
  builder: XmlBuilder,
  block: Block,
  context: ExportContext,
): void {
  if (block.type === "paragraph") paragraphXml(builder, block, context);
  else if (block.type === "table") tableXml(builder, block, context);
  else tocXml(builder, block, context);
}

/** Serializes a generated TOC as a real Word TOC field with cached entries. */
function tocXml(
  builder: XmlBuilder,
  toc: TocBlock,
  context: ExportContext,
): void {
  const instruction =
    toc.instruction ?? `TOC \\o "${toc.minLevel}-${toc.maxLevel}" \\h \\z \\u`;
  const entries = documentOutline(context.doc, {
    maxLevel: toc.maxLevel,
    includeTitle: toc.includeTitle ?? false,
  }).filter((entry) => entry.level >= toc.minLevel);

  builder.open("w:p");
  builder.open("w:r");
  builder.leaf("w:fldChar", { "w:fldCharType": "begin" });
  builder.close("w:r");
  builder.open("w:r");
  builder.leaf("w:instrText", { "xml:space": "preserve" }, ` ${instruction} `);
  builder.close("w:r");
  builder.open("w:r");
  builder.leaf("w:fldChar", { "w:fldCharType": "separate" });
  builder.close("w:r");
  builder.close("w:p");

  for (const entry of entries) {
    const bookmark = context.headingBookmarks.get(entry.blockId);
    const pageNumber = context.pageNumbers?.get(entry.blockId);
    builder.open("w:p");
    builder.open("w:pPr");
    builder.leaf("w:pStyle", {
      "w:val": `TOC${Math.min(9, Math.max(1, entry.level))}`,
    });
    builder.open("w:tabs");
    builder.leaf("w:tab", {
      "w:val": "right",
      "w:leader": toc.tabLeader === "none" ? undefined : toc.tabLeader,
      "w:pos": 9354,
    });
    builder.close("w:tabs");
    builder.close("w:pPr");
    if (bookmark && toc.hyperlinks) {
      builder.open("w:hyperlink", { "w:anchor": bookmark, "w:history": "1" });
    }
    builder.open("w:r");
    builder.leaf("w:t", { "xml:space": "preserve" }, entry.text);
    builder.close("w:r");
    if (toc.pageNumbers) {
      builder.open("w:r");
      builder.leaf("w:tab");
      builder.close("w:r");
      if (bookmark) {
        builder.open("w:r");
        builder.leaf("w:fldChar", { "w:fldCharType": "begin" });
        builder.close("w:r");
        builder.open("w:r");
        builder.leaf(
          "w:instrText",
          { "xml:space": "preserve" },
          ` PAGEREF ${bookmark} \\h `,
        );
        builder.close("w:r");
        builder.open("w:r");
        builder.leaf("w:fldChar", { "w:fldCharType": "separate" });
        builder.close("w:r");
      }
      builder.open("w:r");
      builder.leaf("w:t", undefined, String(pageNumber ?? 1));
      builder.close("w:r");
      if (bookmark) {
        builder.open("w:r");
        builder.leaf("w:fldChar", { "w:fldCharType": "end" });
        builder.close("w:r");
      }
    }
    if (bookmark && toc.hyperlinks) builder.close("w:hyperlink");
    builder.close("w:p");
  }

  builder.open("w:p");
  builder.open("w:r");
  builder.leaf("w:fldChar", { "w:fldCharType": "end" });
  builder.close("w:r");
  builder.close("w:p");
}

/* -------------------------------------------------------------- sections */

function sectionPropertiesXml(
  builder: XmlBuilder,
  section: Section,
  sectionIndex: number,
  context: ExportContext,
): void {
  const page = section.page;
  const rids = context.headerFooterRids.get(sectionIndex);
  builder.open("w:sectPr");
  for (const variant of ["default", "first", "even"] as const) {
    const headerRid = rids?.headers[variant];
    if (headerRid)
      builder.leaf("w:headerReference", {
        "w:type": variant,
        "r:id": headerRid,
      });
    const footerRid = rids?.footers[variant];
    if (footerRid)
      builder.leaf("w:footerReference", {
        "w:type": variant,
        "r:id": footerRid,
      });
  }
  if (section.titlePage) builder.leaf("w:titlePg");
  builder.leaf("w:pgSz", {
    "w:w": ptToTwips(page.width),
    "w:h": ptToTwips(page.height),
    "w:orient": page.orientation === "landscape" ? "landscape" : undefined,
  });
  builder.leaf("w:pgMar", {
    "w:top": ptToTwips(page.margins.top),
    "w:right": ptToTwips(page.margins.right),
    "w:bottom": ptToTwips(page.margins.bottom),
    "w:left": ptToTwips(page.margins.left),
    "w:header": ptToTwips(page.margins.header),
    "w:footer": ptToTwips(page.margins.footer),
    "w:gutter": ptToTwips(page.margins.gutter),
  });
  if (page.borders) {
    builder.open("w:pgBorders", {
      "w:offsetFrom": page.borders.offsetFrom ?? "page",
      "w:display": page.borders.display,
      "w:zOrder": page.borders.zOrder,
    });
    for (const side of ["top", "left", "bottom", "right"] as const) {
      const border = page.borders[side];
      if (!border) continue;
      builder.leaf(`w:${side}`, {
        "w:val": borderStyleToOoxml(border.style),
        "w:sz": Math.max(2, Math.round(border.width * 8)),
        "w:space": 24,
        "w:color": colorAttr(border.color) ?? "auto",
      });
    }
    builder.close("w:pgBorders");
  }
  builder.leaf("w:cols", {
    "w:num": section.columns.count > 1 ? section.columns.count : undefined,
    "w:space": ptToTwips(section.columns.space),
    "w:equalWidth": section.columns.equalWidth === false ? "0" : undefined,
    "w:sep": section.columns.separator ? "1" : undefined,
  });
  if (section.pageNumbering) {
    builder.leaf("w:pgNumType", {
      "w:start": section.pageNumbering.start,
      "w:fmt": section.pageNumbering.format,
    });
  }
  if (section.breakBefore !== "nextPage")
    builder.leaf("w:type", { "w:val": section.breakBefore });
  builder.leaf("w:docGrid", {
    "w:linePitch": page.linePitch ? Math.round(page.linePitch * 20) : 360,
  });
  builder.close("w:sectPr");
}

/* ------------------------------------------------------------ part files */

function stylesXml(doc: DocDocument, context: ExportContext): string {
  const builder = new XmlBuilder().declaration();
  builder.open("w:styles", { "xmlns:w": NS.w, "xmlns:r": NS.r });
  builder.open("w:docDefaults");
  builder.open("w:rPrDefault");
  builder.open("w:rPr");
  const defaultRun = doc.styles.defaults.run ?? {};
  if (defaultRun.fontFamily) {
    builder.leaf("w:rFonts", {
      "w:ascii": defaultRun.fontFamily,
      "w:hAnsi": defaultRun.fontFamily,
    });
  }
  if (defaultRun.fontSize)
    builder.leaf("w:sz", { "w:val": Math.round(defaultRun.fontSize * 2) });
  if (defaultRun.language)
    builder.leaf("w:lang", { "w:val": defaultRun.language });
  builder.close("w:rPr");
  builder.close("w:rPrDefault");
  builder.open("w:pPrDefault");
  builder.open("w:pPr");
  builder.close("w:pPr");
  builder.close("w:pPrDefault");
  builder.close("w:docDefaults");

  for (const style of Object.values(doc.styles.styles)) {
    builder.open("w:style", {
      "w:type": style.type,
      "w:styleId": style.id,
      "w:default": style.isDefault ? "1" : undefined,
    });
    builder.leaf("w:name", { "w:val": style.name });
    if (style.basedOn) builder.leaf("w:basedOn", { "w:val": style.basedOn });
    if (style.next) builder.leaf("w:next", { "w:val": style.next });
    if (style.link) builder.leaf("w:link", { "w:val": style.link });
    if (style.uiPriority !== undefined)
      builder.leaf("w:uiPriority", { "w:val": style.uiPriority });
    if (style.qFormat) builder.leaf("w:qFormat");
    if (style.semiHidden) builder.leaf("w:semiHidden");
    if (style.paragraph && Object.keys(style.paragraph).length > 0) {
      paragraphPropsXml(
        builder,
        { type: "paragraph", id: "", props: style.paragraph, inlines: [] },
        context,
      );
    }
    if (style.run && Object.keys(style.run).length > 0) {
      const clean: RunProps = { ...style.run };
      delete clean.hyperlink;
      delete clean.revision;
      runPropsXml(builder, clean);
    }
    if (style.type === "table" && style.table) {
      builder.open("w:tblPr");
      if (style.table.borders) {
        builder.open("w:tblBorders");
        for (const side of ["top", "left", "bottom", "right"] as const) {
          const border = style.table.borders[side];
          if (!border) continue;
          builder.leaf(`w:${side}`, {
            "w:val": borderStyleToOoxml(border.style),
            "w:sz": Math.max(2, Math.round(border.width * 8)),
            "w:color": colorAttr(border.color) ?? "auto",
          });
        }
        const between = style.table.borders.between;
        if (between) {
          for (const tag of ["w:insideH", "w:insideV"] as const) {
            builder.leaf(tag, {
              "w:val": borderStyleToOoxml(between.style),
              "w:sz": Math.max(2, Math.round(between.width * 8)),
              "w:color": colorAttr(between.color) ?? "auto",
            });
          }
        }
        builder.close("w:tblBorders");
      }
      if (style.table.cellMargins) {
        builder.open("w:tblCellMar");
        for (const side of ["top", "left", "bottom", "right"] as const) {
          const value = style.table.cellMargins[side];
          if (value === undefined) continue;
          builder.leaf(`w:${side}`, {
            "w:w": ptToTwips(value),
            "w:type": "dxa",
          });
        }
        builder.close("w:tblCellMar");
      }
      if (style.table.shading?.fill) {
        builder.leaf("w:shd", {
          "w:val": "clear",
          "w:fill": colorAttr(style.table.shading.fill),
        });
      }
      builder.close("w:tblPr");
    }
    builder.close("w:style");
  }
  builder.close("w:styles");
  return builder.toString();
}

function numberingXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("w:numbering", { "xmlns:w": NS.w });
  for (const abstract of Object.values(doc.numbering.abstract)) {
    builder.open("w:abstractNum", { "w:abstractNumId": abstract.id });
    if (abstract.multiLevelType)
      builder.leaf("w:multiLevelType", { "w:val": abstract.multiLevelType });
    for (const level of abstract.levels) {
      builder.open("w:lvl", { "w:ilvl": level.level });
      builder.leaf("w:start", { "w:val": level.start });
      builder.leaf("w:numFmt", { "w:val": level.numFmt });
      if (level.pStyle) builder.leaf("w:pStyle", { "w:val": level.pStyle });
      builder.leaf("w:lvlText", { "w:val": level.lvlText });
      builder.leaf("w:lvlJc", { "w:val": level.lvlJc });
      if (level.suff) builder.leaf("w:suff", { "w:val": level.suff });
      if (level.paragraph?.indent) {
        builder.open("w:pPr");
        builder.leaf("w:ind", {
          "w:left":
            level.paragraph.indent.left !== undefined
              ? ptToTwips(level.paragraph.indent.left)
              : undefined,
          "w:hanging":
            level.paragraph.indent.hanging !== undefined
              ? ptToTwips(level.paragraph.indent.hanging)
              : undefined,
        });
        builder.close("w:pPr");
      }
      if (level.run) runPropsXml(builder, level.run);
      builder.close("w:lvl");
    }
    builder.close("w:abstractNum");
  }
  for (const num of Object.values(doc.numbering.nums)) {
    builder.open("w:num", { "w:numId": num.id });
    builder.leaf("w:abstractNumId", { "w:val": num.abstractId });
    for (const [level, override] of Object.entries(num.levelOverrides ?? {})) {
      if (override.start === undefined) continue;
      builder.open("w:lvlOverride", { "w:ilvl": level });
      builder.leaf("w:startOverride", { "w:val": override.start });
      builder.close("w:lvlOverride");
    }
    builder.close("w:num");
  }
  builder.close("w:numbering");
  return builder.toString();
}

function settingsXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("w:settings", {
    "xmlns:w": NS.w,
    "xmlns:w14": NS.w14,
    "xmlns:mc": NS.mc,
    "mc:Ignorable": "w14",
  });
  builder.leaf("w:zoom", { "w:percent": 100 });
  builder.leaf("w:defaultTabStop", {
    "w:val": ptToTwips(doc.settings.defaultTabStop),
  });
  if (doc.settings.evenAndOddHeaders) builder.leaf("w:evenAndOddHeaders");
  if (doc.settings.trackRevisions) builder.leaf("w:trackChanges");
  if (doc.settings.autoHyphenation) builder.leaf("w:autoHyphenation");
  if (doc.settings.defaultLanguage)
    builder.leaf("w:themeFontLang", { "w:val": doc.settings.defaultLanguage });
  builder.open("w:compat");
  builder.leaf("w:compatSetting", {
    "w:name": "compatibilityMode",
    "w:uri": "http://schemas.microsoft.com/office/word",
    "w:val": doc.settings.compatibilityMode ?? "15",
  });
  builder.close("w:compat");
  builder.close("w:settings");
  return builder.toString();
}

function themeXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("a:theme", {
    "xmlns:a": NS.a,
    name: doc.theme.name ?? "Office Theme",
  });
  builder.open("a:themeElements");
  builder.open("a:clrScheme", { name: "Office" });
  const colors: Array<[string, string]> = [
    ["dk1", doc.theme.colors.dark1 ?? "#000000"],
    ["lt1", doc.theme.colors.light1 ?? "#ffffff"],
    ["dk2", doc.theme.colors.dark2 ?? "#44546a"],
    ["lt2", doc.theme.colors.light2 ?? "#e7e6e6"],
    ["accent1", doc.theme.colors.accent1 ?? "#4472c4"],
    ["accent2", doc.theme.colors.accent2 ?? "#ed7d31"],
    ["accent3", doc.theme.colors.accent3 ?? "#a5a5a5"],
    ["accent4", doc.theme.colors.accent4 ?? "#ffc000"],
    ["accent5", doc.theme.colors.accent5 ?? "#5b9bd5"],
    ["accent6", doc.theme.colors.accent6 ?? "#70ad47"],
    ["hlink", doc.theme.colors.hyperlink ?? "#0563c1"],
    ["folHlink", doc.theme.colors.followedHyperlink ?? "#954f72"],
  ];
  for (const [name, color] of colors) {
    builder.open(`a:${name}`);
    builder.leaf("a:srgbClr", {
      val: (colorOrUndefined(color) ?? "#000000").replace("#", ""),
    });
    builder.close(`a:${name}`);
  }
  builder.close("a:clrScheme");
  builder.open("a:fontScheme", { name: "Office" });
  for (const kind of ["majorFont", "minorFont"] as const) {
    const font =
      kind === "majorFont" ? doc.theme.fonts.major : doc.theme.fonts.minor;
    builder.open(`a:${kind}`);
    builder.leaf("a:latin", { typeface: font.latin });
    builder.leaf("a:ea", { typeface: font.eastAsia });
    builder.leaf("a:cs", { typeface: font.complexScript });
    builder.close(`a:${kind}`);
  }
  builder.close("a:fontScheme");
  builder.open("a:fmtScheme", { name: "Office" });
  builder.leaf("a:fillStyleLst");
  builder.leaf("a:lnStyleLst");
  builder.leaf("a:effectStyleLst");
  builder.leaf("a:bgFillStyleLst");
  builder.close("a:fmtScheme");
  builder.close("a:themeElements");
  builder.close("a:theme");
  return builder.toString();
}

function fontTableXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("w:fonts", { "xmlns:w": NS.w });
  const families = new Set<string>([
    doc.theme.fonts.major.latin,
    doc.theme.fonts.minor.latin,
  ]);
  for (const style of Object.values(doc.styles.styles)) {
    if (style.run?.fontFamily) families.add(style.run.fontFamily);
  }
  for (const asset of doc.media) void asset;
  for (const family of families) {
    builder.open("w:font", { "w:name": family });
    builder.leaf("w:charset", { "w:val": "00" });
    builder.leaf("w:family", { "w:val": "swiss" });
    builder.leaf("w:pitch", { "w:val": "variable" });
    builder.close("w:font");
  }
  builder.close("w:fonts");
  return builder.toString();
}

function coreXml(doc: DocDocument, preserve: boolean): string {
  const builder = new XmlBuilder().declaration();
  builder.open("cp:coreProperties", {
    "xmlns:cp": NS.cp,
    "xmlns:dc": NS.dc,
    "xmlns:dcterms": NS.dcterms,
    "xmlns:xsi": NS.xsi,
  });
  if (doc.metadata.title)
    builder.leaf("dc:title", undefined, doc.metadata.title);
  if (doc.metadata.subject)
    builder.leaf("dc:subject", undefined, doc.metadata.subject);
  if (doc.metadata.creator)
    builder.leaf("dc:creator", undefined, doc.metadata.creator);
  if (doc.metadata.lastModifiedBy)
    builder.leaf("cp:lastModifiedBy", undefined, doc.metadata.lastModifiedBy);
  if (doc.metadata.keywords.length > 0)
    builder.leaf("cp:keywords", undefined, doc.metadata.keywords.join("; "));
  if (doc.metadata.description)
    builder.leaf("dc:description", undefined, doc.metadata.description);
  if (doc.metadata.category)
    builder.leaf("cp:category", undefined, doc.metadata.category);
  const created = preserve
    ? doc.metadata.created
    : (doc.metadata.created ?? new Date().toISOString());
  const modified = preserve ? doc.metadata.modified : new Date().toISOString();
  if (created)
    builder.leaf("dcterms:created", { "xsi:type": "dcterms:W3CDTF" }, created);
  if (modified)
    builder.leaf(
      "dcterms:modified",
      { "xsi:type": "dcterms:W3CDTF" },
      modified,
    );
  builder.leaf("cp:revision", undefined, doc.metadata.revision ?? "1");
  builder.close("cp:coreProperties");
  return builder.toString();
}

function appXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("Properties", {
    xmlns:
      "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    "xmlns:vt":
      "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
  });
  builder.leaf("Application", undefined, "DSH Document Engine");
  builder.leaf("DocSecurity", undefined, "0");
  builder.leaf("ScaleCrop", undefined, "false");
  builder.leaf("Company", undefined, doc.metadata.custom.Company ?? "");
  builder.leaf("LinksUpToDate", undefined, "false");
  builder.leaf("SharedDoc", undefined, "false");
  builder.leaf("HyperlinksChanged", undefined, "false");
  builder.leaf("AppVersion", undefined, "16.0000");
  builder.close("Properties");
  return builder.toString();
}

function customXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("Properties", {
    xmlns:
      "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
    "xmlns:vt":
      "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
  });
  let pid = 1;
  for (const [name, value] of Object.entries(doc.metadata.custom)) {
    builder.open("property", {
      fmtid: "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}",
      pid: String(pid),
      name,
    });
    builder.leaf("vt:lpwstr", undefined, value);
    builder.close("property");
    pid += 1;
  }
  builder.close("Properties");
  return builder.toString();
}

function notesXml(
  doc: DocDocument,
  kind: "footnote" | "endnote",
  context: ExportContext,
): string {
  const builder = new XmlBuilder().declaration();
  const containerTag = kind === "footnote" ? "w:footnotes" : "w:endnotes";
  const noteTag = kind === "footnote" ? "w:footnote" : "w:endnote";
  builder.open(containerTag, {
    "xmlns:w": NS.w,
    "xmlns:r": NS.r,
    "xmlns:a": NS.a,
    "xmlns:wp": NS.wp,
    "xmlns:pic": NS.pic,
  });
  builder.open(noteTag, { "w:type": "separator", "w:id": "-1" });
  builder.open("w:p");
  builder.open("w:r");
  builder.leaf("w:separator");
  builder.close("w:r");
  builder.close("w:p");
  builder.close(noteTag);
  builder.open(noteTag, { "w:type": "continuationSeparator", "w:id": "0" });
  builder.open("w:p");
  builder.open("w:r");
  builder.leaf("w:continuationSeparator");
  builder.close("w:r");
  builder.close("w:p");
  builder.close(noteTag);

  const notes = kind === "footnote" ? doc.footnotes : doc.endnotes;
  for (const note of notes) {
    const numericId = context.noteNumbers.get(note.id) ?? 2;
    builder.open(noteTag, { "w:id": numericId });
    for (const block of note.blocks) {
      if (block.type === "paragraph") {
        builder.open("w:p");
        for (const group of groupHyperlinks(block.inlines)) {
          for (const inline of group.inlines) runXml(builder, inline, context);
        }
        builder.close("w:p");
      } else {
        blockXml(builder, block, context);
      }
    }
    builder.close(noteTag);
  }
  builder.close(containerTag);
  return builder.toString();
}

function commentsXml(doc: DocDocument, context: ExportContext): string {
  const builder = new XmlBuilder().declaration();
  builder.open("w:comments", { "xmlns:w": NS.w, "xmlns:w15": NS.w15 });
  for (const comment of doc.comments) {
    const id = context.commentNumber.get(comment.id);
    if (id === undefined) continue;
    builder.open("w:comment", {
      "w:id": id,
      "w:author": comment.author,
      "w:initials": comment.initials,
      "w:date": comment.date,
      "w:commentId": stableHexId(comment.id),
    });
    for (const block of comment.blocks) {
      if (block.type === "paragraph") {
        builder.open("w:p");
        builder.open("w:pPr");
        builder.leaf("w:pStyle", { "w:val": "CommentText" });
        builder.close("w:pPr");
        for (const group of groupHyperlinks(block.inlines)) {
          for (const inline of group.inlines) runXml(builder, inline, context);
        }
        builder.close("w:p");
      } else {
        blockXml(builder, block, context);
      }
    }
    builder.close("w:comment");
  }
  builder.close("w:comments");
  return builder.toString();
}

function commentsExtendedXml(doc: DocDocument): string {
  const builder = new XmlBuilder().declaration();
  builder.open("w15:commentsEx", { "xmlns:w15": NS.w15, "xmlns:w": NS.w });
  for (const comment of doc.comments) {
    builder.leaf("w15:commentEx", {
      "w15:paraId": stableHexId(comment.id),
      "w15:done": comment.resolved ? "1" : "0",
    });
  }
  builder.close("w15:commentsEx");
  return builder.toString();
}

/** Deterministic 8-hex identifier (Word expects 8 hex digits for paraId). */
function stableHexId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(-8);
}

function relsXml(
  rels: Map<
    string,
    { id: string; type: string; target: string; mode?: "External" }
  >,
): string {
  const builder = new XmlBuilder().declaration();
  builder.open("Relationships", { xmlns: NS.rel });
  for (const rel of rels.values()) {
    builder.leaf("Relationship", {
      Id: rel.id,
      Type: rel.type,
      Target: rel.target,
      TargetMode: rel.mode,
    });
  }
  builder.close("Relationships");
  return builder.toString();
}

function contentTypesXml(
  doc: DocDocument,
  headerFooterParts: Array<{ path: string }>,
  flavor: DocxFlavor,
  options: ExportOptions,
): string {
  const builder = new XmlBuilder().declaration();
  builder.open("Types", { xmlns: NS.ct });
  builder.leaf("Default", {
    Extension: "rels",
    ContentType: "application/vnd.openxmlformats-package.relationships+xml",
  });
  builder.leaf("Default", { Extension: "xml", ContentType: "application/xml" });
  const seen = new Set<string>();
  for (const asset of doc.media) {
    const extension = asset.fileName.split(".").pop()?.toLowerCase() ?? "png";
    if (seen.has(extension)) continue;
    seen.add(extension);
    builder.leaf("Default", {
      Extension: extension,
      ContentType: asset.contentType,
    });
  }
  const mainType =
    flavor === "dotx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"
      : flavor === "docm"
        ? "application/vnd.ms-word.document.macroEnabled.main+xml"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  builder.leaf("Override", {
    PartName: "/word/document.xml",
    ContentType: mainType,
  });
  builder.leaf("Override", {
    PartName: "/word/styles.xml",
    ContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  });
  builder.leaf("Override", {
    PartName: "/word/numbering.xml",
    ContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  });
  builder.leaf("Override", {
    PartName: "/word/settings.xml",
    ContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  });
  builder.leaf("Override", {
    PartName: "/word/theme/theme1.xml",
    ContentType: "application/vnd.openxmlformats-officedocument.theme+xml",
  });
  builder.leaf("Override", {
    PartName: "/word/fontTable.xml",
    ContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
  });
  for (const part of headerFooterParts) {
    builder.leaf("Override", {
      PartName: `/${part.path}`,
      ContentType: part.path.includes("header")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
    });
  }
  if (doc.footnotes.length > 0) {
    builder.leaf("Override", {
      PartName: "/word/footnotes.xml",
      ContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
    });
  }
  if (doc.endnotes.length > 0) {
    builder.leaf("Override", {
      PartName: "/word/endnotes.xml",
      ContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
    });
  }
  if (options.includeComments !== false && doc.comments.length > 0) {
    builder.leaf("Override", {
      PartName: "/word/comments.xml",
      ContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    });
    builder.leaf("Override", {
      PartName: "/word/commentsExtended.xml",
      ContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    });
  }
  builder.leaf("Override", {
    PartName: "/docProps/core.xml",
    ContentType: "application/vnd.openxmlformats-package.core-properties+xml",
  });
  builder.leaf("Override", {
    PartName: "/docProps/app.xml",
    ContentType:
      "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  });
  if (Object.keys(doc.metadata.custom).length > 0) {
    builder.leaf("Override", {
      PartName: "/docProps/custom.xml",
      ContentType:
        "application/vnd.openxmlformats-officedocument.custom-properties+xml",
    });
  }
  builder.close("Types");
  return builder.toString();
}

/* --------------------------------------------------------------- public */

/** Serializes the document into a WordprocessingML package. */
export async function exportDocx(
  doc: DocDocument,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const flavor = options.flavor ?? "docx";
  const warnings: string[] = [];
  const writer = new PackageWriter();
  const documentPath = "word/document.xml";

  const commentNumber = new Map<string, number>();
  if (options.includeComments !== false) {
    doc.comments.forEach((comment, index) =>
      commentNumber.set(comment.id, index),
    );
  }

  const headingBookmarks = new Map<string, string>();
  if (
    doc.sections.some((section) =>
      section.blocks.some((block) => block.type === "toc"),
    )
  ) {
    let sequence = 0;
    for (const entry of documentOutline(doc, {
      maxLevel: 9,
      includeTitle: true,
    })) {
      sequence += 1;
      headingBookmarks.set(
        entry.blockId,
        `_Toc${String(sequence).padStart(9, "0")}`,
      );
    }
  }

  let idCounter = 100;
  const headerFooterRids = new Map<
    number,
    { headers: Record<string, string>; footers: Record<string, string> }
  >();
  const baseContext = {
    doc,
    writer,
    nextId: () => {
      idCounter += 1;
      return idCounter;
    },
    commentNumber,
    revisionNumber: new Map<string, number>(),
    headingBookmarks,
    noteNumbers: new Map<string, number>(),
    bookmarkNumbers: new Map<string, number>(),
    pageNumbers: options.pageNumbers,
    headerFooterRids,
    warnings,
  } satisfies Omit<ExportContext, "partPath">;

  // Stable numeric ids for notes (Word requires integer ids; separators use -1/0).
  for (const note of doc.footnotes)
    noteIdFor(baseContext as ExportContext, note.id);
  for (const note of doc.endnotes)
    noteIdFor(baseContext as ExportContext, note.id);

  /* headers and footers are written before the body so ids resolve */
  const headerFooterParts: Array<{ path: string; xml: string }> = [];
  let headerCounter = 0;
  let footerCounter = 0;
  const writeHeaderFooter = (
    part: HeaderFooter,
    kind: "header" | "footer",
  ): string => {
    let number: number;
    if (kind === "header") {
      headerCounter += 1;
      number = headerCounter;
    } else {
      footerCounter += 1;
      number = footerCounter;
    }
    const path = `word/${kind}${number}.xml`;
    const context: ExportContext = { ...baseContext, partPath: path };
    const tag = kind === "header" ? "w:hdr" : "w:ftr";
    const builder = new XmlBuilder().declaration();
    builder.open(tag, {
      "xmlns:w": NS.w,
      "xmlns:r": NS.r,
      "xmlns:a": NS.a,
      "xmlns:wp": NS.wp,
      "xmlns:pic": NS.pic,
    });
    for (const block of part.blocks) blockXml(builder, block, context);
    builder.close(tag);
    headerFooterParts.push({ path, xml: builder.toString() });
    return path;
  };

  doc.sections.forEach((section, sectionIndex) => {
    const resolved = {
      headers: {} as Record<string, string>,
      footers: {} as Record<string, string>,
    };
    for (const variant of ["default", "first", "even"] as const) {
      const header = section.headers[variant];
      if (header) {
        const path = writeHeaderFooter(header, "header");
        resolved.headers[variant] = writer.addRelationship(
          documentPath,
          REL_TYPES.header,
          path.replace(/^word\//, ""),
        );
      }
      const footer = section.footers[variant];
      if (footer) {
        const path = writeHeaderFooter(footer, "footer");
        resolved.footers[variant] = writer.addRelationship(
          documentPath,
          REL_TYPES.footer,
          path.replace(/^word\//, ""),
        );
      }
    }
    headerFooterRids.set(sectionIndex, resolved);
  });

  /* body */
  const documentBuilder = new XmlBuilder().declaration();
  documentBuilder.open("w:document", ROOT_NAMESPACES);
  documentBuilder.open("w:body");
  const bodyContext: ExportContext = { ...baseContext, partPath: documentPath };

  doc.sections.forEach((section, sectionIndex) => {
    const isLast = sectionIndex === doc.sections.length - 1;
    const blocks = section.blocks;
    const emitSectionBreak = () => {
      documentBuilder.open("w:p");
      const sectionBuilder = new XmlBuilder();
      sectionPropertiesXml(sectionBuilder, section, sectionIndex, bodyContext);
      documentBuilder.raw(`<w:pPr>${sectionBuilder.toString()}</w:pPr>`);
      documentBuilder.close("w:p");
    };

    if (blocks.length === 0) {
      if (isLast) {
        documentBuilder.open("w:p");
        documentBuilder.close("w:p");
        sectionPropertiesXml(
          documentBuilder,
          section,
          sectionIndex,
          bodyContext,
        );
      } else {
        emitSectionBreak();
      }
      return;
    }

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const isLastBlock = index === blocks.length - 1;
      if (isLastBlock && !isLast) {
        if (block.type === "paragraph") {
          paragraphXml(documentBuilder, block, bodyContext, {
            section,
            sectionIndex,
          });
        } else {
          blockXml(documentBuilder, block, bodyContext);
          emitSectionBreak();
        }
      } else {
        blockXml(documentBuilder, block, bodyContext);
      }
    }
    if (isLast)
      sectionPropertiesXml(documentBuilder, section, sectionIndex, bodyContext);
  });

  documentBuilder.close("w:body");
  documentBuilder.close("w:document");

  /* parts */
  const parts: Array<{ path: string; data: Buffer | string }> = [
    { path: documentPath, data: documentBuilder.toString() },
    { path: "word/styles.xml", data: stylesXml(doc, bodyContext) },
    { path: "word/numbering.xml", data: numberingXml(doc) },
    { path: "word/settings.xml", data: settingsXml(doc) },
    { path: "word/theme/theme1.xml", data: themeXml(doc) },
    { path: "word/fontTable.xml", data: fontTableXml(doc) },
  ];
  for (const part of headerFooterParts)
    parts.push({ path: part.path, data: part.xml });
  if (doc.footnotes.length > 0) {
    parts.push({
      path: "word/footnotes.xml",
      data: notesXml(doc, "footnote", bodyContext),
    });
  }
  if (doc.endnotes.length > 0) {
    parts.push({
      path: "word/endnotes.xml",
      data: notesXml(doc, "endnote", bodyContext),
    });
  }
  if (options.includeComments !== false && doc.comments.length > 0) {
    parts.push({
      path: "word/comments.xml",
      data: commentsXml(doc, bodyContext),
    });
    parts.push({
      path: "word/commentsExtended.xml",
      data: commentsExtendedXml(doc),
    });
  }
  parts.push({
    path: "docProps/core.xml",
    data: coreXml(doc, options.preserveTimestamps ?? false),
  });
  parts.push({ path: "docProps/app.xml", data: appXml(doc) });
  if (Object.keys(doc.metadata.custom).length > 0) {
    parts.push({ path: "docProps/custom.xml", data: customXml(doc) });
  }
  for (const [mediaId, data] of writer.media) {
    const asset = doc.media.find((entry) => entry.id === mediaId);
    const fileName = (asset?.fileName ?? `${mediaId}.png`).replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    parts.push({ path: `word/media/${fileName}`, data });
  }

  /* relationships */
  const documentRels = new Map(writer.rels.get(documentPath) ?? []);
  const knownRels: Array<{ id: string; type: string; target: string }> = [
    { id: "rIdStyles", type: REL_TYPES.styles, target: "styles.xml" },
    { id: "rIdNumbering", type: REL_TYPES.numbering, target: "numbering.xml" },
    { id: "rIdSettings", type: REL_TYPES.settings, target: "settings.xml" },
    { id: "rIdTheme", type: REL_TYPES.theme, target: "theme/theme1.xml" },
    { id: "rIdFontTable", type: REL_TYPES.fontTable, target: "fontTable.xml" },
  ];
  if (doc.footnotes.length > 0) {
    knownRels.push({
      id: "rIdFootnotes",
      type: REL_TYPES.footnotes,
      target: "footnotes.xml",
    });
  }
  if (doc.endnotes.length > 0) {
    knownRels.push({
      id: "rIdEndnotes",
      type: REL_TYPES.endnotes,
      target: "endnotes.xml",
    });
  }
  if (options.includeComments !== false && doc.comments.length > 0) {
    knownRels.push({
      id: "rIdComments",
      type: REL_TYPES.comments,
      target: "comments.xml",
    });
    knownRels.push({
      id: "rIdCommentsExtended",
      type: REL_TYPES.commentsExtended,
      target: "commentsExtended.xml",
    });
  }
  for (const entry of knownRels) {
    documentRels.set(entry.id, {
      id: entry.id,
      type: entry.type,
      target: entry.target,
    });
  }
  parts.push({
    path: "word/_rels/document.xml.rels",
    data: relsXml(documentRels),
  });
  for (const part of headerFooterParts) {
    const rels = writer.rels.get(part.path);
    if (rels && rels.size > 0) {
      parts.push({
        path: `${part.path.replace("word/", "word/_rels/")}.rels`,
        data: relsXml(rels),
      });
    }
  }

  const rootRels = new Map<
    string,
    { id: string; type: string; target: string; mode?: "External" }
  >([
    [
      "rId1",
      {
        id: "rId1",
        type: REL_TYPES.officeDocument,
        target: "word/document.xml",
      },
    ],
    ["rId2", { id: "rId2", type: REL_TYPES.core, target: "docProps/core.xml" }],
    ["rId3", { id: "rId3", type: REL_TYPES.app, target: "docProps/app.xml" }],
  ]);
  if (Object.keys(doc.metadata.custom).length > 0) {
    rootRels.set("rId4", {
      id: "rId4",
      type: REL_TYPES.custom,
      target: "docProps/custom.xml",
    });
  }
  parts.push({ path: "_rels/.rels", data: relsXml(rootRels) });
  parts.push({
    path: "[Content_Types].xml",
    data: contentTypesXml(doc, headerFooterParts, flavor, options),
  });

  const droppedParts = doc.unknown
    .filter((entry) => entry.location.startsWith("part:"))
    .map((entry) => entry.location.slice(5));

  const buffer = await writePackage(parts);
  return { buffer, warnings, droppedParts };
}
