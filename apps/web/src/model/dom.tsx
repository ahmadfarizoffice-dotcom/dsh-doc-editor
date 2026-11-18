/**
 * Model → React/DOM projection for the editable surface.
 *
 * Every editable text chunk is rendered as its own `<span>` carrying
 * `data-block` / `data-inline` / `data-offset`; `model/selection.ts` maps DOM
 * ranges to model positions through those attributes. List markers are CSS
 * `::before` generated content, so they never pollute the text mapping.
 */
import type { CSSProperties, ReactNode } from "react";
import {
  documentOutline,
  resolveParagraphProps,
  resolveRunProps,
} from "@dsh-doc/core/model";
import type {
  Block,
  Border,
  DocDocument,
  DocComment,
  Inline,
  MediaAsset,
  Paragraph,
  ParagraphProps,
  RunProps,
  Table,
  TableCell,
  TocBlock,
} from "@dsh-doc/core/model";

export interface CommentInterval {
  commentId: string;
  start: number;
  end: number;
}

export interface MatchInterval {
  start: number;
  end: number;
}

export interface RenderContext {
  document: DocDocument;
  zoom: number;
  listLabels: Map<string, string>;
  media: Map<string, MediaAsset>;
  noteNumbers: Map<string, number>;
  noteBodies: Map<string, string>;
  comments: Map<string, DocComment>;
  commentOrder: Map<string, number>;
  commentRanges: Map<string, CommentInterval[]>;
  searchMatches: Map<string, MatchInterval[]>;
  activeMatch: { blockId: string; start: number; end: number } | null;
  activeCommentId: string | null;
  showFormattingMarks: boolean;
  /** Paragraph id → true when it is the caret block (focus ring / caret hint). */
  focusedBlockId: string | null;
}

export function ptToPx(points: number, zoom = 1): number {
  return ((points * 96) / 72) * zoom;
}

const SAFE_BULLETS: Record<string, string> = {
  "\uF0B7": "\u2022",
  "\uF0A7": "\u25AA",
  "\uF0D8": "\u27A2",
  "\uF0FC": "\u2713",
  "\uF0A8": "\u25CB",
};

export function normalizeBullet(label: string): string {
  return SAFE_BULLETS[label] ?? label;
}

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

/* --------------------------------------------------------------- context */

export function createRenderContext(
  document: DocDocument,
  options: {
    zoom?: number;
    searchMatches?: Array<{ blockId: string; start: number; end: number }>;
    activeMatch?: { blockId: string; start: number; end: number } | null;
    activeCommentId?: string | null;
    showFormattingMarks?: boolean;
    focusedBlockId?: string | null;
    listLabels?: Map<string, string>;
  } = {},
): RenderContext {
  const media = new Map(document.media.map((asset) => [asset.id, asset]));

  const noteNumbers = new Map<string, number>();
  const noteBodies = new Map<string, string>();
  [...document.footnotes, ...document.endnotes].forEach((note, index) => {
    noteNumbers.set(note.id, index + 1);
    const text = note.blocks
      .map((block) =>
        block.type === "paragraph"
          ? block.inlines
              .map((inline) =>
                inline.type === "text"
                  ? inline.text
                  : inline.type === "tab"
                    ? "\t"
                    : "",
              )
              .join("")
          : "",
      )
      .join(" ")
      .trim();
    noteBodies.set(note.id, text);
  });

  const comments = new Map(
    document.comments.map((comment) => [comment.id, comment]),
  );
  const commentOrder = new Map<string, number>();
  let threadIndex = 0;
  for (const comment of document.comments) {
    if (comment.parentId) continue;
    threadIndex += 1;
    commentOrder.set(comment.id, threadIndex);
  }

  const commentRanges = new Map<string, CommentInterval[]>();
  for (const section of document.sections) {
    collectCommentRanges(section.blocks, commentRanges);
    for (const row of section.blocks.flatMap((block) =>
      block.type === "table" ? block.rows : [],
    )) {
      for (const cell of row.cells)
        collectCommentRanges(cell.blocks, commentRanges);
    }
  }

  const searchMatches = new Map<string, MatchInterval[]>();
  for (const match of options.searchMatches ?? []) {
    const list = searchMatches.get(match.blockId) ?? [];
    list.push({ start: match.start, end: match.end });
    searchMatches.set(match.blockId, list);
  }

  return {
    document,
    zoom: options.zoom ?? 1,
    listLabels: options.listLabels ?? new Map(),
    media,
    noteNumbers,
    noteBodies,
    comments,
    commentOrder,
    commentRanges:
      commentRanges.size > 0 || document.comments.length > 0
        ? commentRanges
        : new Map(),
    searchMatches,
    activeMatch: options.activeMatch ?? null,
    activeCommentId: options.activeCommentId ?? null,
    showFormattingMarks: options.showFormattingMarks ?? false,
    focusedBlockId: options.focusedBlockId ?? null,
  };
}

