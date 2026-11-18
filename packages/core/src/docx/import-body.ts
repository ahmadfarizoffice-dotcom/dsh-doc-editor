import type { Element } from "@xmldom/xmldom";
import type {
  Block,
  Bookmark,
  DocComment,
  DocDocument,
  ImageAnchor,
  ImageInline,
  Inline,
  MathNode,
  Note,
  Paragraph,
  ParagraphProps,
  RevisionMark,
  RowProps,
  RunProps,
  ShapeTextBox,
  Table,
  TableCell,
  TableRow,
  TextWrap,
  AnchorPosition,
} from "../model/types.js";
import { emuToPt } from "../model/types.js";
import {
  NS,
  all,
  attr,
  childElements,
  first,
  localNameOf,
  onOff,
  parseXml,
  serializeXml,
  textOf,
  wAttr,
  wVal,
  type XmlDocument,
} from "./xml.js";
import {
  alignmentFromOoxml,
  boolAttr,
  normalizeColor,
  parseIntOrUndefined,
  parseBorder,
  twips,
} from "./ooxml.js";
import {
  parseCellMargins,
  parseParagraphProps,
  parseRunProps,
  parseTableProperties,
  type ParseContext,
  type RelationshipMap,
} from "./parsers.js";

export interface MediaRegistry {
  /** Registers a media payload and returns a document media id. */
  register(target: {
    path: string;
    contentType: string;
    fileName: string;
    data: Buffer;
    widthPx?: number;
    heightPx?: number;
    dpi?: number;
  }): string;
  /** Existing id for a package path, if already registered. */
  lookup(path: string): string | undefined;
}

export interface BodyParserHost {
  nextId(prefix: string): string;
  relationshipsFor(partPath: string): RelationshipMap;
  readPart(path: string): Buffer | undefined;
  media: MediaRegistry;
  notes: { footnotes: Note[]; endnotes: Note[]; commentIds: Set<string> };
  comments: DocComment[];
  bookmarks: Bookmark[];
  shapes: ShapeTextBox[];
  revisions: DocDocument["revisions"];
  unknown: DocDocument["unknown"];
  recordFeature(feature: string, note?: string): void;
  warn(message: string): void;
  /** Marks inline content that could not be interpreted. */
  recordUnknownElement(
    location: string,
    element: string,
    xml: string,
    reason: string,
  ): void;
  /** Text box content parsed into blocks (shapes live outside the body). */
  registerShape(shape: ShapeTextBox): string;
  theme: import("../model/types.js").Theme;
  styles: import("../model/types.js").StyleSheet;
  numbering: import("../model/types.js").NumberingDefs;
}

const SYMBOL_MAP: Record<string, string> = {
  F0B7: "\u2022",
  F0A7: "\u25AA",
  F0D8: "\u27A1",
  F0E0: "\u2192",
  F0FC: "\u2713",
};

export class BodyParser {
  constructor(private readonly host: BodyParserHost) {}

  private ctx(partPath: string): ParseContext {
    return {
      theme: this.host.theme,
      styles: this.host.styles,
      numbering: this.host.numbering,
      relationships: this.host.relationshipsFor(partPath),
      partPath,
    };
  }

  /* ---------------------------------------------------------- blocks */

  parseBlocks(
    elements: Element[],
    partPath: string,
    location: string,
  ): Block[] {
    const ctx = this.ctx(partPath);
    const blocks: Block[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      const name = localNameOf(element);
      switch (name) {
        case "p": {
          const parsed = this.parseParagraph(
            element,
            ctx,
            `${location}/p[${index}]`,
          );
          blocks.push(parsed.paragraph);
          break;
        }
        case "tbl": {
          blocks.push(
            this.parseTable(element, ctx, `${location}/tbl[${index}]`),
          );
          break;
        }
        case "sdt": {
          blocks.push(
            ...this.parseBlockSdt(element, ctx, `${location}/sdt[${index}]`),
          );
          break;
        }
        case "customXml": {
          const content = first(element, NS.w, "customXmlPr");
          void content;
          this.host.recordFeature("block.customXml");
          const inner = childElements(element).filter((child) =>
            ["p", "tbl", "sdt"].includes(localNameOf(child)),
          );
          blocks.push(
            ...this.parseBlocks(inner, partPath, `${location}/customXml`),
          );
          this.host.recordUnknownElement(
            `${location}/customXml[${index}]`,
            "w:customXml",
            serializeXml(element),
            "Custom XML wrapper content is rendered; wrapper semantics are not re-emitted on export",
          );
          break;
        }
        case "altChunk": {
          this.host.recordFeature("block.altChunk");
          this.host.recordUnknownElement(
            `${location}/altChunk`,
            "w:altChunk",
            serializeXml(element),
            "Embedded alternative-format chunk is preserved but not expanded",
          );
          break;
        }
        case "bookmarkStart":
        case "bookmarkEnd":
          // Handled by paragraph parsing; body-level bookmarks are recorded.
          this.recordBodyBookmark(element);
          break;
        default:
          break;
      }
    }
    return blocks;
  }

  private recordBodyBookmark(element: Element): void {
    const name =
      localNameOf(element) === "bookmarkStart"
        ? wAttr(element, "name")
        : undefined;
    if (!name) return;
    const id = wAttr(element, "id") ?? "";
    this.host.bookmarks.push({ name, id, paragraphId: "" });
  }

  private parseBlockSdt(
    element: Element,
    ctx: ParseContext,
    location: string,
  ): Block[] {
    this.host.recordFeature("block.contentControl");
    const content = first(element, NS.w, "sdtContent");
    const inner = content ? childElements(content) : [];
    const blocks = this.parseBlocks(
      inner.filter((child) => ["p", "tbl", "sdt"].includes(localNameOf(child))),
      ctx.partPath,
      location,
    );
    this.host.recordUnknownElement(
      location,
      "w:sdt",
      serializeXml(element),
      "Content control content is rendered; control properties are recorded, not re-exported",
    );
    return blocks;
  }

  /* ------------------------------------------------------ paragraphs */

