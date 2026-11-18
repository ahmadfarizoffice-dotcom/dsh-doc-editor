import { listBlocks, listParagraphs, walkBlocks } from "./access.js";
import { DOCUMENT_SCHEMA_VERSION } from "./types.js";
import type { DocDocument, SupportLevel } from "./types.js";

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  location?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  /** Schema version detected on the input (and the version after migration). */
  schemaVersion: string;
  migratedFrom?: string;
}

const SUPPORTED_MAJOR = 1;

/**
 * Migrates an unknown/older payload to the current schema.
 * The model is versioned; v1 is the initial schema so nothing to rewrite yet,
 * but the entry point exists so future versions stay backward compatible.
 */
export function migrateDocument(input: unknown): {
  document: DocDocument;
  migratedFrom?: string;
} {
  if (!input || typeof input !== "object")
    throw new Error("Document payload must be an object");
  const candidate = input as Partial<DocDocument> & Record<string, unknown>;
  const version =
    typeof candidate.schemaVersion === "string"
      ? candidate.schemaVersion
      : "0.0.0";
  const major = Number(version.split(".")[0]);
  if (!Number.isFinite(major) || major < 1) {
    throw new Error(`Unsupported document schema version: ${version}`);
  }
  if (major > SUPPORTED_MAJOR) {
    throw new Error(
      `Document schema ${version} is newer than this engine (${DOCUMENT_SCHEMA_VERSION}). Upgrade the runtime.`,
    );
  }
  const document = candidate as DocDocument;
  // Fill in fields that older payloads may not have carried.
  document.footnotes ??= [];
  document.endnotes ??= [];
  document.comments ??= [];
  document.revisions ??= [];
  document.bookmarks ??= [];
  document.shapes ??= [];
  document.media ??= [];
  document.customXml ??= [];
  document.unknown ??= [];
  document.idSeq ??= 0;
  document.settings ??= {
    defaultTabStop: 36,
    evenAndOddHeaders: false,
    trackRevisions: false,
    autoHyphenation: false,
  };
  document.settings.defaultTabStop ??= 36;
  document.settings.evenAndOddHeaders ??= false;
  document.settings.trackRevisions ??= false;
  document.settings.autoHyphenation ??= false;
  document.metadata.custom ??= {};
  document.metadata.keywords ??= [];
  return {
    document,
    migratedFrom: version === DOCUMENT_SCHEMA_VERSION ? undefined : version,
  };
}

const VALID_BLOCK_TYPES = new Set(["paragraph", "table", "toc"]);

/** Structural validation used by the service before saving or exporting. */
export function validateDocument(doc: DocDocument): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (
    severity: ValidationIssue["severity"],
    code: string,
    message: string,
    location?: string,
  ) => {
    issues.push({ severity, code, message, location });
  };

  if (doc.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    add(
      "warning",
      "schema.version",
      `Document schema is ${doc.schemaVersion}, engine expects ${DOCUMENT_SCHEMA_VERSION}`,
    );
  }
  if (!doc.sections || doc.sections.length === 0) {
    add(
      "error",
      "sections.empty",
      "Document must contain at least one section",
    );
  }

  const ids = new Set<string>();
  let duplicateCount = 0;
  walkBlocks(doc, ({ block, sectionIndex, blockIndex }) => {
    const location = `section[${sectionIndex}].blocks[${blockIndex}]`;
    if (!VALID_BLOCK_TYPES.has(block.type)) {
      add(
        "error",
        "block.type",
        `Unknown block type "${(block as { type: string }).type}"`,
        location,
      );
    }
    if (ids.has(block.id)) {
      duplicateCount += 1;
      add(
        "error",
        "block.duplicateId",
        `Duplicate block id "${block.id}"`,
        location,
      );
    }
    ids.add(block.id);
    if (block.type === "paragraph") {
      if (block.style && !doc.styles.styles[block.style]) {
        add(
          "warning",
          "style.missing",
          `Paragraph references missing style "${block.style}"`,
          location,
        );
      }
    }
    if (block.type === "table") {
      if (block.rows.length === 0)
        add("warning", "table.empty", "Table has no rows", location);
      for (const row of block.rows) {
        if (row.cells.length === 0)
          add("warning", "table.row.empty", "Table row has no cells", location);
        for (const cell of row.cells) {
          if (ids.has(cell.id)) {
            add(
              "error",
              "cell.duplicateId",
              `Duplicate cell id "${cell.id}"`,
              location,
            );
          }
          ids.add(cell.id);
        }
      }
    }
  });

  for (const section of doc.sections) {
    const page = section.page;
    if (!page || !(page.width > 0) || !(page.height > 0)) {
      add("error", "page.geometry", "Section page size must be positive");
    }
    const { top, bottom, left, right } = page?.margins ?? {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    };
    if (left + right >= page.width)
      add("error", "page.margins", "Horizontal margins exceed page width");
    if (top + bottom >= page.height)
      add("error", "page.margins", "Vertical margins exceed page height");
    if (section.columns.count < 1)
      add("error", "columns.count", "Column count must be at least 1");
  }

  for (const note of [...doc.footnotes, ...doc.endnotes]) {
    if (note.blocks.length === 0)
      add("warning", "note.empty", `Note ${note.id} has no content`);
  }

  for (const media of doc.media) {
    if (!media.data)
      add("error", "media.data", `Media ${media.id} has no payload`);
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter(
    (issue) => issue.severity === "warning",
  ).length;
  if (duplicateCount === 0) {
    add("info", "document.ids", `${ids.size} unique block/cell ids`);
  }
  return {
    valid: errors === 0,
    errors,
    warnings,
    issues,
    schemaVersion: doc.schemaVersion,
  };
}

