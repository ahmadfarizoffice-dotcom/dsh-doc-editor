/**
 * Plain text adapter.
 *
 * A text document has no structure beyond paragraph boundaries and form-feed
 * page breaks, so this adapter deliberately detects nothing else. It exists so
 * every conversion target has a guaranteed representation and so `TXT`
 * round-trips are byte-comparable in terms of visible text.
 */
import { blockText, documentText } from "../model/text.js";
import type {
  Block,
  DocDocument,
  FeatureSupport,
  Inline,
} from "../model/types.js";
import {
  buildCompatibilityReport,
  createDocumentContext,
  importResult,
  LossCollector,
  makeParagraph,
  pushText,
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

const CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: true,
  styles: "none",
  tables: "none",
  images: "none",
  hyperlinks: "none",
  headersFooters: "none",
  pageLayout: "none",
  numbering: "none",
  metadata: "partial",
  comments: "none",
  trackedChanges: "none",
  math: "partial",
  notes: [
    "Paragraph = line. Blank lines become empty paragraphs.",
    "Form feed (\\f) marks a page break.",
    "Tables are flattened to tab-separated rows.",
  ],
};

function decodeText(bytes: Buffer, maxBytes: number): string {
  if (bytes.byteLength > maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `Text input is ${bytes.byteLength} bytes, above the ${maxBytes} byte limit`,
    );
  }
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Imports plain text: one paragraph per line, `\f` starts a page break, and
 * every other control character is kept verbatim in the paragraph text.
 */
export async function importText(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = decodeText(buffer, options.maxBytes ?? 64 * 1024 * 1024);
  const ctx = createDocumentContext({
    metadata: { title: titleFromName(options.fileName) },
  });
  const losses = new LossCollector();

  const pages = text.split("\f");
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) {
      const breakParagraph = makeParagraph(ctx, [
        { type: "break", kind: "page" },
      ]);
      ctx.blocks.push(breakParagraph);
    }
    const lines = page.split("\n");
    // A trailing separator does not create a trailing empty paragraph.
    if (
      lines.length > 0 &&
      lines[lines.length - 1] === "" &&
      pageIndex === pages.length - 1
    ) {
      lines.pop();
    }
    for (const line of lines) {
      const inlines: Inline[] = [];
      pushText(inlines, line, {});
      ctx.blocks.push(makeParagraph(ctx, inlines));
    }
  });

  ctx.syncIds();
  const doc = ctx.doc;
  const features: FeatureSupport[] = [
    {
      feature: "paragraph.text",
      label: "Paragraphs",
      level: "full",
      occurrences: doc.sections[0].blocks.length,
    },
    {
      feature: "pageBreak",
      label: "Page breaks (form feed)",
      level: "full",
      occurrences: Math.max(0, pages.length - 1),
    },
    {
      feature: "document.metadata",
      label: "Title from file name",
      level: "partial",
      occurrences: 1,
    },
  ];
  doc.compatibility = buildCompatibilityReport({
    format: "text",
    fileName: options.fileName,
    features,
    losses: losses.all(),
    unknownElements: [],
  });
  return importResult(doc, losses.all(), []);
}

function titleFromName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : undefined;
}

/** Renders the document as plain text; sections are separated by form feeds. */
export async function exportText(
  doc: DocDocument,
  _options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  const losses = new LossCollector();
  const parts: string[] = [];
  let tables = 0;
  let images = 0;
  let comments = 0;
  let headers = 0;
  let numbering = 0;

  doc.sections.forEach((section, index) => {
    if (index > 0) {
      parts.push(section.breakBefore === "continuous" ? "\n" : "\f");
    }
    const blocks: Block[] = section.blocks;
    parts.push(
      blocks
        .map((block) =>
          blockText(block, { includeTables: true, mode: "final" }),
        )
        .join("\n"),
    );
    if (section.headers.default || section.footers.default) headers += 1;
  });

  for (const block of doc.sections.flatMap((section) => section.blocks)) {
    if (block.type === "table") tables += 1;
    if (block.type === "paragraph") {
      for (const inline of block.inlines) {
        if (inline.type === "image") images += 1;
        if (inline.type === "commentRef") comments += 1;
        if (inline.type === "noteRef") comments += 1;
      }
      if (block.props.numbering?.numId) numbering += 1;
    }
  }

  if (tables > 0) {
    losses.partial(
      "table.layout",
      "Tables are flattened to tab-separated rows; borders and cell spans are lost",
      undefined,
      false,
    );
  }
  if (images > 0) {
    losses.unsupported(
      "image",
      "Plain text cannot carry images; the object marker is kept",
      undefined,
      false,
    );
  }
  if (comments > 0) {
    losses.partial(
      "annotation",
      "Comment and note anchors collapse to their text",
      undefined,
      false,
    );
  }
  if (headers > 0) {
    losses.unsupported(
      "headerFooter",
      "Headers and footers are not part of the plain text body",
      undefined,
      false,
    );
  }
  if (numbering > 0) {
    losses.partial(
      "numbering",
      "List labels are not materialised in plain text",
      undefined,
      false,
    );
  }

  const notes = [...doc.footnotes, ...doc.endnotes];
  if (notes.length > 0) {
    parts.push("");
    parts.push(
      ...notes.map(
        (note) =>
          `${note.type === "footnote" ? "Footnote" : "Endnote"}: ${documentText(
            {
              ...doc,
              sections: [{ ...doc.sections[0], blocks: note.blocks }],
              footnotes: [],
              endnotes: [],
              shapes: [],
            },
          )}`,
      ),
    );
    losses.partial(
      "notes",
      "Note text is appended after the body; reference numbers are not preserved",
      undefined,
      false,
    );
  }

  const text = parts.join("\n");
  return {
    buffer: Buffer.from(text, "utf8"),
    warnings: [],
    losses: losses.all(),
  };
}

/** Plain-text adapter descriptor. */
export const textAdapter: FormatAdapter = {
  id: "text",
  label: "Plain text",
  extensions: ["txt", "text", "log"],
  mimeTypes: ["text/plain"],
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    if (extensionOf(fileName) === "txt" || extensionOf(fileName) === "text")
      return true;
    // Text is the fallback: accept printable UTF-8 without binary markers.
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === 0) return false;
      if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b))
        return false;
    }
    return true;
  },
  import: importText,
  export: exportText,
};

function extensionOf(fileName?: string): string {
  if (!fileName) return "";
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : "";
}