  parseParagraph(
    element: Element,
    ctx: ParseContext,
    location: string,
  ): { paragraph: Paragraph; sector: SectionSector | undefined } {
    const pPr = first(element, NS.w, "pPr");
    const props = parseParagraphProps(pPr, ctx);
    const style = wVal(first(pPr, NS.w, "pStyle")) ?? undefined;
    const id = this.host.nextId("p");
    const paragraph: Paragraph = {
      type: "paragraph",
      id,
      style,
      props,
      inlines: [],
    };

    const markRevision = this.parseParagraphMarkRevision(pPr);
    if (markRevision) paragraph.revision = markRevision;

    paragraph.inlines = this.parseInlines(
      childElements(element),
      ctx,
      location,
      id,
    );

    if (props.numbering) this.host.recordFeature("lists.numbering");
    if (style) this.host.recordFeature("paragraph.style");
    if (props.borders) this.host.recordFeature("paragraph.borders");
    if (props.shading) this.host.recordFeature("paragraph.shading");
    if (props.tabStops) this.host.recordFeature("paragraph.tabs");
    if (props.frame) this.host.recordFeature("paragraph.frame");

    const sectPr = first(pPr, NS.w, "sectPr");
    const sector = sectPr ? { element: sectPr, props } : undefined;
    return { paragraph, sector };
  }

  private parseParagraphMarkRevision(
    pPr: Element | undefined,
  ): RevisionMark | undefined {
    if (!pPr) return undefined;
    const rPr = first(pPr, NS.w, "rPr");
    if (!rPr) return undefined;
    const del = first(rPr, NS.w, "del");
    if (del) {
      this.host.recordFeature("revisions.delete");
      return this.revisionMark(del, "delete");
    }
    const ins = first(rPr, NS.w, "ins");
    if (ins) {
      this.host.recordFeature("revisions.insert");
      return this.revisionMark(ins, "insert");
    }
    return undefined;
  }

  private revisionMark(
    node: Element,
    kind: RevisionMark["kind"],
  ): RevisionMark {
    const id = wAttr(node, "id") ?? this.host.nextId("rev");
    const author = wAttr(node, "author");
    const date = wAttr(node, "date");
    const existing = this.host.revisions.find((revision) => revision.id === id);
    if (!existing) {
      this.host.revisions.push({
        id,
        kind,
        author,
        date,
        summary:
          kind === "insert"
            ? "Paragraph mark inserted"
            : "Paragraph mark deleted",
        blockIds: [],
      });
    }
    return { id, kind, author, date };
  }

  /* --------------------------------------------------------- inlines */

  parseInlines(
    children: Element[],
    ctx: ParseContext,
    location: string,
    paragraphId: string,
  ): Inline[] {
    const out: Inline[] = [];
    const fieldStack: Array<{
      instr: string;
      result: Inline[];
      phase: "instr" | "result";
      beginId: string;
    }> = [];
    const push = (inline: Inline) => {
      const top = fieldStack[fieldStack.length - 1];
      if (top && top.phase === "result" && inline.type !== "field") {
        top.result.push(inline);
        return;
      }
      out.push(inline);
    };

    const handleFieldChar = (run: Element) => {
      for (const node of childElements(run)) {
        const name = localNameOf(node);
        if (name === "fldChar") {
          const type = wAttr(node, "fldCharType");
          if (type === "begin") {
            fieldStack.push({
              instr: "",
              result: [],
              phase: "instr",
              beginId: wAttr(node, "fldCharType") ?? "",
            });
          } else if (type === "separate") {
            const top = fieldStack[fieldStack.length - 1];
            if (top) top.phase = "result";
          } else if (type === "end") {
            const top = fieldStack.pop();
            if (top) {
              const field: Inline = {
                type: "field",
                instr: top.instr.trim(),
                simple: false,
                result: top.result,
              };
              this.host.recordFeature("fields");
              const container = fieldStack[fieldStack.length - 1];
              if (container && container.phase === "result")
                container.result.push(field);
              else out.push(field);
            }
          }
        } else if (name === "instrText") {
          const top = fieldStack[fieldStack.length - 1];
          if (top) top.instr += textOf(node);
        }
      }
    };

    for (const child of children) {
      const name = localNameOf(child);
      switch (name) {
        case "r": {
          if (this.isFieldControlRun(child)) {
            handleFieldChar(child);
            break;
          }
          for (const inline of this.parseRun(child, ctx, paragraphId, location))
            push(inline);
          break;
        }
        case "hyperlink": {
          const target = this.hyperlinkTarget(child, ctx);
          const targetCopy = { ...target };
          for (const run of childElements(child)) {
            const runName = localNameOf(run);
            if (runName === "r") {
              const parsed = this.parseRun(run, ctx, paragraphId, location);
              for (const inline of parsed)
                push(this.withHyperlink(inline, targetCopy));
            } else if (runName === "history") {
              // ignore revision authoring hint
            }
          }
          this.host.recordFeature("hyperlink");
          break;
        }
        case "fldSimple": {
          const instr = wAttr(child, "instr") ?? "";
          const result: Inline[] = [];
          for (const run of childElements(child)) {
            if (localNameOf(run) !== "r") continue;
            result.push(...this.parseRun(run, ctx, paragraphId, location));
          }
          const field: Inline = {
            type: "field",
            instr: instr.trim(),
            simple: true,
            result,
          };
          this.host.recordFeature("fields");
          push(field);
          break;
        }
        case "bookmarkStart": {
          const bookmarkName = wAttr(child, "name") ?? "";
          const bookmarkId = wAttr(child, "id") ?? this.host.nextId("bm");
          // Word internal bookmarks (`_GoBack`) are navigation noise; TOC anchors
          // (`_Toc…`) are kept because PAGEREF/REF resolve against them.
          if (bookmarkName && bookmarkName !== "_GoBack") {
            this.host.bookmarks.push({
              name: bookmarkName,
              id: bookmarkId,
              paragraphId,
            });
            push({
              type: "bookmark",
              name: bookmarkName,
              bookmarkId,
              kind: "start",
            });
          }
          break;
        }
        case "bookmarkEnd": {
          push({
            type: "bookmark",
            name: "",
            bookmarkId: wAttr(child, "id") ?? "",
            kind: "end",
          });
          break;
        }
        case "commentRangeStart": {
          const id = wAttr(child, "id") ?? "";
          if (id)
            push({ type: "commentRef", commentId: id, kind: "rangeStart" });
          break;
        }
        case "commentRangeEnd": {
          const id = wAttr(child, "id") ?? "";
          if (id) push({ type: "commentRef", commentId: id, kind: "rangeEnd" });
          break;
        }
        case "ins":
        case "moveTo": {
          const revision = this.revisionMark(child, "insert");
          this.host.recordFeature("revisions.insert");
          for (const inner of childElements(child)) {
            if (localNameOf(inner) === "r") {
              for (const inline of this.parseRun(
                inner,
                ctx,
                paragraphId,
                location,
                revision,
              ))
                push(inline);
            }
          }
          break;
        }
        case "del":
        case "moveFrom": {
          const revision = this.revisionMark(child, "delete");
          this.host.recordFeature("revisions.delete");
          for (const inner of childElements(child)) {
            if (localNameOf(inner) === "r") {
              for (const inline of this.parseRun(
                inner,
                ctx,
                paragraphId,
                location,
                revision,
              ))
                push(inline);
            }
          }
          break;
        }
        case "sdt": {
          const content = first(child, NS.w, "sdtContent");
          if (content) {
            for (const inline of this.parseInlines(
              childElements(content),
              ctx,
              location,
              paragraphId,
            )) {
              push(inline);
            }
          }
          this.host.recordFeature("inline.contentControl");
          this.host.recordUnknownElement(
            location,
            "w:sdt",
            serializeXml(child),
            "Inline content control content is rendered; control properties are not re-emitted",
          );
          break;
        }
        case "smartTag": {
          for (const inline of this.parseInlines(
            childElements(child),
            ctx,
            location,
            paragraphId,
          )) {
            push(inline);
          }
          break;
        }
        case "oMath": {
          const math = this.parseMath(child);
          push({ type: "math", math: math.nodes, linear: math.linear });
          this.host.recordFeature("math");
          break;
        }
        case "oMathPara": {
          const maths = all(child, NS.m, "oMath");
          for (const mathNode of maths) {
            const math = this.parseMath(mathNode);
            const inline: Inline = {
              type: "math",
              math: math.nodes,
              linear: math.linear,
              display: true,
            };
            push(inline);
          }
          this.host.recordFeature("math");
          break;
        }
        case "proofErr":
        case "permStart":
        case "permEnd":
        case "lastRenderedPageBreak":
          break;
        case "rPr":
        case "pPr":
          break;
        case "subDoc":
          this.recordUnknown(
            ctx,
            location,
            child,
            "Embedded subdocument is preserved, not expanded",
          );
          break;
        default: {
          // Unknown inline-level element: keep it verbatim so nothing is lost.
          if (["sectPr", "customXmlPr"].includes(name)) break;
          this.recordUnknown(
            ctx,
            location,
            child,
            `Unsupported inline element <${name}>`,
          );
          break;
        }
      }
    }

    // Flush unterminated fields (malformed documents).
    while (fieldStack.length > 0) {
      const top = fieldStack.pop();
      if (!top) break;
      out.push({
        type: "field",
        instr: top.instr.trim(),
        simple: false,
        result: top.result,
      });
    }
    return out;
  }

