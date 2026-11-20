/**
 * HTML adapter.
 *
 * Import is deliberately tolerant: well-formed/XHTML-ish input goes through
 * `@xmldom/xmldom` in `text/html` mode (it decodes named entities and recovers
 * from a few HTML shortcuts), and anything that still fails the XML grammar
 * (unclosed `<li>`/`<td>`, mis-nested tables) falls back to a small HTML
 * scanner that applies the void-element and implicit-close rules browsers use.
 * Both paths produce the same intermediate `HtmlNode` tree, so the conversion
 * logic is shared.
 *
 * Export produces self-contained semantic HTML: styles are resolved into a
 * `<style>` sheet, images become `data:` URIs, hyperlinks stay real links,
 * comments/footnotes/revisions get explicit, round-trippable markers, and
 * anything the HTML cannot express is reported as a loss.
 */
import { DOMParser } from "@xmldom/xmldom";
import type { Document, Node } from "@xmldom/xmldom";
import { createListDefinition } from "../model/edit.js";
import { headingLevelOfStyle, resolveRunProps } from "../model/styles.js";
import { pxToPt } from "../model/types.js";
import type {
  Block,
  Border,
  DocComment,
  DocDocument,
  FeatureSupport,
  ImageInline,
  Inline,
  Note,
  Paragraph,
  ParagraphProps,
  RevisionMark,
  RunProps,
  Table,
  TableCell,
  TableRow,
  TocBlock,
} from "../model/types.js";
import {
  addImageInline,
  buildCompatibilityReport,
  buildTable,
  contentWidthPt,
  createDocumentContext,
  cssLengthToPt,
  decodeDataUri,
  ensureCodeStyle,
  ensureQuoteStyle,
  importResult,
  LossCollector,
  makeParagraph,
  mergeRun,
  normalizeCssColor,
  parseCssDeclarations,
  pushText,
  type CssDeclarations,
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

/* --------------------------------------------------------------- parsing */

/** Minimal HTML tree used by the converter. */
export interface HtmlNode {
  kind: "element" | "text";
  /** Lower-case tag name for elements. */
  name?: string;
  attrs?: Record<string, string>;
  children?: HtmlNode[];
  /** Decoded text for text nodes. */
  text?: string;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const BLOCK_NAMES = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Opening tags that implicitly close an element already on the stack. */
const IMPLICIT_CLOSE: Record<string, string[]> = {
  p: ["p"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["td", "th", "tr"],
  thead: ["td", "th", "tr", "thead", "tbody", "tfoot"],
  tbody: ["td", "th", "tr", "thead", "tbody", "tfoot"],
  tfoot: ["td", "th", "tr", "thead", "tbody", "tfoot"],
  option: ["option"],
  optgroup: ["option", "optgroup"],
  a: ["a"],
  h1: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
  h2: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
  h3: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
  h4: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
  h5: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
  h6: ["h1", "h2", "h3", "h4", "h5", "h6", "p"],
  div: ["p"],
  section: ["p"],
  article: ["p"],
  header: ["p"],
  footer: ["p"],
  main: ["p"],
  nav: ["p"],
  aside: ["p"],
  blockquote: ["p"],
  pre: ["p"],
  table: ["p"],
  ul: ["p"],
  ol: ["p"],
};

const ENTITIES: Record<string, string> = {
  nbsp: "\u00A0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwj: "\u200D",
  zwnj: "\u200C",
  shy: "\u00AD",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  minus: "\u2212",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  laquo: "\u00AB",
  raquo: "\u00BB",
  bull: "\u2022",
  middot: "\u00B7",
  dagger: "\u2020",
  Dagger: "\u2021",
  sect: "\u00A7",
  para: "\u00B6",
  deg: "\u00B0",
  plusmn: "\u00B1",
  times: "\u00D7",
  divide: "\u00F7",
  frac12: "\u00BD",
  frac14: "\u00BC",
  frac34: "\u00BE",
  permil: "\u2030",
  prime: "\u2032",
  Prime: "\u2033",
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  cent: "\u00A2",
  curren: "\u00A4",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  harr: "\u2194",
  ne: "\u2260",
  le: "\u2264",
  ge: "\u2265",
  asymp: "\u2248",
  infin: "\u221E",
  sum: "\u2211",
  prod: "\u220F",
  radic: "\u221A",
  lowast: "\u2217",
  micro: "\u00B5",
  aacute: "\u00E1",
  eacute: "\u00E9",
  iacute: "\u00ED",
  oacute: "\u00F3",
  uacute: "\u00FA",
  agrave: "\u00E0",
  egrave: "\u00E8",
  ograve: "\u00F2",
  auml: "\u00E4",
  ouml: "\u00F6",
  uuml: "\u00FC",
  szlig: "\u00DF",
  ccedil: "\u00E7",
  ntilde: "\u00F1",
  aelig: "\u00E6",
  oslash: "\u00F8",
  aring: "\u00E5",
};

/** Decodes numeric and common named HTML entities, leaving unknown ones intact. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#[xX]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const value = Number.parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10,
        );
        if (!Number.isFinite(value) || value < 0 || value > 0x10ffff)
          return match;
        try {
          return String.fromCodePoint(value);
        } catch {
          return match;
        }
      }
      const named = ENTITIES[body];
      return named !== undefined ? named : match;
    },
  );
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r\f ]+/g, " ");
}

/**
 * Serializes a text run without letting HTML whitespace collapsing change it:
 * tabs, newlines and multi/leading/trailing spaces become marker spans the
 * importer turns back into the exact characters.
 */
function inlineTextHtml(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\t") {
      out += '<span data-dsh-tab="1">\t</span>';
      index += 1;
      continue;
    }
    if (char === "\n") {
      out += '<span data-dsh-newline="1"></span>';
      index += 1;
      continue;
    }
    if (char === " ") {
      let end = index;
      while (text[end] === " ") end += 1;
      const run = end - index;
      if (run === 1 && index > 0 && end < text.length) out += " ";
      else
        out += `<span data-dsh-space="${run}">${"\u00A0".repeat(run)}</span>`;
      index = end;
      continue;
    }
    let end = index;
    while (
      end < text.length &&
      text[end] !== "\t" &&
      text[end] !== "\n" &&
      text[end] !== " "
    ) {
      end += 1;
    }
    out += escapeHtml(text.slice(index, end));
    index = end;
  }
  return out;
}

function fromDomNode(node: Node): HtmlNode | undefined {
  if (node.nodeType === 3) return { kind: "text", text: node.nodeValue ?? "" };
  if (node.nodeType !== 1) return undefined;
  const element = node as import("@xmldom/xmldom").Element;
  const attrs: Record<string, string> = {};
  const attributeNodes = element.attributes;
  for (let index = 0; index < attributeNodes.length; index += 1) {
    const attribute = attributeNodes.item(index);
    if (!attribute) continue;
    attrs[attribute.nodeName.toLowerCase()] = attribute.nodeValue ?? "";
  }
  const children: HtmlNode[] = [];
  const childNodes = element.childNodes;
  for (let index = 0; index < childNodes.length; index += 1) {
    const child = fromDomNode(childNodes.item(index) as Node);
    if (child) children.push(child);
  }
  return {
    kind: "element",
    name: (element.localName ?? element.nodeName).toLowerCase(),
    attrs,
    children,
  };
}

/** Parses with xmldom's HTML mode; throws when the input is not XML-shaped. */
function parseWithDom(source: string): HtmlNode | undefined {
  const doc: Document = new DOMParser({
    onError: () => undefined,
  }).parseFromString(source, "text/html");
  const root = doc.documentElement;
  if (!root) return undefined;
  const converted = fromDomNode(root as unknown as Node);
  if (!converted) return undefined;
  return {
    kind: "element",
    name: "#document",
    attrs: {},
    children: [converted],
  };
}

/**
 * Tolerant HTML scanner: applies void elements and browser-style implicit
 * closing so unclosed `<p>`, `<li>` and `<td>` produce siblings, not nesting.
 */
export function parseHtmlTolerant(source: string): HtmlNode {
  const root: HtmlNode = {
    kind: "element",
    name: "#document",
    attrs: {},
    children: [],
  };
  const stack: HtmlNode[] = [root];
  let index = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const top = stack[stack.length - 1];
    top.children?.push({ kind: "text", text: decodeHtmlEntities(text) });
  };

  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next < 0) {
      pushText(source.slice(index));
      break;
    }
    if (next > index) pushText(source.slice(index, next));
    index = next;

    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      pushText(source.slice(index + 9, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", index) || source.startsWith("<?", index)) {
      const end = source.indexOf(">", index);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    if (source.startsWith("</", index)) {
      const end = source.indexOf(">", index);
      if (end < 0) break;
      const name = source
        .slice(index + 2, end)
        .trim()
        .toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      index = end + 1;
      continue;
    }

    // Opening tag.
    const end = findTagEnd(source, index);
    if (end < 0) {
      pushText(source.slice(index));
      break;
    }
    const raw = source.slice(index + 1, end);
    index = end + 1;
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([A-Za-z][A-Za-z0-9:-]*)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrs = parseAttributes(body.slice(nameMatch[0].length));

    const closable = IMPLICIT_CLOSE[name];
    if (closable) {
      while (
        stack.length > 1 &&
        closable.includes(stack[stack.length - 1].name ?? "")
      ) {
        stack.pop();
      }
    }

    const element: HtmlNode = { kind: "element", name, attrs, children: [] };
    stack[stack.length - 1].children?.push(element);

    if (
      name === "script" ||
      name === "style" ||
      name === "textarea" ||
      name === "title"
    ) {
      const closeIndex = source.toLowerCase().indexOf(`</${name}`, index);
      const rawText = source.slice(
        index,
        closeIndex < 0 ? source.length : closeIndex,
      );
      if (rawText)
        element.children?.push({
          kind: "text",
          text: decodeHtmlEntities(rawText),
        });
      if (closeIndex < 0) {
        index = source.length;
      } else {
        const closeEnd = source.indexOf(">", closeIndex);
        index = closeEnd < 0 ? source.length : closeEnd + 1;
      }
      continue;
    }

    if (!selfClosing && !VOID_ELEMENTS.has(name)) stack.push(element);
  }
  return root;
}

function findTagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]*)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    attrs[name] = decodeHtmlEntities(value);
  }
  return attrs;
}

