/**
 * Apple Pages (.pages) importer.
 *
 * Two different containers share the `.pages` extension and this adapter
 * supports both, with very different guarantees:
 *
 *  - **Pages '09 (XML package)** — a ZIP with a root `index.xml` (plus
 *    QuickLook/Metadata siblings). Paragraphs are real `<sf:p>` elements, so
 *    document order, empty paragraphs, span-split runs and explicit line breaks
 *    are recovered faithfully, and headings are mapped *only* when a style name
 *    or an outline level actually says so. Elements that are not interpreted are
 *    reported as losses and recorded on the document instead of being dropped.
 *
 *  - **Pages 2013+ (IWA package)** — a ZIP with `Index/*.iwa` (plus
 *    `Metadata/*.plist`, `preview.jpg`). IWA is a framed Snappy-compressed
 *    protobuf stream with no public schema. This adapter decompresses the IWA
 *    frames (raw Snappy block decoder, 1/2/4-byte copy offsets) and scans the
 *    protobuf wire format generically for length-delimited byte strings that
 *    look like human prose. The result is an explicitly labelled **text
 *    recovery preview**: structure, styles, tables, images and layout are *not*
 *    reconstructed. `metadata.custom.DSHPreview` is set to `"true"` and a
 *    compatibility report lists the unrecovered facets.
 *
 * Export is not implemented: a Pages package is a proprietary template-driven
 * format and writing one back would claim fidelity this adapter cannot prove.
 */