  private recordUnknown(
    ctx: ParseContext,
    location: string,
    child: Element,
    reason: string,
  ): void {
    const name = localNameOf(child);
    this.host.recordFeature(`unknown.${name}`);
    this.host.recordUnknownElement(
      location,
      `w:${name}`,
      serializeXml(child),
      reason,
    );
  }

  private isFieldControlRun(run: Element): boolean {
    return childElements(run).some((node) => {
      const name = localNameOf(node);
      return name === "fldChar" || name === "instrText";
    });
  }

  private hyperlinkTarget(
    element: Element,
    ctx: ParseContext,
  ): { href?: string; anchor?: string; tooltip?: string; external?: boolean } {
    const rid = attr(element, NS.r, "id");
    const anchor = wAttr(element, "anchor");
    const tooltip = wAttr(element, "tooltip");
    if (rid) {
      const rel = ctx.relationships.get(rid);
      if (rel) {
        return { href: rel.target, tooltip, external: rel.mode === "External" };
      }
    }
    if (anchor) return { anchor, tooltip, external: false };
    return { tooltip };
  }

  private withHyperlink(
    inline: Inline,
    target: {
      href?: string;
      anchor?: string;
      tooltip?: string;
      external?: boolean;
    },
  ): Inline {
    if (inline.type === "text") {
      return { ...inline, props: { ...inline.props, hyperlink: target } };
    }
    if (inline.type === "image" || inline.type === "shape") {
      return inline;
    }
    return inline;
  }

  /* ------------------------------------------------------------ runs */

  parseRun(
    run: Element,
    ctx: ParseContext,
    paragraphId: string,
    location: string,
    outerRevision?: RevisionMark,
  ): Inline[] {
    const rPr = first(run, NS.w, "rPr");
    const props = parseRunProps(rPr, ctx);
    if (outerRevision) props.revision = outerRevision;
    const localRevision = this.parseRunRevision(rPr);
    if (localRevision) props.revision = localRevision;

    const out: Inline[] = [];
    const pushText = (text: string) => {
      if (!text) return;
      out.push({ type: "text", text, props: { ...props } });
    };

    for (const node of childElements(run)) {
      const name = localNameOf(node);
      switch (name) {
        case "t":
          pushText(textOf(node));
          break;
        case "delText":
          pushText(textOf(node));
          break;
        case "tab":
          out.push({ type: "tab", props: { ...props } });
          break;
        case "ptab": {
          this.host.recordFeature("tab.absolutePosition");
          out.push({ type: "tab", props: { ...props } });
          break;
        }
        case "br": {
          const type = wAttr(node, "type");
          const kind =
            type === "page" ? "page" : type === "column" ? "column" : "line";
          out.push({ type: "break", kind, props: { ...props } });
          if (kind === "page") this.host.recordFeature("pageBreak");
          if (kind === "column") this.host.recordFeature("columnBreak");
          break;
        }
        case "cr": {
          const text = node.textContent ?? "";
          if (text) pushText(text);
          else out.push({ type: "break", kind: "line", props: { ...props } });
          break;
        }
        case "noBreakHyphen":
          pushText("\u2011");
          break;
        case "softHyphen":
          pushText("\u00AD");
          break;
        case "sym": {
          const char = wAttr(node, "char") ?? "";
          const font = wAttr(node, "font") ?? "";
          const key = char.toUpperCase();
          const mapped = font === "Symbol" ? SYMBOL_MAP[key] : undefined;
          const codePoint = Number.parseInt(char, 16);
          const fallback = Number.isFinite(codePoint)
            ? String.fromCodePoint(codePoint)
            : "";
          pushText(mapped ?? fallback);
          this.host.recordFeature("symbol");
          break;
        }
        case "drawing":
          out.push(
            ...this.parseDrawing(node, ctx, paragraphId, location, props),
          );
          break;
        case "oMath":
        case "oMathPara": {
          const mathNode =
            localNameOf(node) === "oMathPara"
              ? first(node, NS.m, "oMath")
              : node;
          if (mathNode) {
            const math = this.parseMath(mathNode);
            out.push({ type: "math", math: math.nodes, linear: math.linear });
            this.host.recordFeature("math");
          }
          break;
        }
        case "pict":
          out.push(
            ...this.parsePicture(node, ctx, paragraphId, location, props),
          );
          break;
        case "object":
          this.host.recordFeature("ole");
          this.host.recordUnknownElement(
            location,
            "w:object",
            serializeXml(node),
            "Embedded OLE object is preserved as a placeholder",
          );
          out.push({
            type: "unknown",
            element: "w:object",
            raw: serializeXml(node),
            text: "[Embedded object]",
            note: "OLE object preserved; not executed or rendered",
          });
          break;
        case "footnoteReference": {
          const id = wAttr(node, "id");
          if (id)
            out.push({ type: "noteRef", noteId: id, noteType: "footnote" });
          this.host.recordFeature("footnote");
          break;
        }
        case "endnoteReference": {
          const id = wAttr(node, "id");
          if (id)
            out.push({ type: "noteRef", noteId: id, noteType: "endnote" });
          this.host.recordFeature("endnote");
          break;
        }
        case "commentReference": {
          const id = wAttr(node, "id");
          if (id)
            out.push({ type: "commentRef", commentId: id, kind: "point" });
          this.host.recordFeature("comment");
          break;
        }
        case "separator":
        case "continuationSeparator":
        case "footnoteRef":
        case "endnoteRef":
          break;
        case "rPr":
          break;
        case "lastRenderedPageBreak":
          break;
        default:
          this.recordUnknown(
            ctx,
            location,
            node,
            `Unsupported run content <${name}>`,
          );
          out.push({
            type: "unknown",
            element: `w:${name}`,
            raw: serializeXml(node),
            text: textOf(node) || undefined,
            note: `Unsupported run content <${name}> preserved verbatim`,
          });
          break;
      }
    }
    return out;
  }

