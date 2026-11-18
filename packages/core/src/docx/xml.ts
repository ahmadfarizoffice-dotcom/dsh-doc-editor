/**
 * Thin XML helpers over @xmldom/xmldom for OOXML parts, plus a string builder
 * used by exporters (generating XML text is far more predictable than
 * round-tripping namespace-aware DOM mutation).
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element, Node } from "@xmldom/xmldom";

export type XmlDocument = Document;
export type XmlElement = Element;
export type XmlNode = Node;

export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  v: "urn:schemas-microsoft-com:vml",
  o: "urn:schemas-microsoft-com:office:office",
  w10: "urn:schemas-microsoft-com:office:word",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  wp14: "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
  xml: "http://www.w3.org/XML/1998/namespace",
  cp: "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
} as const;

export interface XmlParseIssue {
  message: string;
  fatal: boolean;
}

export function parseXml(source: string, label = "xml"): XmlDocument {
  const issues: XmlParseIssue[] = [];
  const parser = new DOMParser({
    onError: (level: string, message: string) => {
      issues.push({
        message: `${label}: ${message}`,
        fatal: level === "fatalError",
      });
    },
  });
  const doc = parser.parseFromString(source, "text/xml") as XmlDocument;
  const fatal = issues.find((issue) => issue.fatal);
  if (fatal) throw new Error(fatal.message);
  const parserErrors = doc.getElementsByTagName("parsererror");
  if (parserErrors.length > 0) {
    throw new Error(
      `${label}: ${parserErrors.item(0)?.textContent ?? "XML parse error"}`,
    );
  }
  return doc;
}

export function serializeXml(node: XmlNode): string {
  return new XMLSerializer().serializeToString(node);
}

/** Direct child elements (skips text/comments). */
export function childElements(
  parent: XmlNode | null | undefined,
): XmlElement[] {
  if (!parent) return [];
  const out: XmlElement[] = [];
  const nodes = parent.childNodes;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    if (node && node.nodeType === 1) out.push(node as XmlElement);
  }
  return out;
}

export function localNameOf(node: XmlNode): string {
  return node.localName ?? node.nodeName.split(":").pop() ?? node.nodeName;
}

/** First child element matching namespace + local name. */
export function first(
  parent: XmlNode | null | undefined,
  ns: string,
  name: string,
): XmlElement | undefined {
  return childElements(parent).find(
    (element) => localNameOf(element) === name && element.namespaceURI === ns,
  );
}

/** All child elements matching namespace + local name. */
export function all(
  parent: XmlNode | null | undefined,
  ns: string,
  name: string,
): XmlElement[] {
  return childElements(parent).filter(
    (element) => localNameOf(element) === name && element.namespaceURI === ns,
  );
}

/** Every descendant element with the local name, regardless of namespace. */
export function descendants(
  parent: XmlNode | null | undefined,
  name: string,
): XmlElement[] {
  if (!parent) return [];
  const out: XmlElement[] = [];
  const walk = (node: XmlNode) => {
    for (const element of childElements(node)) {
      if (localNameOf(element) === name) out.push(element);
      walk(element);
    }
  };
  walk(parent);
  return out;
}

export function attr(
  node: XmlElement | null | undefined,
  ns: string | null,
  name: string,
): string | undefined {
  if (!node) return undefined;
  const value = ns ? node.getAttributeNS(ns, name) : node.getAttribute(name);
  if (value === null || value === undefined) return undefined;
  return value;
}

/** Attribute in the WordprocessingML namespace (the common case). */
export function wAttr(
  node: XmlElement | null | undefined,
  name: string,
): string | undefined {
  return attr(node, NS.w, name);
}

/** `w:val` attribute ("" when the attribute is present but empty). */
export function wVal(node: XmlElement | null | undefined): string | undefined {
  return wAttr(node, "val");
}

/** Boolean OOXML property: element present without w:val means true. */
export function onOff(
  node: XmlElement | null | undefined,
): boolean | undefined {
  if (!node) return undefined;
  const value = wVal(node);
  if (value === undefined) return true;
  return value === "1" || value === "true" || value === "on";
}

export function textOf(node: XmlNode | null | undefined): string {
  if (!node) return "";
  return node.textContent ?? "";
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type XmlAttrs = Record<
  string,
  string | number | boolean | undefined | null
>;

function renderAttrs(attrs?: XmlAttrs): string {
  if (!attrs) return "";
  let out = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    const encoded =
      typeof value === "string" ? escapeXml(value) : String(value);
    out += ` ${key}="${encoded}"`;
  }
  return out;
}

/**
 * Minimal streaming XML builder with balanced-element validation.
 * Self-closing tags are emitted for empty elements, keeping generated OOXML
 * compact.
 */
export class XmlBuilder {
  private readonly stack: string[] = [];
  private buffer = "";

  declaration(): this {
    this.buffer += '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    return this;
  }

  open(name: string, attrs?: XmlAttrs): this {
    this.buffer += `<${name}${renderAttrs(attrs)}>`;
    this.stack.push(name);
    return this;
  }

  close(name?: string): this {
    const expected = name ?? this.stack[this.stack.length - 1];
    const actual = this.stack.pop();
    if (!actual) throw new Error("XmlBuilder.close() without open()");
    if (name && actual !== name) {
      throw new Error(`XmlBuilder.close(${name}) closes <${actual}>`);
    }
    this.buffer += `</${actual}>`;
    return this;
  }

  leaf(name: string, attrs?: XmlAttrs, text?: string): this {
    if (text === undefined) {
      this.buffer += `<${name}${renderAttrs(attrs)}/>`;
      return this;
    }
    this.buffer += `<${name}${renderAttrs(attrs)}>${escapeXml(text)}</${name}>`;
    return this;
  }

  text(value: string): this {
    this.buffer += escapeXml(value);
    return this;
  }

  /** Inserts pre-serialized XML verbatim (used to preserve unknown constructs). */
  raw(xml: string): this {
    this.buffer += xml;
    return this;
  }

  get depth(): number {
    return this.stack.length;
  }

  toString(): string {
    if (this.stack.length > 0) {
      throw new Error(
        `XmlBuilder has ${this.stack.length} unclosed element(s): ${this.stack.join(",")}`,
      );
    }
    return this.buffer;
  }
}