import type { Element } from "@xmldom/xmldom";
import { readPackage } from "../docx/package.js";
import {
  attr,
  childElements,
  descendants,
  localNameOf,
  parseXml,
  textOf,
} from "../docx/xml.js";
import type { XmlDocument } from "../docx/xml.js";
import type { DocDocument, FeatureSupport, Inline } from "../model/types.js";
import {
  buildCompatibilityReport,
  createDocumentContext,
  importResult,
  LossCollector,
  makeParagraph,
  pushText,
  recordUnknown,
} from "./shared.js";
import { FormatError } from "./types.js";
import type {
  FormatAdapter,
  FormatCapabilities,
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

/* --------------------------------------------------------------- constants */

/** Namespace used by every element of a Pages '09 `index.xml`. */
const SF_NS = "http://developer.apple.com/namespaces/sf";

/** Largest `index.xml` parsed; real Pages '09 documents are far smaller. */
const MAX_INDEX_XML_BYTES = 64 * 1024 * 1024;

/** Upper bound on elements reported as unknown, so hostile input stays bounded. */
const MAX_UNKNOWN_ELEMENT_KINDS = 64;

/** Largest decompressed payload accepted for one IWA frame. */
const MAX_IWA_FRAME_BYTES = 64 * 1024 * 1024;

/** Total decompressed bytes scanned across every IWA file of one document. */
const MAX_IWA_TOTAL_BYTES = 128 * 1024 * 1024;

/** Stop scanning a single `.iwa` file after this many frames. */
const MAX_IWA_FRAMES_PER_FILE = 4096;

/** Total frames scanned across every `.iwa` file of one document. */
const MAX_IWA_FRAMES_TOTAL = 16384;

/** Protobuf recursion depth: top-level fields plus up to two nested messages. */
const MAX_PROTO_DEPTH = 2;

/** Nested length-delimited payloads larger than this are not re-parsed as messages. */
const MAX_NESTED_MESSAGE_BYTES = 1024 * 1024;

/** A recovered string is a paragraph candidate only inside these byte bounds. */
const MIN_PROSE_BYTES = 2;
const MAX_PROSE_BYTES = 4000;

/** Minimum share of printable characters for a byte string to count as prose. */
const MIN_PRINTABLE_RATIO = 0.9;

/**
 * Element names that are either interpreted directly or deliberately flattened.
 * Anything else inside the document body is reported as an unknown element.
 */
const TRANSPARENT_ELEMENTS = new Set([
  "document",
  "body",
  "section",
  "text",
  "p",
  "span",
  "br",
  "lnbr",
  "tab",
  "stylesheet",
  "styles",
  "style",
  "paragraphstyle",
  "pstyle",
  "name",
]);

/* ---------------------------------------------------------------- utilities */

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function extensionOf(fileName?: string): string {
  const match = fileName ? /\.([A-Za-z0-9]+)$/.exec(fileName) : null;
  return match ? match[1].toLowerCase() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : undefined;
}

function textInlines(text: string): Inline[] {
  const inlines: Inline[] = [];
  pushText(inlines, text, {});
  return inlines;
}

function previewMarker(doc: DocDocument): void {
  doc.metadata.custom.DSHPreview = "true";
}

/* --------------------------------------------------------- ZIP entry helpers */

/** `Index/*.iwa` entry paths, sorted so recovery order is deterministic. */
function iwaEntries(parts: Map<string, Buffer>): string[] {
  return [...parts.keys()]
    .filter(
      (path) =>
        path.startsWith("Index/") && path.toLowerCase().endsWith(".iwa"),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Bounded ZIP sniffing for `detect`: local file headers (and the trailing
 * central directory) carry the entry names, so the first and last chunk of the
 * file is enough to recognise a Pages container without unpacking the ZIP.
 */
function zipSniffText(bytes: Buffer): string {
  const head = bytes
    .subarray(0, Math.min(bytes.length, 1024 * 1024))
    .toString("latin1");
  if (bytes.length <= 1024 * 1024) return head;
  const tail = bytes
    .subarray(Math.max(0, bytes.length - 256 * 1024))
    .toString("latin1");
  return `${head}\n${tail}`;
}

function zipMentionsPages(bytes: Buffer): boolean {
  if (!isZip(bytes)) return false;
  const text = zipSniffText(bytes);
  if (text.includes("index.xml")) return true;
  return text.includes("Index/") && text.toLowerCase().includes(".iwa");
}

/* ------------------------------------------------------- Pages '09 (XML) */

function allElements(root: Element): Element[] {
  const out: Element[] = [];
  const visit = (node: Element) => {
    for (const child of childElements(node)) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function hasPagesNamespace(root: Element): boolean {
  if (root.namespaceURI === SF_NS) return true;
  return allElements(root).some((element) => element.namespaceURI === SF_NS);
}

function styleAttribute(node: Element, name: string): string | undefined {
  return (
    attr(node, SF_NS, name) ??
    attr(node, null, name) ??
    attr(node, null, `sf:${name}`)
  );
}

/**
 * Reads `id → name` pairs from the Pages '09 stylesheet. The XML dialect is not
 * documented, so both attribute styles and a nested `<sf:name>` child are
 * accepted; anything else simply does not contribute a mapping.
 */
function readStyleNames(root: Element): Map<string, string> {
  const names = new Map<string, string>();
  for (const element of allElements(root)) {
    const local = localNameOf(element);
    if (local !== "style" && local !== "paragraphstyle" && local !== "pstyle")
      continue;
    const id = styleAttribute(element, "id");
    if (!id) continue;
    const name = styleAttribute(element, "name");
    if (name) {
      names.set(id, name);
      continue;
    }
    const nameNode = childElements(element).find(
      (child) => localNameOf(child) === "name",
    );
    if (nameNode) {
      const text = textOf(nameNode).trim();
      if (text.length > 0) names.set(id, text);
    }
  }
  return names;
}

/**
 * Maps a style name or id to a document style, but only when the name itself
 * says "Title" or "Heading N". Nothing is inferred from position or formatting.
 */
function headingStyleFrom(value: string): string | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (/^title$/i.test(text)) return "Title";
  const heading = /(?:^|[^A-Za-z])heading[\s_-]*([1-9])/i.exec(text);
  if (heading) return `Heading${heading[1]}`;
  const short = /^h([1-9])$/i.exec(text);
  if (short) return `Heading${short[1]}`;
  return undefined;
}

/**
 * Resolves one paragraph's style from (in order) an explicit discoverable style
 * name/id and an outline-level attribute. Returns `Normal` when neither exists.
 */
function paragraphStyleName(
  node: Element,
  styleNames: Map<string, string>,
): string {
  const styleId = styleAttribute(node, "style");
  if (styleId) {
    const mapped = headingStyleFrom(styleNames.get(styleId) ?? styleId);
    if (mapped) return mapped;
  }
  for (const key of ["outline-level", "outlineLevel", "level"]) {
    const raw = styleAttribute(node, key);
    if (raw === undefined) continue;
    const level = Number(raw);
    if (Number.isInteger(level) && level >= 0 && level <= 8)
      return `Heading${Math.min(9, level + 1)}`;
  }
  return "Normal";
}

/** Flattens the text of one `<sf:p>`, keeping spans, tabs and line breaks. */
function paragraphInlines(node: Element): Inline[] {
  const inlines: Inline[] = [];
  const visit = (parent: Element) => {
    const nodes = parent.childNodes;
    for (let index = 0; index < nodes.length; index += 1) {
      const child = nodes.item(index);
      if (!child) continue;
      if (child.nodeType === 3 || child.nodeType === 4) {
        pushText(inlines, child.nodeValue ?? "", {});
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const local = localNameOf(element);
      if (local === "br" || local === "lnbr") {
        inlines.push({ type: "break", kind: "line" });
        continue;
      }
      if (local === "tab") {
        inlines.push({ type: "tab" });
        continue;
      }
      visit(element);
    }
  };
  visit(node);
  return inlines;
}

interface UnknownElementCount {
  element: string;
  count: number;
}

/**
 * Counts element names inside the document body that this importer does not
 * interpret. The stylesheet subtree is parsed separately and excluded.
 */
function collectUnknownElements(root: Element): UnknownElementCount[] {
  const counts = new Map<string, number>();
  const visit = (node: Element) => {
    for (const child of childElements(node)) {
      const local = localNameOf(child);
      if (local === "stylesheet" || local === "styles") continue;
      if (!TRANSPARENT_ELEMENTS.has(local)) {
        const name = child.nodeName || local;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      visit(child);
    }
  };
  visit(root);
  return [...counts.entries()]
    .slice(0, MAX_UNKNOWN_ELEMENT_KINDS)
    .map(([element, count]) => ({ element, count }));
}

function importPages09(
  parts: Map<string, Buffer>,
  options: FormatImportOptions,
): FormatImportResult {
  const xmlBytes = parts.get("index.xml");
  if (!xmlBytes)
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "Pages package is missing index.xml (Pages '09)",
    );
  if (xmlBytes.byteLength > MAX_INDEX_XML_BYTES)
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `Pages '09 index.xml is ${xmlBytes.byteLength} bytes, above the ${MAX_INDEX_XML_BYTES} byte limit`,
    );
  let xml = xmlBytes.toString("utf8");
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  // External entities are never resolved: a document that declares any is
  // refused outright rather than letting the parser expand entity payloads.
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml))
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "Pages '09 index.xml declares a DOCTYPE or entity; entity expansion and external resolution are not performed",
    );

  let document: XmlDocument;
  try {
    document = parseXml(xml, "index.xml");
  } catch (error) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Pages '09 index.xml is not well-formed XML: ${errorMessage(error)}`,
    );
  }
  const root = document.documentElement as Element | null;
  if (!root)
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Pages '09 index.xml has no document element",
    );
  if (!hasPagesNamespace(root))
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "index.xml is not a Pages '09 document (no Apple sf: namespace elements)",
    );

  const styleNames = readStyleNames(root);
  const paragraphNodes = descendants(root, "p");
  const sectionCount = descendants(root, "section").length;
  const losses = new LossCollector();
  const ctx = createDocumentContext({
    metadata: { title: titleFromFileName(options.fileName) },
  });

  let headings = 0;
  for (const node of paragraphNodes) {
    const style = paragraphStyleName(node, styleNames);
    if (style !== "Normal") headings += 1;
    ctx.blocks.push(makeParagraph(ctx, paragraphInlines(node), { style }));
  }
  if (paragraphNodes.length === 0) {
    losses.partial(
      "pages09.paragraph",
      "index.xml contains no sf:p paragraph elements",
      "index.xml",
      false,
    );
    ctx.blocks.push(makeParagraph(ctx, []));
  }

  losses.unsupported(
    "pages09.characterFormatting",
    "Run formatting (fonts, sizes, colours, bold/italic) is not parsed from index.xml",
    "index.xml",
    false,
  );
  if (sectionCount > 0) {
    losses.unsupported(
      "pages09.pageLayout",
      "Sections, page size, margins and column layout are not imported; paragraphs are flattened into one section",
      "index.xml",
      false,
    );
  }
  if (headings > 0) {
    losses.partial(
      "pages09.heading",
      "Heading levels are inferred from discoverable style names or outline levels; template formatting is not imported",
      "index.xml",
      false,
    );
  }

  const unknown = collectUnknownElements(root);
  for (const entry of unknown) {
    losses.unsupported(
      "pages09.unknownElement",
      `Unrecognized Pages element ${entry.element} is not interpreted; its structure is not represented`,
      `index.xml:${entry.element}`,
      false,
    );
    recordUnknown(ctx.doc, ctx.next("unknown"), {
      location: "index.xml",
      element: entry.element,
      reason:
        "Unrecognized Pages '09 element; its structure is not represented in the document model",
    });
  }

  ctx.syncIds();
  const doc = ctx.doc;
  const features: FeatureSupport[] = [
    {
      feature: "document.pages09",
      label: "Pages '09 XML package",
      level: "partial",
      occurrences: 1,
      notes:
        "Paragraph text and discoverable headings only; sections, styles, tables and images are not reconstructed",
    },
    {
      feature: "paragraph.text",
      label: "Paragraph text",
      level: "full",
      occurrences: paragraphNodes.length,
    },
    {
      feature: "heading",
      label: "Headings from style names or outline levels",
      level: headings > 0 ? "partial" : "full",
      occurrences: headings,
    },
    {
      feature: "pageLayout",
      label: "Section and page layout",
      level: "unsupported",
      occurrences: sectionCount,
    },
  ];
  const lossesList = losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "pages",
    fileName: options.fileName,
    features,
    losses: lossesList,
    unknownElements: unknown,
  });
  return importResult(doc, lossesList, [
    "Pages '09 import: paragraph text and discoverable headings only; run formatting, page layout, tables and images are reported as losses.",
  ]);
}