  private parseRunRevision(rPr: Element | undefined): RevisionMark | undefined {
    if (!rPr) return undefined;
    const del = first(rPr, NS.w, "del");
    if (del) {
      this.host.recordFeature("revisions.delete");
      return this.revisionMark(del, "delete");
    }
    const ins = first(rPr, NS.w, "ins");
    if (ins) {
      this.host.recordFeature("revisions.insert");
      return this.revisionMark(ins, "insert");
    }
    return undefined;
  }

  /* ---------------------------------------------------------- drawings */

  private parseDrawing(
    drawing: Element,
    ctx: ParseContext,
    _paragraphId: string,
    location: string,
    runProps: RunProps,
  ): Inline[] {
    const out: Inline[] = [];
    for (const wrapper of childElements(drawing)) {
      const name = localNameOf(wrapper);
      if (name !== "inline" && name !== "anchor") continue;
      const isAnchor = name === "anchor";
      const extent = first(wrapper, NS.wp, "extent");
      const cx = emuToPt(parseIntOrUndefined(attr(extent, null, "cx")) ?? 0);
      const cy = emuToPt(parseIntOrUndefined(attr(extent, null, "cy")) ?? 0);
      const docPr = first(wrapper, NS.wp, "docPr");
      const alt = docPr
        ? (attr(docPr, null, "descr") ?? wAttr(docPr, "descr"))
        : undefined;
      const title = docPr ? attr(docPr, null, "title") : undefined;
      const anchor = isAnchor
        ? this.parseAnchor(wrapper)
        : { type: "inline" as const };

      const graphic = first(wrapper, NS.a, "graphic");
      const graphicData = first(graphic, NS.a, "graphicData");
      const uri = graphicData ? (attr(graphicData, null, "uri") ?? "") : "";

      if (uri.includes("/picture")) {
        const pict = first(graphicData, NS.pic, "pic");
        const blipFill = first(pict, NS.pic, "blipFill");
        const blip = first(blipFill, NS.a, "blip");
        const rid = blip
          ? (attr(blip, NS.r, "embed") ?? attr(blip, NS.r, "link"))
          : undefined;
        const mediaId = rid ? this.resolveImage(rid, ctx) : undefined;
        const srcRect = first(blipFill, NS.a, "srcRect");
        const crop = srcRect
          ? {
              left:
                (parseIntOrUndefined(attr(srcRect, null, "l")) ?? 0) / 100000,
              top:
                (parseIntOrUndefined(attr(srcRect, null, "t")) ?? 0) / 100000,
              right:
                (parseIntOrUndefined(attr(srcRect, null, "r")) ?? 0) / 100000,
              bottom:
                (parseIntOrUndefined(attr(srcRect, null, "b")) ?? 0) / 100000,
            }
          : undefined;
        const inline: ImageInline = {
          type: "image",
          mediaId: mediaId ?? "",
          width: cx || 200,
          height: cy || 150,
          alt,
          title,
          anchor,
          crop,
          border: this.parseDrawingBorder(pict),
          props: { ...runProps },
        };
        out.push(inline);
        this.host.recordFeature(isAnchor ? "image.floating" : "image.inline");
        void location;
        continue;
      }

      if (uri.includes("/chart")) {
        this.host.recordFeature("chart");
        this.host.recordUnknownElement(
          location,
          "c:chart",
          serializeXml(wrapper),
          "Chart is preserved; rendered as a labelled placeholder",
        );
        out.push({
          type: "unknown",
          element: "a:graphic/chart",
          raw: serializeXml(wrapper),
          text: "[Chart]",
          note: "Chart preserved; not rendered visually",
        });
        continue;
      }

      if (uri.includes("/diagram")) {
        this.host.recordFeature("smartArt");
        this.host.recordUnknownElement(
          location,
          "dgm:relIds",
          serializeXml(wrapper),
          "SmartArt is preserved; rendered as a labelled placeholder",
        );
        out.push({
          type: "unknown",
          element: "a:graphic/diagram",
          raw: serializeXml(wrapper),
          text: "[SmartArt diagram]",
          note: "SmartArt preserved; not rendered visually",
        });
        continue;
      }

      if (uri.includes("/wordprocessingShape")) {
        const shapes = all(graphicData, NS.wps, "wsp");
        for (const wsp of shapes) {
          const parsed = this.parseTextShape(
            wsp,
            ctx,
            anchor,
            cx,
            cy,
            location,
          );
          if (parsed) {
            const shapeId = this.host.registerShape(parsed);
            out.push({ type: "shape", shapeId, props: { ...runProps } });
            this.host.recordFeature("shape.textBox");
          }
        }
        continue;
      }

      if (uri.includes("wordprocessingGroup") || uri.includes("/chartex")) {
        this.host.recordFeature("shape.group");
        this.host.recordUnknownElement(
          location,
          "wpg:wgp",
          serializeXml(wrapper),
          "Drawing group preserved; rendered as placeholder",
        );
        out.push({
          type: "unknown",
          element: "wpg:wgp",
          raw: serializeXml(wrapper),
          text: "[Drawing group]",
          note: "Grouped drawing preserved; not rendered visually",
        });
        continue;
      }

      this.host.recordUnknownElement(
        location,
        "w:drawing",
        serializeXml(wrapper),
        `Unsupported drawing type ${uri}`,
      );
      out.push({
        type: "unknown",
        element: "w:drawing",
        raw: serializeXml(wrapper),
        text: "[Drawing]",
        note: `Unsupported drawing ${uri}`,
      });
    }
    return out;
  }