/** Parses an HTML document into the intermediate tree. Never throws on markup. */
export function parseHtml(source: string): {
  root: HtmlNode;
  usedFallback: boolean;
} {
  const trimmed = source.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return {
      root: { kind: "element", name: "#document", children: [] },
      usedFallback: false,
    };
  }
  try {
    const parsed = parseWithDom(trimmed);
    if (parsed) return { root: parsed, usedFallback: false };
  } catch {
    // Fall through to the tolerant scanner.
  }
  return { root: parseHtmlTolerant(trimmed), usedFallback: true };
}

/* -------------------------------------------------------------- helpers */

function attrOf(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.[name];
}

function classList(node: HtmlNode): string[] {
  return (attrOf(node, "class") ?? "").split(/\s+/).filter(Boolean);
}

function hasClass(node: HtmlNode, name: string): boolean {
  return classList(node).includes(name);
}

function childElements(node: HtmlNode): HtmlNode[] {
  return (node.children ?? []).filter((child) => child.kind === "element");
}

function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.text ?? "";
  return (node.children ?? []).map((child) => textContent(child)).join("");
}

function findElement(
  node: HtmlNode,
  predicate: (candidate: HtmlNode) => boolean,
): HtmlNode | undefined {
  for (const child of node.children ?? []) {
    if (child.kind !== "element") continue;
    if (predicate(child)) return child;
    const nested = findElement(child, predicate);
    if (nested) return nested;
  }
  return undefined;
}

function findAllElements(
  node: HtmlNode,
  predicate: (candidate: HtmlNode) => boolean,
  out: HtmlNode[] = [],
): HtmlNode[] {
  for (const child of node.children ?? []) {
    if (child.kind !== "element") continue;
    if (predicate(child)) out.push(child);
    findAllElements(child, predicate, out);
  }
  return out;
}

function bodyOf(root: HtmlNode): HtmlNode {
  const body = findElement(root, (node) => node.name === "body");
  if (body) return body;
  const html = findElement(root, (node) => node.name === "html");
  if (html) return html;
  return root;
}

const HEAD_TAGS = new Set([
  "head",
  "title",
  "meta",
  "link",
  "base",
  "style",
  "script",
  "noscript",
  "template",
]);

const ALIGNMENTS = new Set(["left", "center", "right", "justify"]);

function alignmentOf(value: string | undefined): ParagraphProps["alignment"] {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "start") return "left";
  if (normalized === "end") return "right";
  if (normalized === "justify-all") return "justify";
  return ALIGNMENTS.has(normalized)
    ? (normalized as ParagraphProps["alignment"])
    : undefined;
}

function paragraphPropsFromNode(
  node: HtmlNode,
  blockquoteDepth: number,
): ParagraphProps {
  const props: ParagraphProps = {};
  const style = parseCssDeclarations(attrOf(node, "style"));
  const align =
    alignmentOf(attrOf(node, "align")) ?? alignmentOf(style.get("text-align"));
  if (align) props.alignment = align;
  if (attrOf(node, "dir")?.toLowerCase() === "rtl") props.bidi = true;

  const marginLeft = cssLengthToPt(style.get("margin-left"), {
    percentBase: contentWidthHint,
  });
  const paddingLeft = cssLengthToPt(style.get("padding-left"), {
    percentBase: contentWidthHint,
  });
  const indentLeft =
    (marginLeft ?? 0) + (paddingLeft ?? 0) + blockquoteDepth * 36;
  const marginRight = cssLengthToPt(style.get("margin-right"), {
    percentBase: contentWidthHint,
  });
  if (indentLeft > 0 || (marginRight ?? 0) > 0) {
    props.indent = {
      left: indentLeft || undefined,
      right: marginRight || undefined,
    };
  }
  const textIndent = cssLengthToPt(style.get("text-indent"), {
    basePt: 11,
    percentBase: contentWidthHint,
  });
  if (textIndent !== undefined) {
    if (textIndent < 0)
      props.indent = { ...(props.indent ?? {}), hanging: Math.abs(textIndent) };
    else props.indent = { ...(props.indent ?? {}), firstLine: textIndent };
  }
  const spaceBefore = cssLengthToPt(style.get("margin-top"), { basePt: 11 });
  const spaceAfter = cssLengthToPt(style.get("margin-bottom"), { basePt: 11 });
  if (spaceBefore !== undefined) props.spaceBefore = spaceBefore;
  if (spaceAfter !== undefined) props.spaceAfter = spaceAfter;
  if ((style.get("page-break-before") ?? "").toLowerCase() === "always")
    props.pageBreakBefore = true;

  const lineHeight = style.get("line-height");
  if (lineHeight) {
    const numeric = Number(lineHeight);
    if (Number.isFinite(numeric) && numeric > 0) {
      props.lineSpacing = { rule: "auto", value: numeric * 240 };
    } else {
      const absolute = cssLengthToPt(lineHeight, { basePt: 11 });
      if (absolute !== undefined)
        props.lineSpacing = { rule: "exact", value: absolute };
    }
  }
  return props;
}

/** Percentage base used before the page geometry is known (A4 text width). */
const contentWidthHint = 451.3;

