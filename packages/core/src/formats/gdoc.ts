/**
 * Google Docs pointer (.gdoc) adapter.
 *
 * A `.gdoc` file is not a document: it is a tiny JSON pointer into Google Drive
 * (`doc_id`, `resource_id`, `email`) that the Drive client resolves over the
 * network. This repository has no Google Drive OAuth client, no Drive API call
 * and no Docs API editing path, so there is nothing to import offline. Instead
 * of failing silently or pretending the bytes are text, the adapter recognises
 * the pointer, reports the typed `FORMAT_EXTERNAL_REQUIRED` error and explains
 * the supported path: open the document in Google Docs, download it as
 * `.docx`, then import that file with the DOCX adapter.
 *
 * The adapter is read-only and export is never implemented.
 */
import { FormatError } from "./types.js";
import type {
  FormatAdapter,
  FormatCapabilities,
  FormatErrorCode,
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

/**
 * Stable code for inputs whose content can only be obtained from an external
 * service. It is not yet a member of the shared `FormatErrorCode` union
 * (`formats/types.ts` is outside this change's file scope), so the value is
 * asserted locally; consumers still match on `error.code` unchanged.
 */
export const FORMAT_EXTERNAL_REQUIRED = "FORMAT_EXTERNAL_REQUIRED";

/** A `.gdoc` pointer: the Drive metadata needed to locate the real document. */
export interface GdocPointer {
  /** Google Docs document id. */
  docId: string;
  /** Drive resource id of the document. */
  resourceId: string;
  /** Account that owns the pointer, when the file records one. */
  email?: string;
}

/** A `.gdoc` pointer is a few hundred bytes; anything larger is not one. */
const MAX_GDOC_POINTER_BYTES = 64 * 1024;

const GDOC_EXTERNAL_MESSAGE =
  "This .gdoc file is a Google Docs link, not a document: it only records a Google Drive document id. This repository has no Google Drive OAuth client or Google Docs API access, so the linked document cannot be fetched or converted here. Open the file in Google Docs, choose File → Download → Microsoft Word (.docx), then import the downloaded .docx with this engine.";

/**
 * Parses a `.gdoc` JSON pointer. Returns `undefined` for anything that is not
 * the expected shape, so callers (including `detect`) never throw on garbage.
 */
export function parseGdocPointer(
  bytes: Buffer | Uint8Array,
): GdocPointer | undefined {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength > MAX_GDOC_POINTER_BYTES) return undefined;
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;

  const record = parsed as Record<string, unknown>;
  const docId = record.doc_id;
  const resourceId = record.resource_id;
  const email = record.email;
  if (typeof docId !== "string" || docId.length === 0) return undefined;
  if (typeof resourceId !== "string" || resourceId.length === 0)
    return undefined;
  if (email !== undefined && typeof email !== "string") return undefined;
  return { docId, resourceId, email };
}

/**
 * Refuses to import a Google Docs pointer.
 *
 * @throws FormatError `FORMAT_TOO_LARGE` above `maxBytes`,
 * `FORMAT_INVALID_INPUT` when the bytes are not a `.gdoc` pointer and
 * `FORMAT_EXTERNAL_REQUIRED` (with the actionable export recipe) for a real
 * pointer, because the content lives behind Google Drive.
 */
export async function importGdoc(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `Google Docs pointer is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  if (!parseGdocPointer(buffer)) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Not a Google Docs pointer file: expected JSON with non-empty doc_id and resource_id fields",
    );
  }
  throw new FormatError(
    FORMAT_EXTERNAL_REQUIRED as unknown as FormatErrorCode,
    GDOC_EXTERNAL_MESSAGE,
  );
}

/* ------------------------------------------------------------- descriptor */

const GDOC_CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: false,
  styles: "none",
  tables: "none",
  images: "none",
  hyperlinks: "none",
  headersFooters: "none",
  pageLayout: "none",
  numbering: "none",
  metadata: "none",
  comments: "none",
  trackedChanges: "none",
  math: "none",
  notes: [
    "A .gdoc file is a JSON pointer into Google Drive, not a document.",
    "Import performs no network access: it fails with FORMAT_EXTERNAL_REQUIRED and explains how to export the document as .docx.",
    "There is no Drive OAuth or Google Docs API client in this repository.",
  ],
};

const GDOC_EXTENSIONS = ["gdoc"];

/**
 * Google Docs pointer descriptor. Detection validates the JSON pointer shape
 * (a random JSON object is not claimed) and never throws.
 */
export const gdocAdapter: FormatAdapter = {
  id: "gdoc",
  label: "Google Docs link",
  extensions: GDOC_EXTENSIONS,
  mimeTypes: ["application/vnd.google-apps.document"],
  readOnly: true,
  capabilities: GDOC_CAPABILITIES,
  detect(bytes) {
    return parseGdocPointer(bytes) !== undefined;
  },
  import: importGdoc,
};