  private parseDrawingBorder(pict: Element | undefined): ImageInline["border"] {
    const spPr = first(pict, NS.pic, "spPr");
    const ln = first(spPr, NS.a, "ln");
    if (!ln) return null;
    const width = parseIntOrUndefined(attr(ln, null, "w"));
    const solidFill = first(ln, NS.a, "solidFill");
    const srgb = first(solidFill, NS.a, "srgbClr");
    const color = normalizeColor(attr(srgb, null, "val"));
    if (width === undefined && !color) return null;
    return {
      style: "single",
      width: width === undefined ? 0.5 : emuToPt(width),
      color: color ?? "#000000",
    };
  }

  private parseAnchor(wrapper: Element): ImageAnchor {
    const anchor: ImageAnchor = { type: "floating" };
    const behind = boolAttr(attr(wrapper, null, "behindDoc"));
    if (behind !== undefined) anchor.behindText = behind;
    const lockAnchor = boolAttr(attr(wrapper, null, "locked"));
    if (lockAnchor) anchor.lockAnchor = lockAnchor;
    const relativeHeight = parseIntOrUndefined(
      attr(wrapper, null, "relativeHeight"),
    );
    if (relativeHeight !== undefined) anchor.zOrder = relativeHeight;

    const simplePos = first(wrapper, NS.wp, "simplePos");
    if (
      simplePos &&
      boolAttr(attr(wrapper, null, "relativeHeight")) === undefined
    ) {
      const x = parseIntOrUndefined(attr(simplePos, null, "x"));
      const y = parseIntOrUndefined(attr(simplePos, null, "y"));
      if (x !== undefined || y !== undefined) {
        anchor.simplePosition = { x: emuToPt(x ?? 0), y: emuToPt(y ?? 0) };
      }
    }

    const positionH = first(wrapper, NS.wp, "positionH");
    const positionV = first(wrapper, NS.wp, "positionV");
    const horizontal = positionH
      ? this.parseAnchorPosition(positionH)
      : undefined;
    const vertical = positionV
      ? this.parseAnchorPosition(positionV)
      : undefined;
    if (horizontal || vertical) {
      anchor.position = { horizontal, vertical };
    }

    for (const child of childElements(wrapper)) {
      const name = localNameOf(child);
      if (name.startsWith("wrap") && name !== "wrapNone") {
        anchor.wrap = this.parseWrap(child, name);
      } else if (name === "wrapNone") {
        anchor.wrap = { type: "none" };
      }
    }

    const distances = {
      top: emuToPt(parseIntOrUndefined(attr(wrapper, null, "distT")) ?? 0),
      bottom: emuToPt(parseIntOrUndefined(attr(wrapper, null, "distB")) ?? 0),
      left: emuToPt(parseIntOrUndefined(attr(wrapper, null, "distL")) ?? 0),
      right: emuToPt(parseIntOrUndefined(attr(wrapper, null, "distR")) ?? 0),
    };
    if (Object.values(distances).some((value) => value > 0))
      anchor.distances = distances;
    return anchor;
  }

  private parseAnchorPosition(node: Element): AnchorPosition {
    const relativeTo = attr(node, null, "relativeFrom") ?? undefined;
    const offset = first(node, NS.wp, "posOffset");
    if (offset) {
      return {
        offset: emuToPt(parseIntOrUndefined(textOf(offset)) ?? 0),
        relativeTo: relativeTo as AnchorPosition["relativeTo"],
      };
    }
    const align = first(node, NS.wp, "align");
    return {
      align: (align ? textOf(align) : undefined) as AnchorPosition["align"],
      relativeTo: relativeTo as AnchorPosition["relativeTo"],
    };
  }

  private parseWrap(node: Element, name: string): TextWrap {
    const readDist = (attrName: string): number =>
      emuToPt(parseIntOrUndefined(attr(node, null, attrName)) ?? 0);
    const distances = [
      readDist("distL"),
      readDist("distT"),
      readDist("distR"),
      readDist("distB"),
    ];
    const wrapSide = attr(node, null, "wrapText") as
      "both" | "left" | "right" | "largest" | undefined;
    if (name === "wrapSquare") return { type: "square", wrapSide, distances };
    if (name === "wrapTight") return { type: "tight", wrapSide, distances };
    if (name === "wrapThrough") return { type: "through", wrapSide, distances };
    if (name === "wrapTopAndBottom") return { type: "topAndBottom", distances };
    return { type: "square", distances };
  }

  private parseTextShape(
    wsp: Element,
    ctx: ParseContext,
    anchor: ImageAnchor,
    fallbackWidth: number,
    fallbackHeight: number,
    location: string,
  ): ShapeTextBox | undefined {
    const spPr = first(wsp, NS.wps, "spPr");
    const xfrm = first(spPr, NS.a, "xfrm");
    const ext = first(xfrm, NS.a, "ext");
    const width =
      emuToPt(parseIntOrUndefined(attr(ext, null, "cx")) ?? 0) || fallbackWidth;
    const height =
      emuToPt(parseIntOrUndefined(attr(ext, null, "cy")) ?? 0) ||
      fallbackHeight;
    const prstGeom = first(spPr, NS.a, "prstGeom");
    const preset = attr(prstGeom, null, "prst") ?? "rect";
    const solidFill = first(spPr, NS.a, "solidFill");
    const srgb = first(solidFill, NS.a, "srgbClr");
    const fill = normalizeColor(attr(srgb, null, "val"));
    const txbx = first(wsp, NS.wps, "txbx");
    const txbxContent = first(txbx, NS.w, "txbxContent");
    if (!txbxContent) return undefined;
    const blocks = this.parseBlocks(
      childElements(txbxContent),
      ctx.partPath,
      `${location}/textbox`,
    );
    const id = this.host.nextId("shape");
    return {
      id,
      kind: "textbox",
      anchor,
      width,
      height,
      fill,
      line: null,
      blocks,
      preset,
    };
  }