function runPropsFromNode(node: HtmlNode, base: RunProps): RunProps {
  const name = node.name;
  let patch: RunProps = {};
  switch (name) {
    case "strong":
    case "b":
      patch.bold = true;
      break;
    case "em":
    case "i":
    case "cite":
    case "dfn":
      patch.italic = true;
      break;
    case "u":
      patch.underline = "single";
      break;
    case "s":
    case "strike":
      patch.strike = true;
      break;
    case "del":
      patch.strike = true;
      break;
    case "sup":
      patch.vertAlign = "superscript";
      break;
    case "sub":
      patch.vertAlign = "subscript";
      break;
    case "mark":
      patch.highlight = "#ffff00";
      patch.background = "#ffff00";
      break;
    case "small":
      patch.fontSize = 9;
      break;
    case "big":
      patch.fontSize = 14;
      break;
    case "code":
    case "kbd":
    case "samp":
    case "tt":
      patch.fontFamily = "Consolas";
      patch.background = "#f2f2f2";
      break;
    default:
      break;
  }
  const style = parseCssDeclarations(attrOf(node, "style"));
  patch = mergeRun(patch, runPropsFromStyle(style, base));
  if (name === "font") {
    const color = normalizeCssColor(attrOf(node, "color"));
    if (color) patch.color = color;
    const face = attrOf(node, "face");
    if (face)
      patch.fontFamily = face.split(",")[0]?.replace(/["']/g, "").trim();
    const size = Number(attrOf(node, "size"));
    if (Number.isFinite(size) && size > 0) {
      // Legacy HTML font sizes: 3 = 12pt, each step is roughly 1.2x.
      patch.fontSize = Math.max(6, Math.min(48, 12 * Math.pow(1.2, size - 3)));
    }
  }
  return mergeRun(base, patch);
}

function runPropsFromStyle(style: CssDeclarations, base: RunProps): RunProps {
  const patch: RunProps = {};
  const color = normalizeCssColor(style.get("color"));
  if (color) patch.color = color;
  const background =
    normalizeCssColor(style.get("background-color")) ??
    normalizeCssColor(style.get("background"));
  if (background) patch.background = background;
  const fontSize = cssLengthToPt(style.get("font-size"), {
    basePt: base.fontSize ?? 11,
  });
  if (fontSize !== undefined) patch.fontSize = Math.max(1, fontSize);
  const fontFamily = style.get("font-family");
  if (fontFamily) {
    patch.fontFamily = fontFamily
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .find((part) => part.length > 0);
  }
  const weight = (style.get("font-weight") ?? "").toLowerCase();
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600)
    patch.bold = true;
  else if (weight === "normal" || weight === "lighter" || weight === "400")
    patch.bold = false;
  const fontStyle = (style.get("font-style") ?? "").toLowerCase();
  if (fontStyle === "italic" || fontStyle === "oblique") patch.italic = true;
  else if (fontStyle === "normal") patch.italic = false;
  const decoration = (
    style.get("text-decoration-line") ??
    style.get("text-decoration") ??
    ""
  ).toLowerCase();
  if (decoration.includes("underline")) patch.underline = "single";
  if (decoration.includes("line-through")) patch.strike = true;
  const vertical = (style.get("vertical-align") ?? "").toLowerCase();
  if (vertical === "super") patch.vertAlign = "superscript";
  else if (vertical === "sub") patch.vertAlign = "subscript";
  const transform = (style.get("text-transform") ?? "").toLowerCase();
  if (transform === "uppercase") patch.caps = true;
  const variant = (style.get("font-variant") ?? "").toLowerCase();
  if (variant.includes("small-caps")) patch.smallCaps = true;
  const letterSpacing = cssLengthToPt(style.get("letter-spacing"), {
    basePt: base.fontSize ?? 11,
  });
  if (letterSpacing !== undefined) patch.charSpacing = letterSpacing;
  if ((style.get("display") ?? "").toLowerCase() === "none")
    patch.hidden = true;
  return patch;
}

const UNSAFE_URL = /^\s*(javascript|vbscript|data:text\/html|file):/i;

/* --------------------------------------------------------------- importer */

interface PendingNote {
  note: Note;
  node: HtmlNode;
}

interface PendingComment {
  comment: DocComment;
  node: HtmlNode;
}

class HtmlImporter {
  readonly losses = new LossCollector();
  readonly features = new Map<string, number>();
  private readonly annotationNodes = new Set<HtmlNode>();
  private readonly notes = new Map<string, Note>();
  private readonly pendingNotes: PendingNote[] = [];
  private readonly pendingComments: PendingComment[] = [];
  private usedFallback = false;
  /** Set when the document was produced by this exporter. */
  private preserveWhitespace = false;

  constructor(private readonly ctx: DocumentContext) {}

  private count(feature: string, amount = 1): void {
    this.features.set(feature, (this.features.get(feature) ?? 0) + amount);
  }

  run(root: HtmlNode, usedFallback: boolean): void {
    this.usedFallback = usedFallback;
    this.collectAnnotations(root);
    const body = bodyOf(root);
    this.preserveWhitespace =
      attrOf(body, "data-dsh-whitespace") === "preserve";
    for (const child of body.children ?? []) {
      if (child.kind === "element" && child.name && HEAD_TAGS.has(child.name))
        continue;
      this.convertNode(child, this.ctx.blocks, { blockquoteDepth: 0 });
    }
    // Annotation bodies are converted after the main flow so their ids exist.
    for (const pending of this.pendingComments) {
      this.convertNode(pending.node, pending.comment.blocks, {
        blockquoteDepth: 0,
        skipAnnotation: true,
      });
    }
    for (const pending of this.pendingNotes) {
      this.convertNode(pending.node, pending.note.blocks, {
        blockquoteDepth: 0,
        skipAnnotation: true,
      });
      if (pending.note.blocks.length === 0) {
        pending.note.blocks.push(makeParagraph(this.ctx, []));
      }
    }
    if (this.usedFallback) {
      this.losses.partial(
        "html.markup",
        "Input is not well-formed XML; a tolerant HTML scanner recovered the structure",
        undefined,
        false,
      );
    }
  }

  private collectAnnotations(root: HtmlNode): void {
    // A document can carry both a footnote section and an endnote section. Every
    // such section is an annotation container; missing one would import its text
    // into the body.
    const notesSections = findAllElements(
      root,
      (node) =>
        (hasClass(node, "dsh-footnotes") || hasClass(node, "dsh-endnotes")) &&
        (node.name === "section" || node.name === "div" || node.name === "ol"),
    );
    for (const notesSection of notesSections) {
      const type = hasClass(notesSection, "dsh-endnotes")
        ? "endnote"
        : "footnote";
      const items = findAllElements(
        notesSection,
        (node) => node.name === "li" && Boolean(attrOf(node, "id")),
      );
      for (const item of items) {
        const id = attrOf(item, "id") ?? this.ctx.next("fn");
        const note: Note = { id, type, blocks: [] };
        if (type === "footnote") this.ctx.doc.footnotes.push(note);
        else this.ctx.doc.endnotes.push(note);
        this.notes.set(id, note);
        this.pendingNotes.push({ note, node: item });
        this.count(type === "footnote" ? "footnote" : "endnote");
      }
      this.annotationNodes.add(notesSection);
    }

    const asides = findAllElements(
      root,
      (node) => node.name === "aside" && hasClass(node, "dsh-comment"),
    );
    for (const aside of asides) {
      const id = attrOf(aside, "data-comment-id") ?? this.ctx.next("comment");
      const comment: DocComment = {
        id,
        author: attrOf(aside, "data-author") ?? "Unknown",
        initials: attrOf(aside, "data-initials"),
        date: attrOf(aside, "data-date"),
        blocks: [],
        resolved: attrOf(aside, "data-resolved") === "true",
      };
      const parentId = attrOf(aside, "data-parent-id");
      if (parentId) comment.parentId = parentId;
      this.ctx.doc.comments.push(comment);
      this.pendingComments.push({ comment, node: aside });
      this.annotationNodes.add(aside);
      this.count("comment");
    }
  }

  private convertNode(
    node: HtmlNode,
    target: Block[],
    state: { blockquoteDepth: number; skipAnnotation?: boolean },
  ): void {
    if (node.kind === "text") {
      const text = collapseWhitespace(node.text ?? "").trim();
      if (text.length === 0) return;
      const inlines: Inline[] = [];
      pushText(inlines, text, {});
      target.push(makeParagraph(this.ctx, inlines));
      return;
    }
    if (this.annotationNodes.has(node) && !state.skipAnnotation) return;
    const name = node.name ?? "";
    const inline = (props: ParagraphProps = {}) => {
      const inlines = this.inlinesOf(node, {}, state);
      if (inlines.length === 0) return;
      target.push(makeParagraph(this.ctx, inlines, { props }));
    };

    if (HEAD_TAGS.has(name)) return;
    if (name === "nav" && hasClass(node, "dsh-toc")) {
      const clampLevel = (
        value: string | undefined,
        fallback: number,
      ): number => {
        const parsed = Number.parseInt(value ?? "", 10);
        return Number.isFinite(parsed)
          ? Math.max(1, Math.min(9, parsed))
          : fallback;
      };
      const minLevel = clampLevel(attrOf(node, "data-toc-min-level"), 1);
      const maxLevel = Math.max(
        minLevel,
        clampLevel(attrOf(node, "data-toc-max-level"), minLevel + 2),
      );
      const leader = attrOf(node, "data-toc-tab-leader");
      target.push({
        type: "toc",
        id: this.ctx.next("toc"),
        minLevel,
        maxLevel,
        hyperlinks: attrOf(node, "data-toc-hyperlinks") !== "false",
        pageNumbers: attrOf(node, "data-toc-page-numbers") !== "false",
        tabLeader:
          leader === "none" || leader === "underscore" || leader === "hyphen"
            ? leader
            : "dot",
        ...(attrOf(node, "data-toc-include-title") === "true"
          ? { includeTitle: true }
          : {}),
      } satisfies TocBlock);
      this.count("toc");
      return;
    }
    if (
      name === "html" ||
      name === "body" ||
      name === "div" ||
      name === "section" ||
      name === "article" ||
      name === "main" ||
      name === "header" ||
      name === "footer" ||
      name === "nav" ||
      name === "form" ||
      name === "fieldset" ||
      name === "details" ||
      name === "summary" ||
      name === "figure" ||
      name === "figcaption" ||
      name === "address" ||
      name === "center" ||
      name === "hgroup"
    ) {
      for (const child of node.children ?? []) {
        this.convertNode(child, target, state);
      }
      this.count("html.block");
      return;
    }

    if (/^h[1-6]$/.test(name)) {
      const level = Number(name[1]);
      const inlines = this.inlinesOf(node, {}, state);
      const props = {
        ...paragraphPropsFromNode(node, state.blockquoteDepth),
        outlineLevel: level - 1,
      };
      target.push(
        makeParagraph(this.ctx, inlines, { style: `Heading${level}`, props }),
      );
      this.count("paragraph.heading");
      return;
    }

    if (
      name === "p" ||
      name === "dt" ||
      name === "dd" ||
      name === "li" ||
      name === "caption"
    ) {
      this.convertParagraphLike(node, target, state);
      this.count("paragraph.text");
      return;
    }

    if (name === "blockquote") {
      this.convertQuote(node, target, state);
      return;
    }

    if (name === "ul" || name === "ol") {
      this.convertList(node, target, state.blockquoteDepth, undefined, 0);
      return;
    }

    if (name === "table") {
      const table = this.convertTable(node, state);
      target.push(table);
      this.count("table");
      return;
    }

    if (name === "pre") {
      this.convertPre(node, target, state);
      return;
    }

    if (name === "dl") {
      for (const child of childElements(node)) {
        this.convertNode(child, target, state);
      }
      return;
    }

    if (name === "hr") {
      const border: Border = { style: "single", width: 1, color: "#999999" };
      target.push(
        makeParagraph(this.ctx, [], {
          props: { borders: { bottom: border }, spaceBefore: 6, spaceAfter: 6 },
        }),
      );
      this.count("block.rule");
      return;
    }

    if (name === "br") {
      target.push(makeParagraph(this.ctx, [{ type: "break", kind: "line" }]));
      return;
    }

    if (name === "img") {
      const inlineImage = this.imageInline(node);
      const inlines: Inline[] = inlineImage ? [inlineImage] : [];
      target.push(makeParagraph(this.ctx, inlines));
      return;
    }

    if (
      name === "svg" ||
      name === "math" ||
      name === "canvas" ||
      name === "object" ||
      name === "embed" ||
      name === "iframe"
    ) {
      const text = collapseWhitespace(textContent(node)).trim();
      this.losses.fallback(
        `html.${name}`,
        `<${name}> content is not interpreted; its text projection is kept`,
        undefined,
        false,
      );
      if (text.length > 0) {
        const inlines: Inline[] = [];
        pushText(inlines, text, {});
        target.push(makeParagraph(this.ctx, inlines));
      }
      return;
    }

    if (this.hasBlockChildren(node)) {
      for (const child of node.children ?? []) {
        this.convertNode(child, target, state);
      }
      this.count("html.container");
      return;
    }

    inline(paragraphPropsFromNode(node, state.blockquoteDepth));
  }

  private hasBlockChildren(node: HtmlNode): boolean {
    return childElements(node).some(
      (child) =>
        BOX_LIKE.has(child.name ?? "") ||
        (child.name !== undefined &&
          BLOCK_NAMES.has(child.name) &&
          child.name !== "li"),
    );
  }

  private convertParagraphLike(
    node: HtmlNode,
    target: Block[],
    state: { blockquoteDepth: number },
  ): void {
    const inlineNodes: HtmlNode[] = [];
    const blockNodes: HtmlNode[] = [];
    for (const child of node.children ?? []) {
      if (child.kind === "element" && child.name && BOX_LIKE.has(child.name))
        blockNodes.push(child);
      else inlineNodes.push(child);
    }
    const inlines = this.inlinesOfNodes(inlineNodes, {}, state);
    const props = paragraphPropsFromNode(node, state.blockquoteDepth);
    // An empty <p></p> is a real empty paragraph; dropping it would change the
    // document structure (and add/remove a line in the text projection).
    if (
      inlines.length > 0 ||
      (blockNodes.length === 0 && (node.children ?? []).length === 0)
    )
      target.push(makeParagraph(this.ctx, inlines, { props }));
    for (const child of blockNodes) this.convertNode(child, target, state);
  }

  private convertQuote(
    node: HtmlNode,
    target: Block[],
    state: { blockquoteDepth: number },
  ): void {
    const style = ensureQuoteStyle(this.ctx.doc);
    const depth = state.blockquoteDepth + 1;
    const before = target.length;
    for (const child of node.children ?? []) {
      this.convertNode(child, target, { ...state, blockquoteDepth: depth });
    }
    if (target.length === before) {
      const inlines = this.inlinesOf(
        node,
        { italic: true },
        { blockquoteDepth: depth },
      );
      if (inlines.length > 0)
        target.push(makeParagraph(this.ctx, inlines, { style }));
    } else {
      for (let index = before; index < target.length; index += 1) {
        const block = target[index];
        if (block.type === "paragraph" && block.style === "Normal")
          block.style = style;
      }
    }
    this.count("block.quote");
  }

  private convertList(
    node: HtmlNode,
    target: Block[],
    blockquoteDepth: number,
    inheritedNumId: string | undefined,
    level: number,
  ): void {
    const kind = node.name === "ol" ? "number" : "bullet";
    const numId =
      inheritedNumId ?? createListDefinition(this.ctx.doc, { kind });
    const start = Number(attrOf(node, "start"));
    let first = true;
    for (const child of childElements(node)) {
      if (child.name !== "li") {
        this.convertNode(child, target, { blockquoteDepth });
        continue;
      }
      const nested: HtmlNode[] = [];
      const inlineNodes: HtmlNode[] = [];
      const blockNodes: HtmlNode[] = [];
      for (const item of child.children ?? []) {
        if (
          item.kind === "element" &&
          (item.name === "ul" || item.name === "ol")
        )
          nested.push(item);
        else if (
          item.kind === "element" &&
          item.name &&
          BOX_LIKE.has(item.name)
        )
          blockNodes.push(item);
        else inlineNodes.push(item);
      }
      const numbering = {
        numId,
        level,
        startOverride:
          first && Number.isFinite(start) && start > 1 ? start : undefined,
      };
      const valueAttr = Number(attrOf(child, "value"));
      if (Number.isFinite(valueAttr) && valueAttr > 0)
        numbering.startOverride = valueAttr;

      let produced = false;
      if (blockNodes.length > 0) {
        const before = target.length;
        for (const blockNode of blockNodes)
          this.convertNode(blockNode, target, { blockquoteDepth });
        for (let index = before; index < target.length; index += 1) {
          const block = target[index];
          if (block.type === "paragraph" && !block.props.numbering) {
            block.props = { ...block.props, numbering };
            produced = true;
            break;
          }
        }
      }
      const inlines = this.inlinesOfNodes(inlineNodes, {}, { blockquoteDepth });
      if (inlines.length > 0) {
        target.push(
          makeParagraph(this.ctx, inlines, {
            props: {
              numbering,
              indent: { left: 36 + level * 36, hanging: 18 },
            },
          }),
        );
        produced = true;
      }
      if (!produced && nested.length === 0) {
        target.push(
          makeParagraph(this.ctx, [], {
            props: {
              numbering,
              indent: { left: 36 + level * 36, hanging: 18 },
            },
          }),
        );
      }
      for (const nestedList of nested) {
        this.convertList(
          nestedList,
          target,
          blockquoteDepth,
          numId,
          Math.min(8, level + 1),
        );
      }
      first = false;
    }
    this.count("lists.numbering");
  }

  private convertPre(
    node: HtmlNode,
    target: Block[],
    state: { blockquoteDepth: number },
  ): void {
    const style = ensureCodeStyle(this.ctx.doc);
    const raw = textContent(node).replace(/\r\n?/g, "\n");
    const lines = raw.replace(/\n$/, "").split("\n");
    if (lines.length === 0) return;
    lines.forEach((line, index) => {
      const inlines: Inline[] = [];
      pushText(inlines, line, { fontFamily: "Consolas", fontSize: 10 });
      if (index < lines.length - 1)
        inlines.push({ type: "break", kind: "line" });
      target.push(
        makeParagraph(this.ctx, inlines, {
          style,
          props: paragraphPropsFromNode(node, state.blockquoteDepth),
        }),
      );
    });
    this.count("block.preformatted");
  }

  private convertTable(
    node: HtmlNode,
    state: { blockquoteDepth: number },
  ): Table {
    const rowNodes = this.tableRows(node);
    interface CellPlan {
      node: HtmlNode;
      header: boolean;
      colspan: number;
      rowspan: number;
    }
    const plans: CellPlan[][] = rowNodes.map((row) =>
      childElements(row)
        .filter((cell) => cell.name === "td" || cell.name === "th")
        .map((cell) => ({
          node: cell,
          header: cell.name === "th",
          colspan: Math.max(
            1,
            Math.min(64, Number(attrOf(cell, "colspan")) || 1),
          ),
          rowspan: Math.max(
            1,
            Math.min(1024, Number(attrOf(cell, "rowspan")) || 1),
          ),
        })),
    );

    const columnCount = Math.max(
      1,
      ...plans.map((row) => row.reduce((sum, cell) => sum + cell.colspan, 0)),
    );
    const widths = this.tableColumnWidths(node, columnCount);
    const continuation: Array<Array<{ span: number } | undefined>> = plans.map(
      () =>
        new Array<{ span: number } | undefined>(columnCount).fill(undefined),
    );

    const rowSpecs: TableCellSpec[][] = [];
    let headerRows = 0;
    plans.forEach((row, rowIndex) => {
      const specs: TableCellSpec[] = [];
      let column = 0;
      let allHeader = row.length > 0;
      for (const cell of row) {
        while (column < columnCount && continuation[rowIndex][column]) {
          const cont = continuation[rowIndex][column];
          specs.push({
            blocks: [makeParagraph(this.ctx, [])],
            props: {
              width: { value: widths[column] ?? 0, type: "dxa" },
              vMerge: "continue",
            },
          });
          column += cont?.span ?? 1;
        }
        allHeader = allHeader && cell.header;
        const blocks: Block[] = [];
        for (const child of cell.node.children ?? []) {
          this.convertNode(child, blocks, {
            blockquoteDepth: state.blockquoteDepth,
          });
        }
        if (blocks.length === 0) blocks.push(makeParagraph(this.ctx, []));
        if (cell.header) applyRunPatch(blocks, { bold: true });
        if (cell.colspan > 1 || cell.rowspan > 1)
          this.count("table.mergedCells");
        specs.push({
          blocks,
          gridSpan: cell.colspan > 1 ? cell.colspan : undefined,
          vMerge: cell.rowspan > 1 ? "restart" : undefined,
          props: { width: { value: widths[column] ?? 0, type: "dxa" } },
        });
        if (cell.rowspan > 1) {
          for (
            let offset = 1;
            offset < Math.min(cell.rowspan, plans.length - rowIndex);
            offset += 1
          ) {
            const rowContinuation = continuation[rowIndex + offset];
            let span = cell.colspan;
            let anchor = column;
            while (anchor < columnCount && rowContinuation[anchor]) anchor += 1;
            if (anchor >= columnCount) break;
            rowContinuation[anchor] = { span };
            span = 1;
          }
        }
        column += cell.colspan;
      }
      while (column < columnCount && continuation[rowIndex][column]) {
        const cont = continuation[rowIndex][column];
        specs.push({
          blocks: [makeParagraph(this.ctx, [])],
          props: {
            width: { value: widths[column] ?? 0, type: "dxa" },
            vMerge: "continue",
          },
        });
        column += cont?.span ?? 1;
      }
      if (specs.length === 0) return;
      if (allHeader) headerRows = rowSpecs.length + 1;
      rowSpecs.push(specs);
    });

    if (rowSpecs.length === 0) {
      this.losses.partial(
        "table.empty",
        "Table has no rows; an empty table is kept",
        undefined,
        false,
      );
      rowSpecs.push([{ blocks: [makeParagraph(this.ctx, [])] }]);
    }

    return buildTable(this.ctx, rowSpecs, {
      columns: columnCount,
      columnWidths: widths,
      headerRows: headerRows > 0 ? headerRows : undefined,
    });
  }

  private tableRows(table: HtmlNode): HtmlNode[] {
    const rows: HtmlNode[] = [];
    for (const child of childElements(table)) {
      if (child.name === "tr") rows.push(child);
      else if (
        child.name === "thead" ||
        child.name === "tbody" ||
        child.name === "tfoot"
      ) {
        for (const row of childElements(child)) {
          if (row.name === "tr") rows.push(row);
        }
      }
    }
    return rows;
  }

  private tableColumnWidths(table: HtmlNode, columnCount: number): number[] {
    const total = contentWidthPt(this.ctx.doc);
    const fallback = new Array(columnCount).fill(total / columnCount);
    const colgroup = findElement(table, (node) => node.name === "colgroup");
    const colNodes = colgroup
      ? findAllElements(colgroup, (node) => node.name === "col")
      : [];
    if (colNodes.length === 0) return fallback;
    const widths: number[] = [];
    for (const col of colNodes) {
      const span = Math.max(1, Number(attrOf(col, "span")) || 1);
      const style = parseCssDeclarations(attrOf(col, "style"));
      const width =
        cssLengthToPt(attrOf(col, "width"), { percentBase: total }) ??
        cssLengthToPt(style.get("width"), { percentBase: total });
      for (let index = 0; index < span; index += 1)
        widths.push(width ?? total / columnCount);
    }
    while (widths.length < columnCount) widths.push(total / columnCount);
    return widths.slice(0, columnCount);
  }

  private imageInline(node: HtmlNode): ImageInline | undefined {
    const src = attrOf(node, "src") ?? "";
    const alt = attrOf(node, "alt");
    const title = attrOf(node, "title");
    const widthPx = Number(attrOf(node, "width"));
    const heightPx = Number(attrOf(node, "height"));
    const decoded = decodeDataUri(src);
    if (decoded) {
      const inline = addImageInline(this.ctx, {
        data: decoded.data,
        contentType: decoded.contentType,
        alt,
        title,
        width:
          Number.isFinite(widthPx) && widthPx > 0 ? pxToPt(widthPx) : undefined,
        height:
          Number.isFinite(heightPx) && heightPx > 0
            ? pxToPt(heightPx)
            : undefined,
      });
      this.count("image.inline");
      return inline;
    }
    if (src.length > 0) {
      this.losses.partial(
        "image.remote",
        "Remote images are never fetched; only the alt text is kept",
        src.slice(0, 120),
        false,
      );
    } else {
      this.losses.partial(
        "image.missing",
        "Image element without a src attribute was skipped",
        undefined,
        false,
      );
    }
    return undefined;
  }

  private inlinesOf(
    node: HtmlNode,
    base: RunProps,
    state: { blockquoteDepth: number },
  ): Inline[] {
    return this.inlinesOfNodes(node.children ?? [], base, state);
  }

  private inlinesOfNodes(
    nodes: HtmlNode[],
    base: RunProps,
    state: { blockquoteDepth: number },
  ): Inline[] {
    const out: Inline[] = [];
    this.walkInline(nodes, base, out, state);
    if (!this.preserveWhitespace) trimInlineWhitespace(out);
    return out;
  }

  private walkInline(
    nodes: HtmlNode[],
    props: RunProps,
    out: Inline[],
    state: { blockquoteDepth: number },
  ): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        pushText(out, collapseWhitespace(node.text ?? ""), props);
        continue;
      }
      if (!node.name) continue;
      const name = node.name;

      if (name === "br") {
        out.push({ type: "break", kind: "line" });
        continue;
      }
      if (name === "img") {
        const image = this.imageInline(node);
        if (image) out.push(image);
        else {
          const alt = attrOf(node, "alt") ?? attrOf(node, "title");
          if (alt) pushText(out, alt, props);
        }
        continue;
      }
      if (
        name === "script" ||
        name === "style" ||
        name === "noscript" ||
        name === "template"
      ) {
        this.losses.partial(
          `html.${name}`,
          `<${name}> content is not document content and was ignored`,
          undefined,
          false,
        );
        continue;
      }
      if (this.annotationNodes.has(node) && !hasClass(node, "dsh-comment-ref"))
        continue;

      const commentMark = this.commentMarkInline(node);
      if (commentMark) {
        out.push(commentMark);
        continue;
      }

      const spaceMarker = attrOf(node, "data-dsh-space");
      if (spaceMarker !== undefined) {
        const count = Math.max(
          1,
          Math.min(1024, Number.parseInt(spaceMarker, 10) || 1),
        );
        pushText(out, " ".repeat(count), props);
        continue;
      }
      if (attrOf(node, "data-dsh-newline") !== undefined) {
        pushText(out, "\n", props);
        continue;
      }
      if (hasClass(node, "dsh-page-break")) {
        out.push({ type: "break", kind: "page" });
        continue;
      }
      if (attrOf(node, "data-dsh-tab") !== undefined) {
        out.push({ type: "tab" });
        continue;
      }

      const noteRef = this.noteRefInline(node);
      if (noteRef) {
        out.push(noteRef);
        continue;
      }

      if (name === "a") {
        const href = attrOf(node, "href");
        if (href && UNSAFE_URL.test(href)) {
          this.losses.unsupported(
            "hyperlink.unsafe",
            "Unsafe URL scheme was not imported as a hyperlink",
            href.slice(0, 80),
            false,
          );
          this.walkInline(node.children ?? [], props, out, state);
          continue;
        }
        const target = href
          ? mergeRun(props, {
              hyperlink: {
                href: href.startsWith("#") ? undefined : href,
                anchor: href.startsWith("#") ? href.slice(1) : undefined,
                tooltip: attrOf(node, "title"),
                external: !href.startsWith("#"),
              },
              color: undefined,
              underline: undefined,
            })
          : props;
        this.walkInline(node.children ?? [], target, out, state);
        this.count("hyperlink");
        continue;
      }

      if (name === "ins" || name === "del") {
        const kind = name === "ins" ? "insert" : "delete";
        const revision = this.revisionMark(kind, node);
        this.walkInline(
          node.children ?? [],
          mergeRun(props, { revision }),
          out,
          state,
        );
        this.count(kind === "insert" ? "revisions.insert" : "revisions.delete");
        continue;
      }

      if (name === "math" || name === "svg" || name === "canvas") {
        this.losses.fallback(
          `inline.${name}`,
          `Inline <${name}> is kept as its text projection`,
          undefined,
          false,
        );
        this.walkInline(node.children ?? [], props, out, state);
        continue;
      }

      if (
        name === "input" ||
        name === "button" ||
        name === "select" ||
        name === "textarea"
      ) {
        const value = attrOf(node, "value") ?? textContent(node);
        if (value) pushText(out, value, props);
        this.losses.partial(
          "html.formControl",
          "Form controls are flattened to their current value",
          undefined,
          false,
        );
        continue;
      }

      const nextProps = runPropsFromNode(node, props);
      if (nextProps.hidden) {
        this.losses.partial(
          "html.hidden",
          "Hidden element content was not imported",
          undefined,
          false,
        );
        continue;
      }
      const known =
        TAG_PATCHED.has(name) ||
        name === "span" ||
        name === "font" ||
        name === "q" ||
        name === "abbr" ||
        name === "time" ||
        name === "label" ||
        name === "bdi" ||
        name === "bdo" ||
        name === "wbr";
      if (!known && node.children && node.children.length > 0) {
        this.losses.partial(
          `html.element:${name}`,
          "Unknown inline element was flattened to its text content",
          undefined,
          true,
        );
      }
      if (name === "wbr") continue;
      this.walkInline(node.children ?? [], nextProps, out, state);
    }
  }

  private commentMarkInline(node: HtmlNode): Inline | undefined {
    const attributes = node.attrs ?? {};
    const id =
      attributes["data-comment-ref"] ??
      attributes["data-comment-start"] ??
      attributes["data-comment-end"];
    if (!id) return undefined;
    const kind: "point" | "rangeStart" | "rangeEnd" =
      attributes["data-comment-start"] !== undefined
        ? "rangeStart"
        : attributes["data-comment-end"] !== undefined
          ? "rangeEnd"
          : "point";
    return { type: "commentRef", commentId: id, kind };
  }

  private noteRefInline(node: HtmlNode): Inline | undefined {
    const anchor = findElement(
      node,
      (child) =>
        child.name === "a" && (attrOf(child, "href") ?? "").startsWith("#"),
    );
    if (!anchor) return undefined;
    const targetId = (attrOf(anchor, "href") ?? "").slice(1);
    const note = this.notes.get(targetId);
    if (!note) {
      if (
        hasClass(node, "dsh-footnote-ref") ||
        hasClass(node, "dsh-endnote-ref")
      ) {
        this.losses.partial(
          "notes.reference",
          "Note reference does not resolve to a note body",
          targetId,
          false,
        );
      }
      return undefined;
    }
    this.count(
      note.type === "footnote" ? "footnote.reference" : "endnote.reference",
    );
    return { type: "noteRef", noteId: note.id, noteType: note.type };
  }

  private revisionMark(
    kind: "insert" | "delete",
    node: HtmlNode,
  ): RevisionMark {
    const id = this.ctx.next("rev");
    const author = attrOf(node, "data-author") ?? attrOf(node, "author");
    const date = attrOf(node, "data-date") ?? attrOf(node, "datetime");
    this.ctx.doc.revisions.push({
      id,
      kind,
      author,
      date,
      summary:
        kind === "insert"
          ? "Tracked insertion from HTML"
          : "Tracked deletion from HTML",
      blockIds: [],
    });
    return { id, kind, author, date };
  }
}