/* ---------------------------------------------------------- Snappy codec */

interface Varint {
  value: number;
  next: number;
}

function readVarint(bytes: Buffer, offset: number): Varint | undefined {
  let value = 0;
  let shift = 0;
  let position = offset;
  while (position < bytes.length) {
    const byte = bytes[position];
    position += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: position };
    shift += 7;
    if (shift > 49) return undefined;
  }
  return undefined;
}

/**
 * Raw Snappy **block** decompressor (no stream framing): varint uncompressed
 * length followed by literal and copy tags. Copies support 1-, 2- and 4-byte
 * offsets and may overlap, so they are expanded byte by byte.
 *
 * Exported for tests; IWA frames are the only in-repo caller.
 *
 * @throws Error when the stream is truncated, the declared length is exceeded
 * or a copy offset is invalid. The caller decides how to report that per frame.
 */
export function snappyDecompress(input: Buffer): Buffer {
  const header = readVarint(input, 0);
  if (!header) throw new Error("Snappy stream has no complete length header");
  const expected = header.value;
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected > MAX_IWA_FRAME_BYTES
  ) {
    throw new Error(
      `Snappy declares ${expected} uncompressed bytes, above the ${MAX_IWA_FRAME_BYTES} byte limit`,
    );
  }
  const output = Buffer.alloc(expected);
  let position = header.next;
  let written = 0;
  while (position < input.length) {
    const tag = input[position];
    position += 1;
    const type = tag & 0x03;
    if (type === 0) {
      let length = tag >> 2;
      if (length < 60) {
        length += 1;
      } else {
        const extraBytes = length - 59;
        if (position + extraBytes > input.length)
          throw new Error("Snappy literal length is truncated");
        let value = 0;
        for (let index = 0; index < extraBytes; index += 1)
          value += input[position + index] * 2 ** (8 * index);
        position += extraBytes;
        length = value + 1;
      }
      if (position + length > input.length)
        throw new Error("Snappy literal is truncated");
      if (written + length > output.length)
        throw new Error("Snappy literal overruns the declared length");
      input.copy(output, written, position, position + length);
      position += length;
      written += length;
      continue;
    }

    let length: number;
    let offset: number;
    if (type === 1) {
      if (position >= input.length)
        throw new Error("Snappy one-byte copy is truncated");
      length = 4 + ((tag >> 2) & 0x07);
      offset = ((tag >> 5) & 0x07) * 256 + input[position];
      position += 1;
    } else if (type === 2) {
      if (position + 2 > input.length)
        throw new Error("Snappy two-byte copy is truncated");
      length = 1 + (tag >> 2);
      offset = input.readUInt16LE(position);
      position += 2;
    } else {
      if (position + 4 > input.length)
        throw new Error("Snappy four-byte copy is truncated");
      length = 1 + (tag >> 2);
      offset = input.readUInt32LE(position);
      position += 4;
    }
    if (offset === 0 || offset > written)
      throw new Error(`Snappy copy offset ${offset} is invalid`);
    if (written + length > output.length)
      throw new Error("Snappy copy overruns the declared length");
    for (let index = 0; index < length; index += 1) {
      output[written] = output[written - offset];
      written += 1;
    }
  }
  if (written !== output.length)
    throw new Error(
      `Snappy stream ended after ${written} of ${output.length} bytes`,
    );
  return output;
}