  private parsePicture(
    pict: Element,
    ctx: ParseContext,
    _paragraphId: string,
    location: string,
    runProps: RunProps,
  ): Inline[] {
    const out: Inline[] = [];
    for (const child of childElements(pict)) {
      const name = localNameOf(child);
      if (name === "shape") {
        const imagedata = first(child, NS.v, "imagedata");
        const rid = imagedata ? attr(imagedata, NS.r, "id") : undefined;
        if (rid) {
          const mediaId = this.resolveImage(rid, ctx);
          const style = attr(child, null, "style") ?? "";
          const width = this.parseCssLength(style, "width");
          const height = this.parseCssLength(style, "height");
          out.push({
            type: "image",
            mediaId: mediaId ?? "",
            width: width ?? 200,
            height: height ?? 150,
            anchor: { type: "inline" },
            border: null,
            props: { ...runProps },
          });
          this.host.recordFeature("image.vml");
        }
        const textbox = first(child, NS.v, "textbox");
        const content = first(textbox, NS.w, "txbxContent");
        if (content) {
          const blocks = this.parseBlocks(
            childElements(content),
            ctx.partPath,
            `${location}/vml-textbox`,
          );
          const shapeId = this.host.registerShape({
            id: this.host.nextId("shape"),
            kind: "textbox",
            anchor: { type: "floating" },
            width: 200,
            height: 100,
            blocks,
            preset: "rect",
            line: null,
          });
          out.push({ type: "shape", shapeId, props: { ...runProps } });
          this.host.recordFeature("shape.textBox");
        }
      } else if (name === "rect") {
        this.host.recordFeature("shape.vmlRect");
        this.host.recordUnknownElement(
          location,
          "v:rect",
          serializeXml(child),
          "VML rectangle preserved as placeholder",
        );
        out.push({
          type: "unknown",
          element: "v:rect",
          raw: serializeXml(child),
          text: "[Shape]",
        });
      }
    }
    return out;
  }

  private parseCssLength(style: string, property: string): number | undefined {
    const match = new RegExp(
      `${property}\\s*:\\s*([0-9.]+)(pt|px|in|cm|mm)?`,
    ).exec(style);
    if (!match) return undefined;
    const value = Number(match[1]);
    switch (match[2]) {
      case "px":
        return (value * 72) / 96;
      case "in":
        return value * 72;
      case "cm":
        return (value * 72) / 2.54;
      case "mm":
        return (value * 72) / 25.4;
      default:
        return value;
    }
  }

  private resolveImage(rid: string, ctx: ParseContext): string | undefined {
    const rel = ctx.relationships.get(rid);
    if (!rel || !rel.resolvedPath) {
      this.host.warn(`Image relationship ${rid} has no resolvable target`);
      return undefined;
    }
    const existing = this.host.media.lookup(rel.resolvedPath);
    if (existing) return existing;
    const data = this.host.readPart(rel.resolvedPath);
    if (!data) {
      this.host.warn(`Missing image part ${rel.resolvedPath}`);
      return undefined;
    }
    const contentType = contentTypeForPath(rel.resolvedPath);
    const size = imageSize(data);
    return this.host.media.register({
      path: rel.resolvedPath,
      contentType,
      fileName: rel.resolvedPath.split("/").pop() ?? "image",
      data,
      widthPx: size?.width,
      heightPx: size?.height,
      dpi: 96,
    });
  }

  /* ------------------------------------------------------------- math */

  parseMath(node: Element): { nodes: MathNode[]; linear: string } {
    const nodes = this.parseMathChildren(childElements(node));
    return { nodes, linear: mathLinear(nodes) };
  }

  private parseMathChildren(children: Element[]): MathNode[] {
    const nodes: MathNode[] = [];
    let buffer = "";
    const flush = () => {
      if (buffer) {
        nodes.push({ kind: "run", text: buffer });
        buffer = "";
      }
    };
    for (const child of children) {
      const name = localNameOf(child);
      switch (name) {
        case "r": {
          const text =
            all(child, NS.m, "t")
              .map((t) => textOf(t))
              .join("") || textOf(first(child, NS.m, "t"));
          buffer += text;
          break;
        }
        case "f": {
          flush();
          nodes.push({
            kind: "fraction",
            numerator: this.parseMathChildren(
              childElements(first(child, NS.m, "num")),
            ),
            denominator: this.parseMathChildren(
              childElements(first(child, NS.m, "den")),
            ),
          });
          break;
        }
        case "sSup": {
          flush();
          nodes.push({
            kind: "superscript",
            base: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
            superscript: this.parseMathChildren(
              childElements(first(child, NS.m, "sup")),
            ),
          });
          break;
        }
        case "sSub": {
          flush();
          nodes.push({
            kind: "subscript",
            base: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
            subscript: this.parseMathChildren(
              childElements(first(child, NS.m, "sub")),
            ),
          });
          break;
        }
        case "sSubSup": {
          flush();
          nodes.push({
            kind: "subsup",
            base: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
            sub: this.parseMathChildren(
              childElements(first(child, NS.m, "sub")),
            ),
            sup: this.parseMathChildren(
              childElements(first(child, NS.m, "sup")),
            ),
          });
          break;
        }
        case "rad": {
          flush();
          const radicand = this.parseMathChildren(
            childElements(first(child, NS.m, "e")),
          );
          const degree = this.parseMathChildren(
            childElements(first(child, NS.m, "deg")),
          );
          nodes.push({ kind: "radical", degree, radicand });
          break;
        }
        case "d": {
          flush();
          const dPr = first(child, NS.m, "dPr");
          const begChr = dPr ? wVal(first(dPr, NS.m, "begChr")) : undefined;
          const endChr = dPr ? wVal(first(dPr, NS.m, "endChr")) : undefined;
          const sepChr = dPr ? wVal(first(dPr, NS.m, "sepChr")) : undefined;
          const childrenNodes = all(child, NS.m, "e").flatMap((e) =>
            this.parseMathChildren(childElements(e)),
          );
          nodes.push({
            kind: "delimited",
            begin: begChr ?? undefined,
            end: endChr ?? undefined,
            separator: sepChr ?? undefined,
            children: childrenNodes,
          });
          break;
        }
        case "nary": {
          flush();
          const naryPr = first(child, NS.m, "naryPr");
          const chr = naryPr ? wVal(first(naryPr, NS.m, "chr")) : undefined;
          nodes.push({
            kind: "nary",
            operator: chr ?? "\u2211",
            sub: this.parseMathChildren(
              childElements(first(child, NS.m, "sub")),
            ),
            sup: this.parseMathChildren(
              childElements(first(child, NS.m, "sup")),
            ),
            body: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
          });
          break;
        }
        case "bar": {
          flush();
          const barPr = first(child, NS.m, "barPr");
          const pos = barPr ? wVal(first(barPr, NS.m, "pos")) : undefined;
          nodes.push({
            kind: "bar",
            position: pos === "bot" ? "bottom" : "top",
            body: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
          });
          break;
        }
        case "acc": {
          flush();
          const accPr = first(child, NS.m, "accPr");
          const chr = accPr ? wVal(first(accPr, NS.m, "chr")) : undefined;
          nodes.push({
            kind: "accent",
            char: chr ?? "\u0302",
            body: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
          });
          break;
        }
        case "m": {
          flush();
          const rows = all(child, NS.m, "mr").map((row) =>
            all(row, NS.m, "e").map((cell) =>
              this.parseMathChildren(childElements(cell)),
            ),
          );
          nodes.push({ kind: "matrix", rows });
          break;
        }
        case "func": {
          flush();
          const name = this.parseMathChildren(
            childElements(first(child, NS.m, "fName")),
          );
          nodes.push({
            kind: "function",
            name: name
              .map((entry) => (entry.kind === "run" ? entry.text : ""))
              .join(""),
            argument: this.parseMathChildren(
              childElements(first(child, NS.m, "e")),
            ),
          });
          break;
        }
        case "eqArr": {
          flush();
          nodes.push({
            kind: "group",
            children: all(child, NS.m, "e").flatMap((entry) =>
              this.parseMathChildren(childElements(entry)),
            ),
          });
          break;
        }
        case "oMath":
          nodes.push(...this.parseMathChildren(childElements(child)));
          break;
        default:
          break;
      }
    }
    flush();
    return nodes;
  }