const BOX_LIKE = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

const TAG_PATCHED = new Set([
  "b",
  "big",
  "cite",
  "code",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "s",
  "samp",
  "small",
  "strike",
  "strong",
  "sub",
  "sup",
  "tt",
  "u",
]);

function trimInlineWhitespace(inlines: Inline[]): void {
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

/** Applies run formatting to every text run in a block tree (used for `<th>`). */
function applyRunPatch(blocks: Block[], patch: RunProps): void {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const inline of block.inlines) {
        if (inline.type === "text")
          inline.props = mergeRun(inline.props, patch);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) applyRunPatch(cell.blocks, patch);
      }
    }
  }
}

/* --------------------------------------------------------------- metadata */

interface HtmlHeadInfo {
  metadata: {
    title?: string;
    creator?: string;
    description?: string;
    keywords?: string[];
    custom: Record<string, string>;
  };
  language?: string;
  page?: {
    width: number;
    height: number;
    margins?: Partial<{
      top: number;
      right: number;
      bottom: number;
      left: number;
    }>;
  };
  styleLoss: boolean;
}

function readHeadInfo(root: HtmlNode): HtmlHeadInfo {
  const info: HtmlHeadInfo = {
    metadata: { keywords: [], custom: {} },
    styleLoss: false,
  };
  const title = findElement(root, (node) => node.name === "title");
  if (title) {
    const text = collapseWhitespace(textContent(title)).trim();
    if (text) info.metadata.title = text;
  }
  const html = findElement(root, (node) => node.name === "html");
  const lang = html ? attrOf(html, "lang") : undefined;
  if (lang) info.language = lang;

  for (const meta of findAllElements(root, (node) => node.name === "meta")) {
    const name = (
      attrOf(meta, "name") ??
      attrOf(meta, "property") ??
      ""
    ).toLowerCase();
    const content = attrOf(meta, "content") ?? "";
    if (!content) continue;
    if (name === "author") info.metadata.creator = content;
    else if (name === "description") info.metadata.description = content;
    else if (name === "keywords")
      info.metadata.keywords = content
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    else if (name === "generator") info.metadata.custom.generator = content;
    else if (name.startsWith("dsh-"))
      info.metadata.custom[name.slice(4)] = content;
    else if (name === "dcterms.created" || name === "dcterms.modified")
      info.metadata.custom[name] = content;
  }

  const styleNodes = findAllElements(root, (node) => node.name === "style");
  for (const styleNode of styleNodes) {
    const css = textContent(styleNode);
    const pageMatch = /@page[^{]*{([^}]*)}/i.exec(css);
    if (pageMatch) {
      const declarations = parseCssDeclarations(pageMatch[1]);
      const size = declarations.get("size");
      if (size) {
        const parts = size.split(/\s+/);
        if (parts.length >= 2) {
          const width = cssLengthToPt(parts[0]);
          const height = cssLengthToPt(parts[1]);
          if (width && height)
            info.page = {
              width: Math.min(width, height),
              height: Math.max(width, height),
            };
        }
      }
      const margins: Partial<{
        top: number;
        right: number;
        bottom: number;
        left: number;
      }> = {};
      const top = cssLengthToPt(declarations.get("margin-top"));
      const right = cssLengthToPt(declarations.get("margin-right"));
      const bottom = cssLengthToPt(declarations.get("margin-bottom"));
      const left = cssLengthToPt(declarations.get("margin-left"));
      if (top !== undefined) margins.top = top;
      if (right !== undefined) margins.right = right;
      if (bottom !== undefined) margins.bottom = bottom;
      if (left !== undefined) margins.left = left;
      const shorthand = declarations.get("margin");
      if (shorthand) {
        const parts = shorthand.split(/\s+/).map((part) => cssLengthToPt(part));
        if (parts.length >= 1 && parts[0] !== undefined) {
          margins.top = margins.top ?? parts[0];
          if (parts.length === 1) {
            margins.right = margins.right ?? parts[0];
            margins.bottom = margins.bottom ?? parts[0];
            margins.left = margins.left ?? parts[0];
          } else if (parts.length >= 2) {
            margins.right = margins.right ?? parts[1];
            margins.left = margins.left ?? parts[1];
            if (parts.length >= 3 && parts[2] !== undefined)
              margins.bottom = margins.bottom ?? parts[2];
            if (parts.length >= 4 && parts[3] !== undefined)
              margins.left = margins.left ?? parts[3];
          }
        }
      }
      if (Object.keys(margins).length > 0) {
        info.page = info.page ?? { width: 595.3, height: 841.9 };
        info.page.margins = margins;
      }
    }
    if (css.replace(/@page[^{]*{[^}]*}/gi, "").trim().length > 0)
      info.styleLoss = true;
  }
  return info;
}