/* ------------------------------------------------------ IWA frame scanning */

interface ScanBudget {
  bytes: number;
  frames: number;
}

/**
 * Decodes every frame of one `.iwa` file and appends recovered prose to `out`
 * immediately, so a decompressed frame is never retained after it is scanned.
 * Returns the number of frames decoded.
 */
function scanIwaFile(
  path: string,
  bytes: Buffer,
  losses: LossCollector,
  budget: ScanBudget,
  out: string[],
): number {
  let frames = 0;
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) {
      losses.partial(
        "pages.iwaFrame",
        "Trailing bytes are too short for an IWA frame header",
        path,
        false,
      );
      break;
    }
    const control = bytes[offset];
    const length =
      bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16);
    const start = offset + 4;
    if (length === 0 || start + length > bytes.length) {
      losses.partial(
        "pages.iwaFrame",
        `IWA frame ${index + 1} declares ${length} payload bytes but ${bytes.length - start} remain`,
        path,
        false,
      );
      break;
    }
    const payload = bytes.subarray(start, start + length);
    offset = start + length;
    index += 1;
    if (index > MAX_IWA_FRAMES_PER_FILE) {
      losses.unsupported(
        "pages.iwaLimit",
        `Only the first ${MAX_IWA_FRAMES_PER_FILE} IWA frames of a file are scanned`,
        path,
        false,
      );
      break;
    }
    if (budget.frames <= 0) {
      losses.unsupported(
        "pages.iwaLimit",
        `Only the first ${MAX_IWA_FRAMES_TOTAL} IWA frames of the document are scanned`,
        path,
        false,
      );
      break;
    }
    budget.frames -= 1;

    let data: Buffer | undefined;
    if (control === 0x01) {
      data = payload;
    } else if (control === 0x00) {
      try {
        data = snappyDecompress(payload);
      } catch (error) {
        losses.partial(
          "pages.iwaFrame",
          `IWA frame ${index} could not be decompressed: ${errorMessage(error)}`,
          path,
          false,
        );
        continue;
      }
    } else {
      losses.partial(
        "pages.iwaFrame",
        `Unsupported IWA frame control byte 0x${control.toString(16).padStart(2, "0")}`,
        path,
        false,
      );
      continue;
    }
    frames += 1;
    if (data.length === 0) continue;
    if (data.length > budget.bytes) {
      losses.unsupported(
        "pages.iwaLimit",
        "Decompressed IWA data exceeds the scan budget; remaining frames are skipped",
        path,
        false,
      );
      budget.bytes = 0;
      break;
    }
    budget.bytes -= data.length;
    scanMessage(data, 0, out);
  }
  return frames;
}