function collectCommentRanges(
  blocks: Block[],
  out: Map<string, CommentInterval[]>,
): void {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const open = new Map<string, number>();
      let offset = 0;
      for (const inline of block.inlines) {
        if (inline.type === "commentRef") {
          if (inline.kind === "point") {
            const list = out.get(block.id) ?? [];
            list.push({
              commentId: inline.commentId,
              start: offset,
              end: offset,
            });
            out.set(block.id, list);
          } else if (inline.kind === "rangeStart") {
            open.set(inline.commentId, offset);
          } else if (inline.kind === "rangeEnd") {
            const start = open.get(inline.commentId) ?? offset;
            const list = out.get(block.id) ?? [];
            list.push({ commentId: inline.commentId, start, end: offset });
            out.set(block.id, list);
            open.delete(inline.commentId);
          }
          continue;
        }
        offset += inlineLength(inline);
      }
      continue;
    }
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) collectCommentRanges(cell.blocks, out);
      }
    }
  }
}

function inlineLength(inline: Inline): number {
  switch (inline.type) {
    case "text":
      return inline.text.length;
    case "tab":
    case "break":
    case "image":
      return 1;
    case "field":
      return inline.result
        ? inline.result.reduce((sum, child) => sum + inlineLength(child), 0)
        : 0;
    case "math":
      return inline.linear.length;
    case "unknown":
      return (inline.text ?? "").length;
    default:
      return 0;
  }
}

/* ---------------------------------------------------------------- styles */

function underlineCss(value: RunProps["underline"]): string | undefined {
  if (!value || value === "none") return undefined;
  if (value === "double") return "underline double";
  if (value === "dotted") return "underline dotted";
  if (value === "dash") return "underline dashed";
  if (value === "wave") return "underline wavy";
  if (value === "thick") return "underline solid";
  return "underline";
}

export function runStyle(props: RunProps, ctx: RenderContext): CSSProperties {
  const style: CSSProperties = {};
  if (props.fontFamily) style.fontFamily = props.fontFamily;
  if (props.fontSize) style.fontSize = `${ptToPx(props.fontSize, ctx.zoom)}px`;
  if (props.bold) style.fontWeight = 700;
  if (props.italic) style.fontStyle = "italic";
  const decorations: string[] = [];
  const underline = underlineCss(props.underline);
  if (underline) decorations.push(underline);
  if (props.strike) decorations.push("line-through");
  if (props.doubleStrike) decorations.push("line-through double");
  if (props.outline) decorations.push("underline");
  if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  if (props.color) style.color = props.color;
  const background = props.highlight ?? props.background;
  if (background) style.backgroundColor = normalizeColor(background);
  if (props.vertAlign === "superscript") {
    style.verticalAlign = "super";
    style.fontSize = `${ptToPx((props.fontSize ?? 11) * 0.68, ctx.zoom)}px`;
  } else if (props.vertAlign === "subscript") {
    style.verticalAlign = "sub";
    style.fontSize = `${ptToPx((props.fontSize ?? 11) * 0.68, ctx.zoom)}px`;
  }
  if (props.charSpacing)
    style.letterSpacing = `${ptToPx(props.charSpacing, ctx.zoom)}px`;
  if (props.caps) style.textTransform = "uppercase";
  if (props.smallCaps) style.fontVariantCaps = "small-caps";
  if (props.hidden || props.webHidden) style.display = "none";
  if (props.rtl) style.direction = "rtl";
  return style;
}