export interface CapabilityDetail {
  feature: string;
  label: string;
  level: SupportLevel;
  notes?: string;
}

/** Document level feature inventory, used by compatibility resources and docs. */
export function documentFeatureInventory(doc: DocDocument): CapabilityDetail[] {
  const paragraphs = listParagraphs(doc);
  const blocks = listBlocks(doc);
  const out: CapabilityDetail[] = [];
  const push = (
    feature: string,
    label: string,
    level: SupportLevel,
    notes?: string,
  ) => {
    out.push({ feature, label, level, notes });
  };

  push("text.runs", "Text runs", "full");
  push(
    "text.formatting",
    "Character formatting",
    doc.settings.trackRevisions ? "partial" : "full",
  );
  push("paragraph.alignment", "Paragraph alignment", "full");
  push("paragraph.spacing", "Paragraph spacing", "full");
  push("paragraph.indentation", "Indentation", "full");
  push(
    "paragraph.tabs",
    "Tab stops",
    "partial",
    "Custom tab stops are laid out; leader dots supported",
  );
  push("lists.numbering", "Lists and numbering", "full");
  push(
    "tables",
    "Tables",
    blocks.some((entry) => entry.block.type === "table") ? "full" : "full",
    "Nested tables, merged cells, header repeat and row splitting supported",
  );
  push(
    "images",
    "Images",
    doc.media.length > 0 ? "full" : "full",
    "Inline and floating with square/tight wrap",
  );
  push(
    "math",
    "Equations",
    paragraphs.some(({ paragraph }) =>
      paragraph.inlines.some((inline) => inline.type === "math"),
    )
      ? "partial"
      : "full",
    "OMML subset rendered natively; complex constructs fall back to linear text",
  );
  push(
    "fields",
    "Fields",
    paragraphs.some(({ paragraph }) =>
      paragraph.inlines.some((inline) => inline.type === "field"),
    )
      ? "partial"
      : "full",
    "PAGE/NUMPAGES/TOC/PAGEREF/SEQ recomputed; unknown fields render their cached result",
  );
  push(
    "toc",
    "Table of contents",
    blocks.some((entry) => entry.block.type === "toc") ? "full" : "full",
  );
  push(
    "notes",
    "Footnotes and endnotes",
    doc.footnotes.length + doc.endnotes.length > 0 ? "full" : "full",
  );
  push("comments", "Comments", "full");
  push("revisions", "Tracked changes", "full");
  push("sections", "Sections and page layout", "full");
  push("headersFooters", "Headers and footers", "full");
  push(
    "shapes",
    "Text boxes and shapes",
    doc.shapes.length > 0 ? "partial" : "full",
    "Text box content renders; preset shapes render as rectangles",
  );
  push(
    "charts",
    "Charts",
    "fallback",
    "Charts are preserved and rendered as a labelled placeholder",
  );
  push(
    "smartart",
    "SmartArt",
    "fallback",
    "Preserved and rendered as a text placeholder",
  );
  push(
    "macros",
    "VBA macros",
    "unsupported",
    "Never executed; preserved verbatim in .docm export",
  );
  push(
    "ole",
    "Embedded OLE objects",
    "fallback",
    "Preserved and rendered as a placeholder",
  );
  push(
    "contentControls",
    "Content controls",
    "partial",
    "Content is rendered; control semantics are preserved",
  );
  return out;
}