  /* ----------------------------------------------------------- tables */

  parseTable(tbl: Element, ctx: ParseContext, _location: string): Table {
    const parsed = parseTableProperties(tbl);
    const id = this.host.nextId("tbl");
    const table: Table = {
      type: "table",
      id,
      props: parsed.props,
      grid: parsed.grid,
      rows: [],
    };

    for (const tr of all(tbl, NS.w, "tr")) {
      const trPr = first(tr, NS.w, "trPr");
      const rowProps: RowProps = {};
      if (trPr) {
        const height = first(trPr, NS.w, "trHeight");
        if (height) {
          const value = twips(parseIntOrUndefined(wAttr(height, "val")));
          if (value !== undefined) rowProps.height = value;
          const rule = wAttr(height, "hRule");
          if (rule === "exact" || rule === "atLeast" || rule === "auto")
            rowProps.heightRule = rule;
        }
        const header = onOff(first(trPr, NS.w, "tblHeader"));
        if (header !== undefined) rowProps.isHeader = header;
        const cantSplit = onOff(first(trPr, NS.w, "cantSplit"));
        if (cantSplit !== undefined) rowProps.cantSplit = cantSplit;
        const gridBefore = parseIntOrUndefined(
          wVal(first(trPr, NS.w, "gridBefore")),
        );
        if (gridBefore !== undefined) rowProps.gridBefore = gridBefore;
        const gridAfter = parseIntOrUndefined(
          wVal(first(trPr, NS.w, "gridAfter")),
        );
        if (gridAfter !== undefined) rowProps.gridAfter = gridAfter;
        const jc = alignmentFromOoxml(wVal(first(trPr, NS.w, "jc")));
        if (jc) rowProps.alignment = jc;
        const shd = first(trPr, NS.w, "shd");
        const fill = normalizeColor(wAttr(shd, "fill"));
        if (fill) rowProps.shading = { fill };
      }
      if (rowProps.isHeader) this.host.recordFeature("table.headerRow");

      const row: TableRow = {
        id: this.host.nextId("row"),
        props: rowProps,
        cells: [],
      };
      for (const tc of all(tr, NS.w, "tc")) {
        row.cells.push(this.parseCell(tc, ctx));
      }
      table.rows.push(row);
    }

    if (table.props.borders) this.host.recordFeature("table.borders");
    if (
      table.rows.some((row) =>
        row.cells.some(
          (cell) => (cell.props.gridSpan ?? 1) > 1 || cell.props.vMerge,
        ),
      )
    ) {
      this.host.recordFeature("table.mergedCells");
    }
    return table;
  }

  private parseCell(tc: Element, ctx: ParseContext): TableCell {
    const tcPr = first(tc, NS.w, "tcPr");
    const props: TableCell["props"] = {};
    if (tcPr) {
      const tcW = first(tcPr, NS.w, "tcW");
      if (tcW) {
        const type = (wAttr(tcW, "type") ?? "dxa") as "auto" | "dxa" | "pct";
        const value = parseIntOrUndefined(wAttr(tcW, "w"));
        if (value !== undefined) {
          props.width =
            type === "pct"
              ? { value: value / 50, type }
              : { value: twips(value) ?? 0, type };
        }
      }
      const gridSpan = parseIntOrUndefined(wVal(first(tcPr, NS.w, "gridSpan")));
      if (gridSpan !== undefined) props.gridSpan = gridSpan;
      const vMergeNode = first(tcPr, NS.w, "vMerge");
      if (vMergeNode) {
        const value = wVal(vMergeNode);
        props.vMerge = value === "restart" ? "restart" : "continue";
      }
      const vAlign = wVal(first(tcPr, NS.w, "vAlign"));
      if (vAlign === "top" || vAlign === "center" || vAlign === "bottom")
        props.vAlign = vAlign;
      const shd = first(tcPr, NS.w, "shd");
      const fill = normalizeColor(wAttr(shd, "fill"));
      if (fill) props.background = { fill, pattern: wAttr(shd, "val") };
      const tcBorders = first(tcPr, NS.w, "tcBorders");
      if (tcBorders) {
        const borders: NonNullable<TableCell["props"]["borders"]> = {};
        for (const side of ["top", "left", "bottom", "right"] as const) {
          const node = first(tcBorders, NS.w, side);
          if (!node) continue;
          borders[side] = parseBorder(node, (name) => wAttr(node, name));
        }
        if (Object.keys(borders).length > 0) props.borders = borders;
      }
      const margins = parseCellMargins(first(tcPr, NS.w, "tcMar"));
      if (margins) props.margins = margins;
      const textDirection = wVal(first(tcPr, NS.w, "textDirection"));
      if (textDirection)
        props.textDirection = textDirection as NonNullable<
          TableCell["props"]["textDirection"]
        >;
      const fitText = onOff(first(tcPr, NS.w, "tcFitText"));
      if (fitText !== undefined) props.fitText = fitText;
      const noWrap = onOff(first(tcPr, NS.w, "noWrap"));
      if (noWrap !== undefined) props.wrapText = !noWrap;
    }

    const cell: TableCell = {
      id: this.host.nextId("cell"),
      props,
      blocks: [],
    };
    // Cell content: paragraphs and nested tables.
    const inner = childElements(tc).filter((child) =>
      ["p", "tbl", "sdt"].includes(localNameOf(child)),
    );
    cell.blocks = this.parseBlocks(inner, ctx.partPath, `cell:${cell.id}`);
    if (cell.blocks.length === 0) {
      cell.blocks.push({
        type: "paragraph",
        id: this.host.nextId("p"),
        style: "Normal",
        props: {},
        inlines: [],
      });
    }
    return cell;
  }