function normalizeColor(value: string): string {
  if (value.startsWith("#")) return value;
  const tokens = value.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? value;
  return last;
}

function borderCss(border: Border | null | undefined): string | undefined {
  if (!border || border.none || border.style === "none") return undefined;
  const width = Math.max(0.5, border.width || 0.5);
  const styles: Record<string, string> = {
    double: "double",
    dotted: "dotted",
    dashed: "dashed",
    dotDash: "dashed",
    dotDotDash: "dotted",
    wave: "solid",
    doubleWave: "double",
    threeDEmboss: "ridge",
    threeDEngrave: "groove",
    outset: "outset",
    inset: "inset",
  };
  return `${Math.round(width * 20) / 20}pt ${styles[border.style] ?? "solid"} ${border.color ?? "#000000"}`;
}

export function paragraphStyle(
  paragraph: Paragraph,
  props: ParagraphProps,
  ctx: RenderContext,
): CSSProperties {
  const style: CSSProperties = {};
  if (props.alignment)
    style.textAlign =
      props.alignment === "distribute" ? "justify" : props.alignment;
  if (props.lineSpacing) {
    if (props.lineSpacing.rule === "auto") {
      const multiple = props.lineSpacing.value / 240;
      style.lineHeight = String(Math.max(0.8, multiple));
    } else {
      style.lineHeight = `${ptToPx(props.lineSpacing.value, ctx.zoom)}px`;
    }
  }
  if (props.spaceBefore !== undefined)
    style.marginTop = `${ptToPx(props.spaceBefore, ctx.zoom)}px`;
  if (props.spaceAfter !== undefined)
    style.marginBottom = `${ptToPx(props.spaceAfter, ctx.zoom)}px`;
  const indent = props.indent ?? {};
  if (indent.left !== undefined)
    style.marginLeft = `${ptToPx(indent.left, ctx.zoom)}px`;
  if (indent.right !== undefined)
    style.marginRight = `${ptToPx(indent.right, ctx.zoom)}px`;
  if (indent.firstLine !== undefined && indent.firstLine !== 0) {
    style.textIndent = `${ptToPx(indent.firstLine, ctx.zoom)}px`;
  } else if (indent.hanging !== undefined && indent.hanging !== 0) {
    style.textIndent = `${-ptToPx(indent.hanging, ctx.zoom)}px`;
  } else if (props.numbering && !indent.left) {
    // List items get a hanging indent for the ::before marker.
    style.paddingLeft = `${ptToPx(36, ctx.zoom)}px`;
    style.textIndent = `${-ptToPx(18, ctx.zoom)}px`;
  }
  if (props.shading?.fill) style.backgroundColor = props.shading.fill;
  if (props.borders) {
    const { top, bottom, left, right } = props.borders;
    const topCss = borderCss(top);
    const bottomCss = borderCss(bottom);
    const leftCss = borderCss(left);
    const rightCss = borderCss(right);
    if (topCss) style.borderTop = topCss;
    if (bottomCss) style.borderBottom = bottomCss;
    if (leftCss) style.borderLeft = leftCss;
    if (rightCss) style.borderRight = rightCss;
    if (topCss || bottomCss || leftCss || rightCss)
      style.padding = `2pt ${ptToPx(4, ctx.zoom)}px`;
  }
  if (props.bidi) style.direction = "rtl";
  if (paragraph.props.numbering && !ctx.listLabels.has(paragraph.id)) {
    // List levels without a computed label (broken numbering definitions) should
    // still indent like a list item rather than collapse to body text.
    style.paddingLeft = `${ptToPx(36, ctx.zoom)}px`;
  }
  return style;
}

/* --------------------------------------------------------------- inlines */

interface Overlay {
  start: number;
  end: number;
  comment?: string;
  match?: boolean;
  active?: boolean;
}