/* ------------------------------------------------------- protobuf scanning */

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const METADATA_PREFIXES = ["com.apple.", "TSStyle", "TSWP", "TST", "TSA"];
const METADATA_TOKENS = ["protobuf", "sffnt", "PKB"];

/** True for iWork type/style/font identifiers that only look like prose. */
function isMetadataToken(text: string): boolean {
  for (const prefix of METADATA_PREFIXES)
    if (text.startsWith(prefix)) return true;
  for (const token of METADATA_TOKENS) if (text.includes(token)) return true;
  return false;
}

/**
 * Decodes one length-delimited protobuf payload as a human-readable string.
 * Accepts valid UTF-8 of 2..4000 bytes with no control characters other than
 * tab/newline, a printable ratio of at least 90%, at least one letter, and no
 * iWork metadata token. Returns `undefined` for anything else.
 */
function proseFromBytes(bytes: Buffer): string | undefined {
  if (bytes.length < MIN_PROSE_BYTES || bytes.length > MAX_PROSE_BYTES)
    return undefined;
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
  if (text.length < MIN_PROSE_BYTES) return undefined;

  let characters = 0;
  let printable = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    characters += 1;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))
      return undefined;
    printable += 1;
  }
  if (characters === 0 || printable / characters < MIN_PRINTABLE_RATIO)
    return undefined;
  if (!/\p{L}/u.test(text)) return undefined;
  if (isMetadataToken(text)) return undefined;
  return text;
}