/**
 * Imports HTML into the shared document model.
 *
 * Headings map to `Heading1..6`, lists use generated numbering definitions,
 * `colspan`/`rowspan` become `gridSpan`/`vMerge`, `data:` images become media
 * assets, and comments/footnotes/revisions written by `exportHtml` (and their
 * conventional HTML equivalents) are reconstructed.
 */
export async function importHtml(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `HTML input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  const source = buffer.toString("utf8");
  const parsed = parseHtml(source);
  const head = readHeadInfo(parsed.root);

  const ctx = createDocumentContext({
    metadata: {
      title: head.metadata.title ?? titleFromFileName(options.fileName),
      creator: head.metadata.creator,
      description: head.metadata.description,
      keywords: head.metadata.keywords,
      custom: head.metadata.custom,
    },
    settings: head.language ? { defaultLanguage: head.language } : {},
    page: head.page
      ? {
          width: head.page.width,
          height: head.page.height,
          orientation:
            head.page.width > head.page.height ? "landscape" : "portrait",
          margins: {
            top: head.page.margins?.top ?? 72,
            right: head.page.margins?.right ?? 72,
            bottom: head.page.margins?.bottom ?? 72,
            left: head.page.margins?.left ?? 72,
            header: 36,
            footer: 36,
            gutter: 0,
          },
        }
      : undefined,
  });

  const importer = new HtmlImporter(ctx);
  importer.run(parsed.root, parsed.usedFallback);
  if (head.styleLoss) {
    importer.losses.partial(
      "css.stylesheet",
      "CSS rules other than @page are not interpreted; inline styles are imported",
      undefined,
      false,
    );
  }
  ctx.syncIds();
  const doc = ctx.doc;

  const features: FeatureSupport[] = [
    {
      feature: "document.html",
      label: "HTML document",
      level: "partial",
      occurrences: 1,
    },
    {
      feature: "document.metadata",
      label: "Document metadata",
      level: head.metadata.title || head.metadata.creator ? "full" : "partial",
      occurrences: 1,
    },
    {
      feature: "pageLayout.css",
      label: "Page setup from @page CSS",
      level: head.page ? "full" : "unsupported",
      occurrences: head.page ? 1 : 0,
    },
  ];
  for (const [feature, occurrences] of importer.features) {
    features.push({
      feature,
      label: featureLabel(feature),
      level: feature.startsWith("html.") ? "partial" : "full",
      occurrences,
    });
  }

  const losses = importer.losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "html",
    fileName: options.fileName,
    features,
    losses,
    unknownElements: losses
      .filter(
        (loss) =>
          loss.feature.startsWith("html.") || loss.feature.startsWith("css."),
      )
      .map((loss) => ({
        element: loss.feature,
        count: 1,
        location: loss.location,
      })),
  });
  return importResult(
    doc,
    losses,
    parsed.usedFallback
      ? ["HTML input was repaired by the tolerant scanner"]
      : [],
  );
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
    "block.quote": "Block quotes",
    "block.preformatted": "Preformatted blocks",
    "block.rule": "Horizontal rules",
    "lists.numbering": "Lists",
    table: "Tables",
    "table.mergedCells": "Merged table cells",
    "image.inline": "Inline images",
    "image.remote": "Remote images",
    hyperlink: "Hyperlinks",
    comment: "Comments",
    footnote: "Footnotes",
    endnote: "Endnotes",
    "footnote.reference": "Footnote references",
    "endnote.reference": "Endnote references",
    "revisions.insert": "Tracked insertions",
    "revisions.delete": "Tracked deletions",
    "html.block": "Container elements",
    "html.container": "Container elements",
    "html.formControl": "Form controls",
    "html.hidden": "Hidden elements",
    "css.stylesheet": "Style sheets",
  };
  return labels[feature] ?? feature;
}

/* --------------------------------------------------------------- exporter */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssFontFamily(family: string | undefined): string | undefined {
  if (!family) return undefined;
  const needsQuotes =
    /[^A-Za-z0-9\- ]/.test(family) || family.trim() !== family;
  return needsQuotes ? `"${family.replace(/"/g, "'")}"` : family;
}