  /* ------------------------------------------------------- attachments */

  parseNotePart(
    xml: string,
    partPath: string,
    kind: "footnote" | "endnote",
  ): { notes: Note[]; idMap: Map<string, string> } {
    const notes: Note[] = [];
    const idMap = new Map<string, string>();
    const doc = parseXmlSafe(xml);
    if (!doc) return { notes, idMap };
    const root = doc.documentElement;
    const tag = kind === "footnote" ? "footnote" : "endnote";
    for (const noteNode of all(root, NS.w, tag)) {
      const id = wAttr(noteNode, "id");
      if (!id) continue;
      const type = wAttr(noteNode, "type");
      if (
        type === "separator" ||
        type === "continuationSeparator" ||
        type === "continuationNotice"
      )
        continue;
      const localId = this.host.nextId(kind === "footnote" ? "fn" : "en");
      idMap.set(id, localId);
      const blocks = this.parseBlocks(
        childElements(noteNode).filter((child) =>
          ["p", "tbl", "sdt"].includes(localNameOf(child)),
        ),
        partPath,
        `${kind}[${id}]`,
      );
      notes.push({
        id: localId,
        type: kind,
        blocks,
      });
    }
    return { notes, idMap };
  }

  parseCommentsPart(
    xml: string,
    partPath: string,
    extendedXml?: string,
  ): DocComment[] {
    const doc = parseXmlSafe(xml);
    if (!doc) return [];
    const doneParagraphs = new Set<string>();
    if (extendedXml) {
      const extended = parseXmlSafe(extendedXml);
      if (extended) {
        for (const commentEx of all(
          extended.documentElement,
          NS.w15,
          "commentEx",
        )) {
          if (boolAttr(wAttr(commentEx, "done"))) {
            const paraId = wAttr(commentEx, "paraId");
            if (paraId) doneParagraphs.add(paraId);
          }
        }
      }
    }
    const comments: DocComment[] = [];
    for (const node of all(doc.documentElement, NS.w, "comment")) {
      const id = wAttr(node, "id");
      if (!id) continue;
      const paraIdOfComment =
        wAttr(node, "paraId") ?? wAttr(node, "commentId") ?? "";
      const blocks = this.parseBlocks(
        childElements(node).filter((child) =>
          ["p", "tbl", "sdt"].includes(localNameOf(child)),
        ),
        partPath,
        `comment[${id}]`,
      );
      const date = wAttr(node, "date");
      const resolved =
        doneParagraphs.size > 0 &&
        (doneParagraphs.has(paraIdOfComment) || doneParagraphs.has(id));
      comments.push({
        id,
        author: wAttr(node, "author") ?? "Unknown",
        initials: wAttr(node, "initials"),
        date,
        blocks,
        resolved,
      });
    }
    return comments;
  }

  /* --------------------------------------------------------- exports */

  /** Converts an anchor/position pair into a paragraph-independent shape reference. */
  static anchorToShapeAnchor(anchor: ImageAnchor): ImageAnchor {
    return anchor;
  }
}

function contentTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
    webp: "image/webp",
  };
  return map[extension] ?? "application/octet-stream";
}

function parseXmlSafe(xml: string): XmlDocument | undefined {
  try {
    return parseXml(xml, "part");
  } catch {
    return undefined;
  }
}

/** Reads intrinsic pixel dimensions for the common raster formats. */
export function imageSize(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined;
  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }
  // JPEG
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

/** Linear text projection of math nodes (used for fallback rendering and export). */
export function mathLinear(nodes: MathNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "run":
          return node.text;
        case "fraction":
          return `(${mathLinear(node.numerator)})/(${mathLinear(node.denominator)})`;
        case "superscript":
          return `${mathLinear(node.base)}^${mathLinear(node.superscript)}`;
        case "subscript":
          return `${mathLinear(node.base)}_${mathLinear(node.subscript)}`;
        case "subsup":
          return `${mathLinear(node.base)}_${mathLinear(node.sub)}^${mathLinear(node.sup)}`;
        case "radical":
          return node.degree.length
            ? `root(${mathLinear(node.degree)})(${mathLinear(node.radicand)})`
            : `\u221A(${mathLinear(node.radicand)})`;
        case "delimited":
          return `${node.begin ?? "("}${node.children.map((child) => mathLinear([child])).join(node.separator ?? ",")}${node.end ?? ")"}`;
        case "function":
          return `${node.name}(${mathLinear(node.argument)})`;
        case "nary":
          return `${node.operator}${node.sub ? `_(${mathLinear(node.sub)})` : ""}${node.sup ? `^(${mathLinear(node.sup)})` : ""}(${mathLinear(node.body)})`;
        case "bar":
          return `${mathLinear(node.body)}\u0305`;
        case "accent":
          return `${mathLinear(node.body)}${node.char}`;
        case "matrix":
          return node.rows
            .map((row) => row.map((cell) => `[${mathLinear(cell)}]`).join(""))
            .join("; ");
        case "group":
          return node.children.map((child) => mathLinear([child])).join("");
        case "space":
          return " ";
        case "unknown":
          return node.linear;
        default:
          return "";
      }
    })
    .join("");
}

export interface SectionSector {
  element: Element;
  props: ParagraphProps;
}