/**
 * Scans one protobuf message for prose strings. Only length-delimited fields
 * can carry text; nested messages are re-scanned up to `MAX_PROTO_DEPTH`.
 * Malformed wire data ends the scan of that message instead of throwing.
 */
function scanMessage(bytes: Buffer, depth: number, out: string[]): void {
  let position = 0;
  while (position < bytes.length) {
    const key = readVarint(bytes, position);
    if (!key) return;
    position = key.next;
    if (Math.floor(key.value / 8) === 0) return; // field number 0 is invalid
    const wireType = key.value % 8;
    if (wireType === 0) {
      const value = readVarint(bytes, position);
      if (!value) return;
      position = value.next;
      continue;
    }
    if (wireType === 1) {
      if (position + 8 > bytes.length) return;
      position += 8;
      continue;
    }
    if (wireType === 5) {
      if (position + 4 > bytes.length) return;
      position += 4;
      continue;
    }
    if (wireType !== 2) return; // groups (3/4) and unknown types: stop this message
    const length = readVarint(bytes, position);
    if (!length) return;
    position = length.next;
    if (length.value < 0 || length.value > bytes.length - position) return;
    if (length.value === 0) continue;
    const payload = bytes.subarray(position, position + length.value);
    position += length.value;
    const prose = proseFromBytes(payload);
    if (prose !== undefined) {
      out.push(prose);
      continue;
    }
    if (
      depth < MAX_PROTO_DEPTH &&
      payload.length >= MIN_PROSE_BYTES &&
      payload.length <= MAX_NESTED_MESSAGE_BYTES
    ) {
      scanMessage(payload, depth + 1, out);
    }
  }
}

/* ------------------------------------------------------ modern Pages (IWA) */

function importPagesIwa(
  parts: Map<string, Buffer>,
  options: FormatImportOptions,
): FormatImportResult {
  const losses = new LossCollector();
  const budget: ScanBudget = {
    bytes: MAX_IWA_TOTAL_BYTES,
    frames: MAX_IWA_FRAMES_TOTAL,
  };
  const strings: string[] = [];
  let frameCount = 0;
  for (const path of iwaEntries(parts)) {
    const bytes = parts.get(path);
    if (!bytes) continue;
    frameCount += scanIwaFile(path, bytes, losses, budget, strings);
    if (budget.frames <= 0 || budget.bytes <= 0) break;
  }

  const ctx = createDocumentContext({
    metadata: {
      title: titleFromFileName(options.fileName) ?? "Pages preview",
      custom: { DSHPreview: "true" },
    },
  });

  let paragraphCount = 0;
  let previous = "";
  for (const text of strings) {
    // Consecutive identical strings repeat the same stored text run.
    if (text === previous) continue;
    previous = text;
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      ctx.blocks.push(makeParagraph(ctx, textInlines(line)));
      paragraphCount += 1;
    }
  }
  if (paragraphCount === 0) {
    losses.partial(
      "pages.text",
      "No human-readable text strings were recovered from the IWA protobuf payload",
      "Index/",
      false,
    );
    ctx.blocks.push(makeParagraph(ctx, []));
  }

  losses.unsupported(
    "pages.structure",
    "Modern Pages (IWA) import recovers text strings only; document structure is not reconstructed",
    "Index/",
    false,
  );
  losses.unsupported(
    "pages.styles",
    "Paragraph and character styles are not recovered from the IWA protobuf stream",
    "Index/",
    false,
  );
  losses.unsupported(
    "pages.tables",
    "Tables are not recovered from the IWA protobuf stream",
    "Index/",
    false,
  );
  losses.unsupported(
    "pages.images",
    "Images, shapes and other media are not recovered from the IWA protobuf stream",
    "Index/",
    false,
  );
  losses.unsupported(
    "pages.layout",
    "Page layout, sections, headers, footers and text frames are not recovered",
    "Index/",
    false,
  );

  ctx.syncIds();
  const doc = ctx.doc;
  previewMarker(doc);

  const features: FeatureSupport[] = [
    {
      feature: "preview.only",
      label: "Text-recovery preview",
      level: "partial",
      occurrences: 1,
      notes:
        "Modern Pages documents are projected into a read-only text preview; they are not a Pages editor",
    },
    {
      feature: "pages.text",
      label: "Recovered text strings",
      level: "partial",
      occurrences: paragraphCount,
    },
    {
      feature: "pages.iwaFrame",
      label: "IWA frames decoded",
      level: "full",
      occurrences: frameCount,
    },
    {
      feature: "pages.structure",
      label: "Document structure",
      level: "unsupported",
      occurrences: 0,
    },
    {
      feature: "pages.styles",
      label: "Styles",
      level: "unsupported",
      occurrences: 0,
    },
    {
      feature: "pages.tables",
      label: "Tables",
      level: "unsupported",
      occurrences: 0,
    },
    {
      feature: "pages.images",
      label: "Images and shapes",
      level: "unsupported",
      occurrences: 0,
    },
    {
      feature: "pages.layout",
      label: "Page layout",
      level: "unsupported",
      occurrences: 0,
    },
  ];
  const lossesList = losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "pages",
    fileName: options.fileName,
    features,
    losses: lossesList,
    unknownElements: [],
  });
  return importResult(doc, lossesList, [
    "Modern Pages text-recovery preview: text strings only. Structure, styles, tables, images and layout are not recovered.",
  ]);
}