function cssFromRunProps(props: RunProps): string {
  const parts: string[] = [];
  if (props.fontFamily)
    parts.push(`font-family:${cssFontFamily(props.fontFamily)}`);
  if (props.fontSize !== undefined)
    parts.push(`font-size:${round(props.fontSize)}pt`);
  if (props.color) parts.push(`color:${props.color}`);
  if (props.background) parts.push(`background-color:${props.background}`);
  if (props.charSpacing !== undefined && props.charSpacing !== 0)
    parts.push(`letter-spacing:${round(props.charSpacing)}pt`);
  if (props.caps) parts.push("text-transform:uppercase");
  if (props.smallCaps) parts.push("font-variant:small-caps");
  if (props.hidden) parts.push("display:none");
  return parts.join(";");
}

function cssFromParagraphProps(props: ParagraphProps): string {
  const parts: string[] = [];
  if (props.alignment && props.alignment !== "left")
    parts.push(
      `text-align:${props.alignment === "distribute" ? "justify" : props.alignment}`,
    );
  if (props.spaceBefore !== undefined && props.spaceBefore !== 0)
    parts.push(`margin-top:${round(props.spaceBefore)}pt`);
  if (props.spaceAfter !== undefined && props.spaceAfter !== 0)
    parts.push(`margin-bottom:${round(props.spaceAfter)}pt`);
  if (props.indent?.left !== undefined)
    parts.push(`margin-left:${round(props.indent.left)}pt`);
  if (props.indent?.right !== undefined)
    parts.push(`margin-right:${round(props.indent.right)}pt`);
  if (props.indent?.firstLine !== undefined)
    parts.push(`text-indent:${round(props.indent.firstLine)}pt`);
  if (props.indent?.hanging !== undefined)
    parts.push(`text-indent:-${round(props.indent.hanging)}pt`);
  if (props.pageBreakBefore) parts.push("page-break-before:always");
  if (props.lineSpacing?.rule === "auto")
    parts.push(`line-height:${round(props.lineSpacing.value / 240)}`);
  else if (props.lineSpacing)
    parts.push(`line-height:${round(props.lineSpacing.value)}pt`);
  if (props.bidi) parts.push("direction:rtl");
  const border = props.borders?.bottom;
  if (border && border.style !== "none") {
    parts.push(
      `border-bottom:${border.width > 0 ? round(border.width) : 1}pt ${border.style === "single" ? "solid" : border.style} ${border.color ?? "#000000"}`,
    );
  }
  return parts.join(";");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function cssFromStyleDef(doc: DocDocument, styleId: string): string {
  const style = doc.styles.styles[styleId];
  if (!style) return "";
  const resolvedRun = resolveRunProps(doc, {
    paragraphStyle: style.type === "paragraph" ? style.id : undefined,
    characterStyle: style.type === "character" ? style.id : undefined,
  });
  const parts: string[] = [];
  const runCss = cssFromRunProps(resolvedRun);
  if (runCss) parts.push(runCss);
  if (style.paragraph) {
    const paragraphCss = cssFromParagraphProps(style.paragraph);
    if (paragraphCss) parts.push(paragraphCss);
  }
  return parts.join(";");
}

class HtmlWriter {
  readonly losses = new LossCollector();
  private readonly noteOrder = new Map<
    string,
    { index: number; type: "footnote" | "endnote" }
  >();
  private readonly commentIds = new Set<string>();

  constructor(private readonly doc: DocDocument) {
    [...doc.footnotes].forEach((note, index) =>
      this.noteOrder.set(note.id, { index: index + 1, type: "footnote" }),
    );
    [...doc.endnotes].forEach((note, index) =>
      this.noteOrder.set(note.id, { index: index + 1, type: "endnote" }),
    );
    for (const comment of doc.comments) this.commentIds.add(comment.id);
  }

  stylesheet(): string {
    const rules: string[] = [];
    const page = this.doc.sections[0]?.page;
    if (page) {
      const size = `${round(page.width)}pt ${round(page.height)}pt`;
      const margin = `${round(page.margins.top)}pt ${round(page.margins.right)}pt ${round(page.margins.bottom)}pt ${round(page.margins.left)}pt`;
      rules.push(`@page { size: ${size}; margin: ${margin}; }`);
      if (page.pageColor)
        rules.push(`body { background-color: ${page.pageColor}; }`);
    }
    rules.push(
      "body { font-family: Calibri, Carlito, sans-serif; line-height: 1.15; margin: 0; }",
      "p, h1, h2, h3, h4, h5, h6 { margin: 0 0 8pt 0; }",
      "table.dsh-table { border-collapse: collapse; width: 100%; margin: 6pt 0; }",
      "table.dsh-table td, table.dsh-table th { border: 0.5pt solid #000000; padding: 2pt 4pt; vertical-align: top; }",
      "table.dsh-table th { font-weight: bold; background-color: #f2f2f2; }",
      "img.dsh-image { max-width: 100%; }",
      ".dsh-page-break { display: block; page-break-after: always; height: 0; }",
      ".dsh-footnotes, .dsh-endnotes { border-top: 0.5pt solid #999999; margin-top: 12pt; font-size: 9pt; }",
      ".dsh-comment { border-left: 2pt solid #f0b400; background: #fffbe6; padding: 4pt; margin: 6pt 0; font-size: 9pt; }",
      ".dsh-toc { border: 0.5pt dashed #999999; padding: 6pt; }",
    );
    const styleIds = Object.keys(this.doc.styles.styles).sort((a, b) =>
      a.localeCompare(b),
    );
    for (const styleId of styleIds) {
      const css = cssFromStyleDef(this.doc, styleId);
      if (!css) continue;
      rules.push(`.st-${cssClass(styleId)} { ${css}; }`);
    }
    return rules.join("\n");
  }

  body(): string {
    const out: string[] = [];
    if (this.doc.sections.length > 1) {
      this.losses.partial(
        "sections.flattened",
        "HTML has no multiple-section model: section breaks become page breaks and the document re-imports as one section",
        undefined,
        false,
      );
    }
    this.doc.sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) {
        out.push(
          `<div class="dsh-page-break" data-dsh-section-break="${escapeHtml(section.breakBefore)}"></div>`,
        );
        if (
          section.breakBefore === "oddPage" ||
          section.breakBefore === "evenPage"
        ) {
          this.losses.partial(
            `sectionBreak.${section.breakBefore}`,
            "HTML cannot express odd/even page section breaks; a plain page break is used",
            `section[${sectionIndex}]`,
            false,
          );
        }
        if (
          section.page.width !== this.doc.sections[0]?.page.width ||
          section.page.height !== this.doc.sections[0]?.page.height
        ) {
          this.losses.partial(
            "pageLayout.multiSection",
            "Per-section page sizes are not expressible in one HTML @page rule; the first section's geometry is used",
            `section[${sectionIndex}]`,
            false,
          );
        }
      }
      for (const block of section.blocks)
        out.push(this.block(block, sectionIndex));
      if (section.headers.default || section.footers.default) {
        this.losses.unsupported(
          "headerFooter",
          "HTML has no header/footer model; header and footer text is not emitted",
          `section[${sectionIndex}]`,
          false,
        );
      }
    });

    for (const comment of this.doc.comments) {
      out.push(this.commentAside(comment));
    }

    out.push(this.notesSection("footnote", this.doc.footnotes));
    out.push(this.notesSection("endnote", this.doc.endnotes));
    out.push(...this.shapeFallbacks());
    return out.filter((entry) => entry.length > 0).join("\n");
  }

  private block(block: Block, sectionIndex: number): string {
    if (block.type === "table") return this.table(block, sectionIndex);
    if (block.type === "toc") {
      // The block and its options round-trip; the cached entries (and their page
      // numbers) are regenerated by the layout engine instead of being stored.
      this.losses.partial(
        "toc",
        "Table of contents entries are regenerated by the layout engine; the cached entry text and page numbers are not stored",
        `section[${sectionIndex}]`,
        true,
      );
      return `<nav class="dsh-toc" data-toc-min-level="${block.minLevel}" data-toc-max-level="${block.maxLevel}" data-toc-hyperlinks="${block.hyperlinks}" data-toc-page-numbers="${block.pageNumbers}" data-toc-tab-leader="${block.tabLeader}" data-toc-include-title="${block.includeTitle === true}"></nav>`;
    }
    return this.paragraph(block, sectionIndex);
  }

  private paragraph(paragraph: Paragraph, sectionIndex: number): string {
    if (paragraph.style === "Code") {
      // Consecutive Code paragraphs were emitted as one fence by design; in HTML
      // each paragraph becomes its own pre block, which round-trips identically.
      this.losses.add({
        feature: "preformatted.perParagraph",
        level: "partial",
        reason:
          "Consecutive preformatted paragraphs are separate <pre> blocks in HTML",
        location: `section[${sectionIndex}].block:${paragraph.id}`,
        preserved: true,
      });
      return `<pre style="${escapeHtml(cssFromParagraphProps(paragraph.props))}">${this.inlineHtml(paragraph.inlines, paragraph, "pre")}</pre>`;
    }
    const headingLevel = headingLevelOfStyle(this.doc, paragraph.style);
    const tag =
      headingLevel !== undefined && headingLevel <= 6
        ? `h${headingLevel}`
        : "p";
    const classes: string[] = [];
    if (paragraph.style && paragraph.style !== "Normal")
      classes.push(`st-${cssClass(paragraph.style)}`);
    const style = cssFromParagraphProps(paragraph.props);
    const attrs: string[] = [];
    if (classes.length > 0) attrs.push(`class="${classes.join(" ")}"`);
    if (style) attrs.push(`style="${escapeHtml(style)}"`);
    const bookmark = paragraph.inlines.find(
      (inline) => inline.type === "bookmark" && inline.kind === "start",
    );
    if (bookmark && bookmark.type === "bookmark")
      attrs.push(`id="bm-${escapeHtml(bookmark.name)}"`);
    const numbering = paragraph.props.numbering;
    if (numbering) {
      attrs.push(
        `data-dsh-list="${escapeHtml(numbering.numId)}" data-dsh-level="${numbering.level}"`,
      );
    }
    const body = this.inlineHtml(
      paragraph.inlines,
      paragraph,
      tag === "pre" ? "pre" : "p",
    );
    return `<${tag}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>${body}</${tag}>`;
  }

  private inlineHtml(
    inlines: Inline[],
    paragraph: Paragraph,
    context: "p" | "pre",
  ): string {
    let out = "";
    let linkHref: string | undefined;
    let linkTitle: string | undefined;
    const closeLink = () => {
      if (linkHref !== undefined || linkTitle !== undefined) {
        out += "</a>";
        linkHref = undefined;
        linkTitle = undefined;
      }
    };
    for (const inline of inlines) {
      if (inline.type === "text") {
        const props = resolveRunProps(this.doc, {
          paragraphStyle: paragraph.style,
          characterStyle: inline.props.characterStyle,
          direct: inline.props,
        });
        const target = props.hyperlink;
        if (target) {
          const href =
            target.href ?? (target.anchor ? `#${target.anchor}` : undefined);
          if (href !== linkHref || target.tooltip !== linkTitle) {
            closeLink();
            linkHref = href;
            linkTitle = target.tooltip;
            out += `<a href="${escapeHtml(href ?? "")}"${target.tooltip ? ` title="${escapeHtml(target.tooltip)}"` : ""}>`;
          }
        } else {
          closeLink();
        }
        const text =
          context === "pre"
            ? escapeHtml(inline.text)
            : inlineTextHtml(inline.text);
        out += this.runWrapper(text, props, inline.props.revision);
        continue;
      }
      closeLink();
      out += this.inlineNode(inline, paragraph);
    }
    closeLink();
    return out;
  }

  private runWrapper(
    inner: string,
    props: RunProps,
    revision: RevisionMark | undefined,
  ): string {
    let html = inner;
    const style = cssFromRunProps(props);
    if (style) html = `<span style="${escapeHtml(style)}">${html}</span>`;
    if (props.vertAlign === "superscript") html = `<sup>${html}</sup>`;
    if (props.vertAlign === "subscript") html = `<sub>${html}</sub>`;
    if (props.underline) html = `<u>${html}</u>`;
    if (props.strike || props.doubleStrike) html = `<s>${html}</s>`;
    if (props.italic) html = `<em>${html}</em>`;
    if (props.bold) html = `<strong>${html}</strong>`;
    if (props.fontFamily === "Consolas" && !props.bold && !props.italic)
      html = `<code>${html}</code>`;
    if (revision?.kind === "insert") {
      html = `<ins data-author="${escapeHtml(revision.author ?? "")}" data-date="${escapeHtml(revision.date ?? "")}">${html}</ins>`;
    } else if (revision?.kind === "delete") {
      html = `<del data-author="${escapeHtml(revision.author ?? "")}" data-date="${escapeHtml(revision.date ?? "")}">${html}</del>`;
    } else if (revision) {
      this.losses.partial(
        "revisions.format",
        "Formatting revisions are flattened to their final formatting",
        undefined,
        false,
      );
    }
    return html;
  }

  private inlineNode(inline: Inline, paragraph: Paragraph): string {
    switch (inline.type) {
      case "tab":
        return `<span data-dsh-tab="1">\t</span>`;
      case "break":
        if (inline.kind === "page")
          return `<span class="dsh-page-break" data-dsh-break="page"></span>`;
        if (inline.kind === "column")
          return `<span class="dsh-page-break" data-dsh-break="column"></span>`;
        return "<br />";
      case "image": {
        const asset = this.doc.media.find(
          (entry) => entry.id === inline.mediaId,
        );
        if (!asset) {
          this.losses.unsupported(
            "image.missing",
            "Image refers to a media asset that is not in the document",
            `image:${inline.mediaId}`,
            false,
          );
          return `<span class="dsh-missing-image">${escapeHtml(inline.alt ?? "")}</span>`;
        }
        if (inline.anchor?.type === "floating") {
          this.losses.partial(
            "image.floating",
            "Floating image is emitted as an inline image",
            `image:${inline.mediaId}`,
            false,
          );
        }
        return `<img class="dsh-image" src="data:${escapeHtml(asset.contentType)};base64,${asset.data}" alt="${escapeHtml(inline.alt ?? "")}"${
          inline.title ? ` title="${escapeHtml(inline.title)}"` : ""
        } style="width:${round(inline.width)}pt;height:${round(inline.height)}pt" />`;
      }
      case "field": {
        this.losses.partial(
          "fields",
          "Field results are exported as cached text; HTML has no field model",
          `field:${inline.instr}`,
          false,
        );
        const text = (inline.result ?? [])
          .map((child) => this.simpleInlineText(child))
          .join("");
        return `<span class="dsh-field" data-instr="${escapeHtml(inline.instr)}">${escapeHtml(text)}</span>`;
      }
      case "noteRef": {
        const entry = this.noteOrder.get(inline.noteId);
        if (!entry) {
          this.losses.unsupported(
            "notes.reference",
            "Note reference has no matching note body",
            `note:${inline.noteId}`,
            false,
          );
          return "";
        }
        const marker =
          inline.noteType === "footnote"
            ? "dsh-footnote-ref"
            : "dsh-endnote-ref";
        return `<sup class="${marker}"><a href="#${escapeHtml(inline.noteId)}">${entry.index}</a></sup>`;
      }
      case "commentRef": {
        if (!this.commentIds.has(inline.commentId)) {
          this.losses.unsupported(
            "comment.missing",
            "Comment anchor has no matching comment",
            `comment:${inline.commentId}`,
            false,
          );
          return "";
        }
        const attribute =
          inline.kind === "rangeStart"
            ? "data-comment-start"
            : inline.kind === "rangeEnd"
              ? "data-comment-end"
              : "data-comment-ref";
        return `<span class="dsh-comment-ref" ${attribute}="${escapeHtml(inline.commentId)}"></span>`;
      }
      case "bookmark":
        return inline.kind === "start"
          ? `<a id="bm-${escapeHtml(inline.name)}"></a>`
          : "";
      case "math":
        this.losses.fallback(
          "math",
          "Equations are exported as linear text; HTML has no native math model in this adapter",
          undefined,
          false,
        );
        return `<span class="dsh-math">${escapeHtml(inline.linear)}</span>`;
      case "shape": {
        const shape = this.doc.shapes.find(
          (entry) => entry.id === inline.shapeId,
        );
        const text =
          shape && shape.kind === "textbox"
            ? blocksPlainText(shape.blocks)
            : "";
        this.losses.fallback(
          "shape",
          "Shapes are exported as their text content",
          `shape:${inline.shapeId}`,
          false,
        );
        return text ? `<span class="dsh-shape">${escapeHtml(text)}</span>` : "";
      }
      case "unknown":
        this.losses.fallback(
          "unknown.inline",
          "Uninterpreted inline element is exported as its text projection",
          inline.element,
          true,
        );
        return inline.text
          ? `<span class="dsh-unknown">${escapeHtml(inline.text)}</span>`
          : "";
      default:
        return "";
    }
  }

  private simpleInlineText(inline: Inline): string {
    if (inline.type === "text") return inline.text;
    if (inline.type === "tab") return "\t";
    if (inline.type === "break") return "\n";
    if (inline.type === "math") return inline.linear;
    if (inline.type === "field")
      return (inline.result ?? [])
        .map((child) => this.simpleInlineText(child))
        .join("");
    if (inline.type === "unknown") return inline.text ?? "";
    if (inline.type === "image") return inline.alt ?? "";
    return "";
  }

  private table(table: Table, sectionIndex: number): string {
    const rows = table.rows;
    const headerCount = rows.filter((row) => row.props.isHeader).length;
    const bodyRows = headerCount > 0 ? rows.slice(0, headerCount) : [];
    const dataRows = headerCount > 0 ? rows.slice(headerCount) : rows;
    const renderRows = (source: TableRow[], cellTag: "td" | "th"): string =>
      source
        .map((row) => {
          const cells: string[] = [];
          for (
            let cellIndex = 0;
            cellIndex < row.cells.length;
            cellIndex += 1
          ) {
            const cell = row.cells[cellIndex];
            if (cell.props.vMerge === "continue") {
              // A continuation cell is represented by the rowspan of its anchor.
              // If no earlier restart covers this column (e.g. the anchor row was
              // deleted) the cell must be emitted or its content would vanish.
              const anchored = rows
                .slice(0, rows.indexOf(row))
                .some(
                  (earlier) =>
                    earlier.cells[cellIndex]?.props.vMerge === "restart",
                );
              if (anchored) continue;
            }
            const gridSpan = cell.props.gridSpan ?? 1;
            let rowSpan = 1;
            if (cell.props.vMerge === "restart") {
              let scan = rows.indexOf(row) + 1;
              while (
                scan < rows.length &&
                rows[scan]?.cells[cellIndex]?.props.vMerge === "continue"
              ) {
                rowSpan += 1;
                scan += 1;
              }
            }
            const attrs: string[] = [];
            if (gridSpan > 1) attrs.push(`colspan="${gridSpan}"`);
            if (rowSpan > 1) attrs.push(`rowspan="${rowSpan}"`);
            const styleParts: string[] = [];
            const width = cell.props.width?.value;
            if (width !== undefined) styleParts.push(`width:${round(width)}pt`);
            if (cell.props.background?.fill)
              styleParts.push(`background-color:${cell.props.background.fill}`);
            if (cell.props.vAlign && cell.props.vAlign !== "top")
              styleParts.push(`vertical-align:${cell.props.vAlign}`);
            if (styleParts.length > 0)
              attrs.push(`style="${escapeHtml(styleParts.join(";"))}"`);
            const textParts: string[] = [];
            for (const block of cell.blocks) {
              if (block.type === "paragraph") {
                // Wrap each block paragraph so cell content round-trips as
                // separate paragraphs instead of one <br>-separated flow.
                textParts.push(this.paragraph(block, sectionIndex));
              } else if (block.type === "table") {
                textParts.push(this.table(block, sectionIndex));
              } else {
                textParts.push("");
              }
            }
            const content = textParts.join("");
            cells.push(
              `<${cellTag}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>${content}</${cellTag}>`,
            );
          }
          return `<tr>${cells.join("")}</tr>`;
        })
        .join("\n");
    if (table.props.borders === undefined) {
      this.losses.partial(
        "table.borders",
        "Table without explicit borders inherits the HTML style sheet default",
        undefined,
        false,
      );
    }
    const header =
      bodyRows.length > 0 ? `<thead>${renderRows(bodyRows, "th")}</thead>` : "";
    return `<table class="dsh-table" data-dsh-cells="${table.rows.length}">${header}<tbody>${renderRows(dataRows, "td")}</tbody></table>`;
  }

  private commentAside(comment: DocComment): string {
    const blocks = comment.blocks
      .map((block) =>
        block.type === "paragraph"
          ? `<p>${this.inlineHtml(block.inlines, block, "p")}</p>`
          : "",
      )
      .join("");
    return `<aside class="dsh-comment" data-comment-id="${escapeHtml(comment.id)}" data-author="${escapeHtml(comment.author)}"${
      comment.initials ? ` data-initials="${escapeHtml(comment.initials)}"` : ""
    }${comment.date ? ` data-date="${escapeHtml(comment.date)}"` : ""} data-resolved="${comment.resolved ? "true" : "false"}"${
      comment.parentId
        ? ` data-parent-id="${escapeHtml(comment.parentId)}"`
        : ""
    }>${blocks}</aside>`;
  }

  private notesSection(type: "footnote" | "endnote", notes: Note[]): string {
    if (notes.length === 0) return "";
    const className = type === "footnote" ? "dsh-footnotes" : "dsh-endnotes";
    const items = notes
      .map((note) => {
        const blocks = note.blocks
          .map((block) =>
            block.type === "paragraph"
              ? `<p>${this.inlineHtml(block.inlines, block, "p")}</p>`
              : "",
          )
          .join("");
        return `<li id="${escapeHtml(note.id)}">${blocks}</li>`;
      })
      .join("");
    return `<section class="${className}"><ol>${items}</ol></section>`;
  }

  private shapeFallbacks(): string[] {
    const out: string[] = [];
    for (const shape of this.doc.shapes) {
      const text = blocksPlainText(shape.blocks);
      if (text.trim().length > 0)
        out.push(`<div class="dsh-shape">${escapeHtml(text)}</div>`);
      this.losses.fallback(
        "shape.textBox",
        "Text boxes are exported as plain div blocks",
        `shape:${shape.id}`,
        false,
      );
    }
    return out;
  }
}