function overlaysFor(paragraph: Paragraph, ctx: RenderContext): Overlay[] {
  const overlays: Overlay[] = [];
  for (const range of ctx.commentRanges.get(paragraph.id) ?? []) {
    overlays.push({
      start: range.start,
      end: Math.max(range.end, range.start + 1),
      comment: range.commentId,
    });
  }
  for (const match of ctx.searchMatches.get(paragraph.id) ?? []) {
    overlays.push({
      start: match.start,
      end: Math.max(match.end, match.start + 1),
      match: true,
    });
  }
  const active = ctx.activeMatch;
  if (active && active.blockId === paragraph.id) {
    overlays.push({
      start: active.start,
      end: Math.max(active.end, active.start + 1),
      match: true,
      active: true,
    });
  }
  return overlays;
}

function renderTextRun(
  paragraph: Paragraph,
  run: Extract<Inline, { type: "text" }>,
  inlineIndex: number,
  runStart: number,
  overlays: Overlay[],
  ctx: RenderContext,
  keyPrefix: string,
): ReactNode[] {
  const resolved = resolveRunProps(ctx.document, {
    paragraphStyle: paragraph.style,
    characterStyle: run.props.characterStyle,
    direct: run.props,
  });
  const style = runStyle(resolved, ctx);
  const runEnd = runStart + run.text.length;

  const boundaries = new Set<number>([runStart, runEnd]);
  for (const overlay of overlays) {
    if (overlay.start > runStart && overlay.start < runEnd)
      boundaries.add(overlay.start);
    if (overlay.end > runStart && overlay.end < runEnd)
      boundaries.add(overlay.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const nodes: ReactNode[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (to <= from) continue;
    const active = overlays.filter(
      (overlay) => overlay.start < to && overlay.end > from,
    );
    const commentIds = active
      .map((overlay) => overlay.comment)
      .filter(Boolean) as string[];
    const isMatch = active.some((overlay) => overlay.match);
    const isActiveMatch = active.some((overlay) => overlay.active);
    const isActiveComment = commentIds.some((id) => id === ctx.activeCommentId);

    const className = classNames(
      "doc-run",
      commentIds.length > 0 && "doc-comment-range",
      isActiveComment && "doc-comment-range-active",
      isMatch && "doc-find-match",
      isActiveMatch && "doc-find-match-active",
    );

    const span = (
      <span
        key={`${keyPrefix}-t${index}`}
        className={className}
        style={style}
        data-block={paragraph.id}
        data-inline={inlineIndex}
        data-offset={from - runStart}
        data-comment-ids={
          commentIds.length > 0 ? commentIds.join(" ") : undefined
        }
      >
        {run.text.slice(from - runStart, to - runStart)}
      </span>
    );

    const revision = run.props.revision;
    if (revision?.kind === "insert") {
      nodes.push(
        <ins
          key={`${keyPrefix}-ins${index}`}
          className="doc-tracked doc-tracked-insert"
          title={revisionTitle(revision)}
        >
          {span}
        </ins>,
      );
    } else if (revision?.kind === "delete") {
      nodes.push(
        <del
          key={`${keyPrefix}-del${index}`}
          className="doc-tracked doc-tracked-delete"
          title={revisionTitle(revision)}
        >
          {span}
        </del>,
      );
    } else {
      nodes.push(span);
    }
  }

  return nodes;
}

function revisionTitle(revision: NonNullable<RunProps["revision"]>): string {
  const author = revision.author ?? "Unknown author";
  const when = revision.date
    ? new Date(revision.date).toLocaleString()
    : "unknown time";
  return `${revision.kind === "insert" ? "Inserted" : revision.kind === "delete" ? "Deleted" : "Formatted"} by ${author} · ${when}`;
}

function markerAttributes(paragraph: Paragraph, inlineIndex: number) {
  return {
    "data-block": paragraph.id,
    "data-inline": inlineIndex,
    "data-offset": 0,
  } as const;
}

function renderMarker(
  paragraph: Paragraph,
  inline: Inline,
  inlineIndex: number,
  ctx: RenderContext,
  key: string,
): ReactNode {
  const attributes = markerAttributes(paragraph, inlineIndex);
  switch (inline.type) {
    case "tab":
      return (
        <span
          key={key}
          className="doc-tab"
          {...attributes}
          contentEditable={false}
          aria-label="Tab"
        >
          <span className="doc-tab-glyph" aria-hidden="true">
            {ctx.showFormattingMarks ? "\u2192" : ""}
          </span>
        </span>
      );
    case "break":
      if (inline.kind === "page") {
        return (
          <span
            key={key}
            className="doc-page-break"
            role="separator"
            aria-label="Page break"
            {...attributes}
          >
            <span className="doc-page-break-line" />
            <span className="doc-page-break-label">Page break</span>
          </span>
        );
      }
      if (inline.kind === "column") {
        return (
          <span
            key={key}
            className="doc-column-break"
            role="separator"
            aria-label="Column break"
            {...attributes}
          >
            <span className="doc-column-break-line" />
          </span>
        );
      }
      return (
        <span
          key={key}
          className="doc-line-break"
          {...attributes}
          contentEditable={false}
        >
          <br />
        </span>
      );
    case "image": {
      const asset = ctx.media.get(inline.mediaId);
      const size = {
        width: `${ptToPx(inline.width, ctx.zoom)}px`,
        height: `${ptToPx(inline.height, ctx.zoom)}px`,
      };
      return (
        <span
          key={key}
          className="doc-image"
          {...attributes}
          contentEditable={false}
        >
          {asset ? (
            <img
              src={`data:${asset.contentType};base64,${asset.data}`}
              alt={inline.alt ?? asset.fileName}
              title={inline.title ?? asset.fileName}
              style={size}
              draggable={false}
            />
          ) : (
            <span
              className="doc-image-missing"
              style={size}
              title={`Missing media: ${inline.mediaId}`}
            >
              Missing image
            </span>
          )}
        </span>
      );
    }
    case "noteRef": {
      const number = ctx.noteNumbers.get(inline.noteId);
      const body = ctx.noteBodies.get(inline.noteId) ?? "";
      return (
        <sup
          key={key}
          className="doc-note-ref"
          title={body || `${inline.noteType} ${number ?? ""}`}
          {...attributes}
          contentEditable={false}
        >
          {number ?? "?"}
        </sup>
      );
    }
    case "commentRef": {
      const order = ctx.commentOrder.get(inline.commentId);
      const comment = ctx.comments.get(inline.commentId);
      if (inline.kind === "rangeStart" || inline.kind === "point") {
        return (
          <span
            key={key}
            className="doc-comment-anchor"
            data-comment-id={inline.commentId}
            title={
              comment ? `Comment ${order ?? ""}: ${comment.author}` : "Comment"
            }
            {...attributes}
            contentEditable={false}
          >
            {order ?? ""}
          </span>
        );
      }
      return (
        <span
          key={key}
          className="doc-comment-end"
          {...attributes}
          contentEditable={false}
        />
      );
    }
    case "bookmark":
      return (
        <span
          key={key}
          className="doc-bookmark"
          data-bookmark={inline.name}
          data-bookmark-kind={inline.kind}
          {...attributes}
          contentEditable={false}
        />
      );
    case "math":
      return (
        <span
          key={key}
          className="doc-math"
          title={inline.linear}
          {...attributes}
          contentEditable={false}
        >
          {inline.linear}
        </span>
      );
    case "field": {
      const text = inline.result
        ? inline.result
            .map((child) =>
              child.type === "text"
                ? child.text
                : child.type === "tab"
                  ? "\t"
                  : "",
            )
            .join("")
        : `[${inline.instr}]`;
      return (
        <span
          key={key}
          className="doc-field"
          title={inline.instr}
          {...attributes}
          contentEditable={false}
        >
          {text}
        </span>
      );
    }
    case "shape":
      return (
        <span
          key={key}
          className="doc-shape"
          title={`Shape ${inline.shapeId}`}
          {...attributes}
          contentEditable={false}
        >
          Shape
        </span>
      );
    case "unknown":
      return (
        <span
          key={key}
          className="doc-unknown"
          title={`Unknown element preserved: ${inline.element}`}
          {...attributes}
          contentEditable={false}
        >
          {inline.text ?? inline.element}
        </span>
      );
    default:
      return null;
  }
}

export function renderInlines(
  paragraph: Paragraph,
  ctx: RenderContext,
): ReactNode[] {
  const overlays = overlaysFor(paragraph, ctx);
  const nodes: ReactNode[] = [];
  let offset = 0;
  paragraph.inlines.forEach((inline, index) => {
    if (inline.type === "text") {
      nodes.push(
        ...renderTextRun(
          paragraph,
          inline,
          index,
          offset,
          overlays,
          ctx,
          `${paragraph.id}-i${index}`,
        ),
      );
    } else {
      nodes.push(
        renderMarker(
          paragraph,
          inline,
          index,
          ctx,
          `${paragraph.id}-m${index}`,
        ),
      );
    }
    offset += inlineLength(inline);
  });
  return nodes;
}

/* ------------------------------------------------------------ paragraphs */

export function renderParagraph(
  paragraph: Paragraph,
  ctx: RenderContext,
): ReactNode {
  const props = resolveParagraphProps(ctx.document, paragraph);
  const style = paragraphStyle(paragraph, props, ctx);
  const label = ctx.listLabels.get(paragraph.id);
  const isFocused = ctx.focusedBlockId === paragraph.id;

  const customProperties: Record<string, string> = {};
  if (label !== undefined) {
    customProperties["--doc-list-label"] = JSON.stringify(
      normalizeBullet(label),
    );
  }
  const inlineStyle = {
    ...style,
    ...customProperties,
  } as unknown as CSSProperties;

  return (
    <p
      key={paragraph.id}
      id={`block-${paragraph.id}`}
      data-block={paragraph.id}
      data-inline-count={paragraph.inlines.length}
      data-style={paragraph.style}
      className={classNames(
        "doc-paragraph",
        label !== undefined && "doc-list-item",
        props.outlineLevel !== undefined &&
          `doc-outline-${props.outlineLevel + 1}`,
        isFocused && "doc-block-focused",
        paragraph.revision && "doc-block-revised",
      )}
      style={inlineStyle}
      dir={props.bidi ? "rtl" : undefined}
      aria-level={
        props.outlineLevel !== undefined ? props.outlineLevel + 1 : undefined
      }
      title={paragraph.revision ? revisionTitle(paragraph.revision) : undefined}
    >
      {paragraph.inlines.length === 0 ? <br /> : null}
      {renderInlines(paragraph, ctx)}
    </p>
  );
}

/* ---------------------------------------------------------------- tables */

function rowSpanFor(table: Table, rowIndex: number, cellIndex: number): number {
  const cell = table.rows[rowIndex]?.cells[cellIndex];
  if (!cell || cell.props.vMerge !== "restart") return 1;
  let span = 1;
  for (let index = rowIndex + 1; index < table.rows.length; index += 1) {
    const next = table.rows[index]?.cells[cellIndex];
    if (next?.props.vMerge === "continue") span += 1;
    else break;
  }
  return span;
}

function tableBorders(table: Table): CSSProperties {
  const style: CSSProperties = {};
  const borders = table.props.borders;
  if (!borders) return style;
  const top = borderCss(borders.top);
  const bottom = borderCss(borders.bottom);
  const left = borderCss(borders.left);
  const right = borderCss(borders.right);
  if (top) style.borderTop = top;
  if (bottom) style.borderBottom = bottom;
  if (left) style.borderLeft = left;
  if (right) style.borderRight = right;
  if (borders.between) {
    style.borderCollapse = "collapse";
  }
  if (!top && !bottom && !left && !right) style.borderCollapse = "collapse";
  return style;
}

function renderCell(
  cell: TableCell,
  table: Table,
  rowIndex: number,
  cellIndex: number,
  ctx: RenderContext,
): ReactNode {
  const props = cell.props;
  const style: CSSProperties = {};
  if (props.width?.value)
    style.width = `${ptToPx(props.width.value, ctx.zoom)}px`;
  if (props.background?.fill) style.backgroundColor = props.background.fill;
  if (props.vAlign) style.verticalAlign = props.vAlign;
  const borders = props.borders;
  if (borders) {
    const top = borderCss(borders.top);
    const bottom = borderCss(borders.bottom);
    const left = borderCss(borders.left);
    const right = borderCss(borders.right);
    if (top) style.borderTop = top;
    if (bottom) style.borderBottom = bottom;
    if (left) style.borderLeft = left;
    if (right) style.borderRight = right;
  }
  const margins = props.margins ?? table.props.cellMargins;
  style.padding = `${ptToPx(margins?.top ?? 1, ctx.zoom)}px ${ptToPx(margins?.right ?? 5.4, ctx.zoom)}px ${ptToPx(
    margins?.bottom ?? 1,
    ctx.zoom,
  )}px ${ptToPx(margins?.left ?? 5.4, ctx.zoom)}px`;

  const rowSpan = rowSpanFor(table, rowIndex, cellIndex);
  if (rowSpan > 1) style.verticalAlign = "top";

  return (
    <td
      key={cell.id}
      data-cell={cell.id}
      colSpan={
        props.gridSpan && props.gridSpan > 1 ? props.gridSpan : undefined
      }
      rowSpan={rowSpan > 1 ? rowSpan : undefined}
      style={style}
    >
      {cell.blocks.length === 0 ? (
        <div className="doc-cell-empty" aria-hidden="true" />
      ) : null}
      {cell.blocks.map((block) => renderBlock(block, ctx))}
    </td>
  );
}

export function renderTable(table: Table, ctx: RenderContext): ReactNode {
  const style: CSSProperties = { ...tableBorders(table) };
  if (table.props.width?.value)
    style.width = `${ptToPx(table.props.width.value, ctx.zoom)}px`;
  if (table.props.layout === "fixed") style.tableLayout = "fixed";
  if (table.props.alignment)
    style.marginLeft = table.props.alignment === "center" ? "auto" : undefined;
  if (table.props.alignment)
    style.marginRight = table.props.alignment === "center" ? "auto" : undefined;

  return (
    <div key={table.id} className="doc-table-wrapper" data-block={table.id}>
      <table className="doc-table" style={style}>
        {table.grid.length > 0 ? (
          <colgroup>
            {table.grid.map((width, index) => (
              <col
                key={`col-${index}`}
                style={{ width: `${ptToPx(width, ctx.zoom)}px` }}
              />
            ))}
          </colgroup>
        ) : null}
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr
              key={row.id}
              style={{
                height: row.props.height
                  ? `${ptToPx(row.props.height, ctx.zoom)}px`
                  : undefined,
              }}
            >
              {row.cells.map((cell, cellIndex) =>
                renderCell(cell, table, rowIndex, cellIndex, ctx),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------- TOC */

export function renderToc(toc: TocBlock, ctx: RenderContext): ReactNode {
  const entries = documentOutline(ctx.document).filter((entry) => {
    if (entry.level < toc.minLevel || entry.level > toc.maxLevel) return false;
    if (entry.level === 0 && toc.includeTitle === false) return false;
    return true;
  });

  return (
    <div
      key={toc.id}
      className="doc-toc"
      data-block={toc.id}
      contentEditable={false}
    >
      <div className="doc-toc-caption">
        {toc.caption ?? "Table of Contents"}
      </div>
      {entries.length === 0 ? (
        <div className="doc-toc-empty">
          No headings match levels {toc.minLevel}–{toc.maxLevel}. Apply Heading
          styles to build the contents list.
        </div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            className="doc-toc-entry"
            data-level={entry.level}
            data-toc-target={entry.blockId}
            role="link"
            tabIndex={0}
            title={`Go to “${entry.text}”`}
          >
            <span className="doc-toc-text">{entry.text}</span>
            {toc.tabLeader !== "none" ? (
              <span className="doc-toc-leader" aria-hidden="true" />
            ) : null}
          </div>
        ))
      )}
      <div className="doc-toc-note">
        {toc.pageNumbers
          ? "Page numbers are resolved by the layout renderer on export and in print preview."
          : "Page numbers are disabled for this table of contents."}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- blocks */

export function renderBlock(block: Block, ctx: RenderContext): ReactNode {
  if (block.type === "paragraph") return renderParagraph(block, ctx);
  if (block.type === "table") return renderTable(block, ctx);
  return renderToc(block, ctx);
}

/** Plain text of a comment (its paragraphs joined by newlines). */
export function commentText(comment: DocComment): string {
  return comment.blocks
    .map((block) =>
      block.type === "paragraph"
        ? block.inlines
            .map((inline) => (inline.type === "text" ? inline.text : ""))
            .join("")
        : "",
    )
    .join("\n");
}