/* ------------------------------------------------------------------ import */

/**
 * Imports a `.pages` package.
 *
 * @throws FormatError `FORMAT_TOO_LARGE` above `maxBytes`,
 * `FORMAT_INVALID_INPUT` when the bytes are not a readable ZIP, and
 * `FORMAT_UNSUPPORTED_CONTAINER` when the archive has neither `index.xml`
 * (Pages '09) nor `Index/*.iwa` (Pages 2013+).
 */
export async function importPages(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `Pages input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  if (!isZip(buffer)) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Pages input is not a ZIP package",
    );
  }
  let parts: Map<string, Buffer>;
  try {
    const pkg = await readPackage(buffer);
    if (pkg.isEncrypted) {
      throw new FormatError(
        "FORMAT_UNSUPPORTED_CONTAINER",
        "Password-protected Pages packages are not supported",
      );
    }
    parts = pkg.parts;
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Pages package could not be read: ${errorMessage(error)}`,
    );
  }

  if (parts.has("index.xml")) return importPages09(parts, options);
  if (iwaEntries(parts).length > 0) return importPagesIwa(parts, options);
  throw new FormatError(
    "FORMAT_UNSUPPORTED_CONTAINER",
    "Not a Pages package: the archive has neither index.xml (Pages '09) nor Index/*.iwa (Pages 2013+)",
  );
}

/* ------------------------------------------------------------- descriptor */

const PAGES_CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: false,
  styles: "partial",
  tables: "none",
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
    "Read-only: Pages packages are imported as a text projection and never written back.",
    "Pages '09 (index.xml): paragraph text, empty paragraphs, span/line-break text and discoverable headings; unknown elements are reported as losses.",
    "Modern Pages (IWA): text-recovery preview only — structure, styles, tables, images and layout are not recovered; DSHPreview is set on imported documents.",
  ],
};

const PAGES_EXTENSIONS = ["pages"];

/** Apple Pages format descriptor (import only). */
export const pagesAdapter: FormatAdapter = {
  id: "pages",
  label: "Apple Pages",
  extensions: PAGES_EXTENSIONS,
  mimeTypes: ["application/x-iwork-pages-sffpages"],
  readOnly: true,
  capabilities: PAGES_CAPABILITIES,
  detect(bytes, fileName) {
    if (PAGES_EXTENSIONS.includes(extensionOf(fileName))) return true;
    return zipMentionsPages(bytes);
  },
  import: importPages,
};