function styleDiffersFromParagraph(_family: string | undefined): boolean {
  // Unused: run CSS always carries the resolved family so the output is
  // independent of the reader's style-sheet cascade.
  return false;
}

function cssClass(styleId: string): string {
  return styleId.replace(/[^A-Za-z0-9_-]/g, "_");
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
                : "",
          )
          .join("");
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Exports a document as a self-contained HTML file.
 *
 * Styles are resolved into a `<style>` sheet (with `@page` geometry), images
 * become `data:` URIs, hyperlinks stay links, comments/footnotes/tracked
 * changes get explicit markers that `importHtml` understands, and constructs
 * HTML cannot express are reported as losses.
 */
export async function exportHtml(
  doc: DocDocument,
  options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  const writer = new HtmlWriter(doc);
  const title = doc.metadata.title ?? "Untitled document";
  const language = doc.settings.defaultLanguage ?? "en-US";
  const meta: string[] = [
    `<meta charset="utf-8" />`,
    `<meta name="generator" content="dsh-doc-editor" />`,
  ];
  if (doc.metadata.creator)
    meta.push(
      `<meta name="author" content="${escapeHtml(doc.metadata.creator)}" />`,
    );
  if (doc.metadata.description)
    meta.push(
      `<meta name="description" content="${escapeHtml(doc.metadata.description)}" />`,
    );
  if (doc.metadata.keywords.length > 0) {
    meta.push(
      `<meta name="keywords" content="${escapeHtml(doc.metadata.keywords.join(", "))}" />`,
    );
  }
  for (const [key, value] of Object.entries(doc.metadata.custom).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (value === undefined) continue;
    meta.push(
      `<meta name="${escapeHtml(key.startsWith("dsh-") ? key : `dsh-${key}`)}" content="${escapeHtml(value)}" />`,
    );
  }

  const body = writer.body();
  const html = [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtml(language)}">`,
    "<head>",
    `<title>${escapeHtml(title)}</title>`,
    ...meta,
    "<style>",
    writer.stylesheet(),
    "</style>",
    "</head>",
    // The marker lets this importer round-trip paragraph boundary whitespace
    // exactly instead of applying HTML's whitespace-collapsing rules.
    '<body data-dsh-whitespace="preserve">',
    body,
    "</body>",
    "</html>",
  ].join("\n");

  const losses = writer.losses.all();
  return { buffer: Buffer.from(html, "utf8"), warnings: [], losses };
}

/* ------------------------------------------------------------- descriptor */

const CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: true,
  styles: "partial",
  tables: "partial",
  images: "full",
  hyperlinks: "full",
  headersFooters: "none",
  pageLayout: "partial",
  numbering: "partial",
  metadata: "partial",
  comments: "partial",
  trackedChanges: "partial",
  math: "none",
  notes: [
    "Styles are mapped through CSS (font, size, colour, alignment, indents, spacing).",
    "Images are embedded as data: URIs; remote images are never fetched.",
    "Headers/footers are not part of the HTML body model and are reported as unsupported.",
    "Comments, footnotes and tracked changes use explicit DSH data attributes that round-trip.",
  ],
};

const HTML_EXTENSIONS = ["html", "htm", "xhtml"];

function htmlExtension(fileName?: string): string {
  const match = fileName ? /\.([A-Za-z0-9]+)$/.exec(fileName) : null;
  return match ? match[1].toLowerCase() : "";
}

/** HTML format descriptor. */
export const htmlAdapter: FormatAdapter = {
  id: "html",
  label: "HTML",
  extensions: HTML_EXTENSIONS,
  mimeTypes: ["text/html", "application/xhtml+xml"],
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    if (HTML_EXTENSIONS.includes(htmlExtension(fileName))) return true;
    const prefix = bytes
      .subarray(0, Math.min(bytes.length, 2048))
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    const head = prefix.trimStart();
    if (/^<!doctype\s+html/i.test(head)) return true;
    if (/^<html[\s>]/i.test(head)) return true;
    if (/^<\?xml[^>]*\?>\s*<(!doctype\s+html|html)[\s>]/i.test(head))
      return true;
    return /^<(body|div|p|h[1-6]|table|ul|ol|section|article|main|blockquote|pre)[\s>]/i.test(
      head,
    );
  },
  import: importHtml,
  export: exportHtml,
};
