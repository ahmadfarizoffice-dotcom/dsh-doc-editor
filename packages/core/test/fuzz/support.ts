/**
 * Shared, deterministic fuzzing support for the engine hardening suites.
 *
 * Everything here is seeded (mulberry32) and reproducible: a failure always
 * names the case seed, the generated op script and the first differing block so
 * a source owner can replay it without the fuzzer.
 *
 * The suites only touch the public engine surface exported by
 * `packages/core/src/dsh-entry.ts`; model types are imported type-only.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DocumentService,
  ServiceError,
  invokeTool,
} from "../../src/dsh-entry.js";
import type {
  Block,
  DocDocument,
  Inline,
  Paragraph,
  Table,
} from "../../src/model/types.js";

/* --------------------------------------------------------------- config */

export interface FuzzConfig {
  seed: number;
  cases: number;
}

/** Reads FUZZ_SEED (default 1337) and FUZZ_CASES (default 150). */
export function readFuzzConfig(
  defaults: FuzzConfig = { seed: 1337, cases: 150 },
): FuzzConfig {
  const rawSeed = Number.parseInt(process.env.FUZZ_SEED ?? "", 10);
  const rawCases = Number.parseInt(process.env.FUZZ_CASES ?? "", 10);
  const seed = Number.isFinite(rawSeed) ? rawSeed >>> 0 : defaults.seed;
  const cases =
    Number.isFinite(rawCases) && rawCases > 0 ? rawCases : defaults.cases;
  return { seed, cases };
}

/** Derives a stable per-case seed from the run seed and the case index. */
export function caseSeed(seed: number, index: number): number {
  const mixed = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  let value = mixed;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

/* ------------------------------------------------------------------- rng */

/** Deterministic mulberry32 PRNG. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  shuffled<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index);
      const value = copy[index];
      copy[index] = copy[swap];
      copy[swap] = value;
    }
    return copy;
  }
}

/* --------------------------------------------------------------- unicode */

const PLAIN_ASCII =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?-()[]{}\"'/";

/** Emoji, RTL scripts, combining marks and invisible format characters. */
export const UNICODE_CHUNKS: readonly string[] = [
  "😀",
  "👩🏽‍💻",
  "🧑‍🚀",
  "🏳️‍🌈",
  "עברית",
  "العربية",
  "e\u0301",
  "a\u0308",
  "o\u0328\u0301",
  "\u200B",
  "\u200D",
  "\uFEFF",
  "\u00A0",
  "Ω",
  "日本語",
  "한국어",
  "𝄞",
  "\u202E\u202C",
];

function plainText(rng: Rng, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1)
    out += PLAIN_ASCII[rng.int(0, PLAIN_ASCII.length - 1)];
  return out;
}

/** Text that mixes ASCII with unicode blocks, tabs and hard-break characters. */
export function randomText(
  rng: Rng,
  minLength: number,
  maxLength: number,
  options: { unicode?: boolean; tabs?: boolean } = {},
): string {
  const length = rng.int(minLength, maxLength);
  const chunks: string[] = [];
  let remaining = length;
  while (remaining > 0) {
    const roll = rng.next();
    if (options.unicode && roll < 0.35) {
      const chunk = rng.pick(UNICODE_CHUNKS);
      chunks.push(chunk);
      remaining -= chunk.length;
    } else if (options.tabs && roll < 0.45) {
      chunks.push("\t");
      remaining -= 1;
    } else {
      const run = Math.min(remaining, rng.int(1, 8));
      chunks.push(plainText(rng, run));
      remaining -= run;
    }
  }
  return chunks.join("");
}

/** Very long paragraphs use ASCII only to keep generation and layout cheap. */
export function asciiText(rng: Rng, length: number): string {
  let out = "";
  const words = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur"];
  while (out.length < length) {
    out += `${rng.pick(words)} `;
  }
  return out.slice(0, length);
}

/* ----------------------------------------------------------- model utils */

/** Text projection of one inline node, mirroring the engine's documentText(). */
export function inlineProjection(inline: Inline): string {
  switch (inline.type) {
    case "text":
      return inline.text;
    case "tab":
      return "\t";
    case "break":
      return inline.kind === "page" ? "\f" : "\n";
    case "image":
      return "\uFFFC";
    case "field":
      return inline.result ? inline.result.map(inlineProjection).join("") : "";
    case "math":
      return inline.linear;
    case "unknown":
      return inline.text ?? "";
    default:
      return "";
  }
}

export function paragraphProjection(paragraph: Paragraph): string {
  return paragraph.inlines.map(inlineProjection).join("");
}

export function blockProjection(block: Block): string {
  if (block.type === "paragraph") return paragraphProjection(block);
  if (block.type === "toc") return "";
  return block.rows
    .map((row) =>
      row.cells
        .map((cell) => cell.blocks.map(blockProjection).join("\n"))
        .join("\t"),
    )
    .join("\n");
}

export function blocksProjection(blocks: Block[]): string {
  return blocks.map(blockProjection).join("\n");
}

/** Recomputes documentText() from the model without calling the engine. */
export function reconstructedText(doc: DocDocument): string {
  const parts = doc.sections.map((section) => blocksProjection(section.blocks));
  for (const shape of doc.shapes) {
    if (shape.kind === "textbox") parts.push(blocksProjection(shape.blocks));
  }
  for (const note of [...doc.footnotes, ...doc.endnotes]) {
    parts.push(blocksProjection(note.blocks));
  }
  return parts.join("\n");
}

/** Every block in document order, including table cells (body only). */
export function walkSectionBlocks(doc: DocDocument): Block[] {
  const out: Block[] = [];
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      out.push(block);
      if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) walk(cell.blocks);
        }
      }
    }
  };
  for (const section of doc.sections) walk(section.blocks);
  return out;
}

/** Top-level blocks only (valid anchors for insertX(afterBlockId)). */
export function topLevelBlocks(doc: DocDocument): Block[] {
  return doc.sections.flatMap((section) => section.blocks);
}

export interface ParagraphTarget {
  blockId: string;
  text: string;
  style?: string;
}

/** Paragraph targets in document order, including table cell content. */
export function paragraphTargets(doc: DocDocument): ParagraphTarget[] {
  const out: ParagraphTarget[] = [];
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        out.push({
          blockId: block.id,
          text: paragraphProjection(block),
          style: block.style,
        });
      } else if (block.type === "table") {
        for (const row of block.rows)
          for (const cell of row.cells) walk(cell.blocks);
      }
    }
  };
  for (const section of doc.sections) walk(section.blocks);
  return out;
}

export interface TableTarget {
  tableId: string;
  rows: number;
  columns: number;
}

export function tableTargets(doc: DocDocument): TableTarget[] {
  const out: TableTarget[] = [];
  for (const block of walkSectionBlocks(doc)) {
    if (block.type === "table") {
      out.push({
        tableId: block.id,
        rows: block.rows.length,
        columns: block.grid.length || (block.rows[0]?.cells.length ?? 0),
      });
    }
  }
  return out;
}

/** Ordered paragraph texts (same traversal as documentText). */
export function orderedParagraphTexts(doc: DocDocument): string[] {
  const out: string[] = [];
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      if (block.type === "paragraph") out.push(paragraphProjection(block));
      else if (block.type === "table") {
        for (const row of block.rows)
          for (const cell of row.cells) walk(cell.blocks);
      }
    }
  };
  for (const section of doc.sections) walk(section.blocks);
  for (const shape of doc.shapes) {
    if (shape.kind === "textbox") walk(shape.blocks);
  }
  for (const note of [...doc.footnotes, ...doc.endnotes]) walk(note.blocks);
  return out;
}

/** Count of top-level body blocks across all sections. */
export function topLevelBlockCount(doc: DocDocument): number {
  return doc.sections.reduce(
    (total, section) => total + section.blocks.length,
    0,
  );
}

/** All ids that must be unique: block, table, row and cell ids (all parts). */
export function collectStructuralIds(doc: DocDocument): string[] {
  const ids: string[] = [];
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      ids.push(block.id);
      if (block.type === "table") {
        for (const row of block.rows) {
          ids.push(row.id);
          for (const cell of row.cells) {
            ids.push(cell.id);
            walk(cell.blocks);
          }
        }
      }
    }
  };
  for (const section of doc.sections) {
    ids.push(section.id);
    walk(section.blocks);
    for (const set of [section.headers, section.footers]) {
      for (const variant of ["default", "first", "even"] as const) {
        const part = set[variant];
        if (!part) continue;
        ids.push(part.id);
        walk(part.blocks);
      }
    }
  }
  for (const shape of doc.shapes) {
    ids.push(shape.id);
    walk(shape.blocks);
  }
  for (const note of [...doc.footnotes, ...doc.endnotes]) {
    ids.push(note.id);
    walk(note.blocks);
  }
  for (const comment of doc.comments) {
    ids.push(comment.id);
    walk(comment.blocks);
  }
  return ids;
}

export function duplicateIds(
  ids: string[],
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));
}

/* ----------------------------------------------------------------- hashes */

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      out[key] = sortedValue(entry);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, `undefined` dropped (mirrors JSON snapshots). */
export function canonicalModelJson(doc: DocDocument): string {
  return JSON.stringify(sortedValue(doc));
}

export function modelHash(doc: DocDocument): string {
  return createHash("sha256").update(canonicalModelJson(doc)).digest("hex");
}

/**
 * Structural signature without volatile timestamps, used to compare two
 * independent sessions running the same op script.
 */
export function structureSignature(doc: DocDocument): string {
  return JSON.stringify({
    sections: doc.sections.map((section) => ({
      blocks: section.blocks.map(signatureOfBlock),
    })),
    footnotes: doc.footnotes.map((note) => note.blocks.map(signatureOfBlock)),
    endnotes: doc.endnotes.map((note) => note.blocks.map(signatureOfBlock)),
    comments: doc.comments.map((comment) => ({
      blocks: comment.blocks.map(signatureOfBlock),
      resolved: comment.resolved,
    })),
  });
}

function signatureOfBlock(block: Block): unknown {
  if (block.type === "paragraph") {
    return {
      type: "paragraph",
      id: block.id,
      style: block.style,
      text: paragraphProjection(block),
    };
  }
  if (block.type === "toc") {
    return {
      type: "toc",
      id: block.id,
      min: block.minLevel,
      max: block.maxLevel,
    };
  }
  return {
    type: "table",
    id: block.id,
    grid: block.grid,
    rows: block.rows.map((row) => ({
      id: row.id,
      cells: row.cells.map((cell) => ({
        id: cell.id,
        span: cell.props.gridSpan ?? 1,
        vMerge: cell.props.vMerge ?? null,
        blocks: cell.blocks.map(signatureOfBlock),
      })),
    })),
  };
}

/* --------------------------------------------------------------- compare */

export interface TextDifference {
  index: number;
  before: string;
  after: string;
}

export function firstTextDifference(
  before: string,
  after: string,
): TextDifference | undefined {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) index += 1;
  if (index === before.length && index === after.length) return undefined;
  return {
    index,
    before: before.slice(Math.max(0, index - 40), index + 90),
    after: after.slice(Math.max(0, index - 40), index + 90),
  };
}

export interface ParagraphDifference {
  index: number;
  before?: string;
  after?: string;
  kind: "changed" | "missing" | "duplicated";
}

/** First paragraph-level divergence (changed, missing or duplicated text). */
export function firstParagraphDifference(
  before: string[],
  after: string[],
): ParagraphDifference | undefined {
  const limit = Math.min(before.length, after.length);
  for (let index = 0; index < limit; index += 1) {
    if (before[index] !== after[index]) {
      return {
        index,
        before: before[index],
        after: after[index],
        kind: "changed",
      };
    }
  }
  if (after.length > before.length) {
    return { index: limit, after: after[limit], kind: "duplicated" };
  }
  if (before.length > after.length) {
    return { index: limit, before: before[limit], kind: "missing" };
  }
  const beforeCounts = countTexts(before);
  const afterCounts = countTexts(after);
  for (const [text, count] of beforeCounts) {
    if ((afterCounts.get(text) ?? 0) > count) {
      return { index: before.indexOf(text), before: text, kind: "duplicated" };
    }
  }
  return undefined;
}

export function countTexts(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

/** Paragraphs present after but not before, beyond expected multiplicity. */
export function duplicatedParagraphs(
  before: string[],
  after: string[],
): string[] {
  const beforeCounts = countTexts(before);
  const afterCounts = countTexts(after);
  const duplicates: string[] = [];
  for (const [text, count] of afterCounts) {
    if (count > (beforeCounts.get(text) ?? 0)) duplicates.push(text);
  }
  return duplicates;
}

/** Paragraphs present before but missing after. */
export function lostParagraphs(before: string[], after: string[]): string[] {
  const beforeCounts = countTexts(before);
  const afterCounts = countTexts(after);
  const lost: string[] = [];
  for (const [text, count] of beforeCounts) {
    if (count > (afterCounts.get(text) ?? 0)) lost.push(text);
  }
  return lost;
}

/* --------------------------------------------------------------- losses */

export interface LossLike {
  feature: string;
  level: string;
  reason?: string;
  preserved?: boolean;
}

/** Losses reported by an adapter import plus the document's compatibility report. */
export function collectedLosses(
  imported: { losses?: unknown[] },
  document: DocDocument,
): LossLike[] {
  const out: LossLike[] = [];
  for (const candidate of imported.losses ?? []) {
    const loss = candidate as Partial<LossLike>;
    if (typeof loss.feature === "string" && typeof loss.level === "string") {
      out.push({
        feature: loss.feature,
        level: loss.level,
        reason: loss.reason,
        preserved: loss.preserved,
      });
    }
  }
  for (const loss of document.compatibility?.losses ?? []) {
    out.push({
      feature: loss.feature,
      level: loss.level,
      reason: loss.reason,
      preserved: loss.preserved,
    });
  }
  return out;
}

export function isLossy(losses: LossLike[]): boolean {
  return losses.some(
    (loss) => loss.level !== "full" || loss.preserved === false,
  );
}

/* ---------------------------------------------------------------- errors */

export function isTypedError(error: unknown): boolean {
  if (error instanceof ServiceError) return true;
  if (typeof error === "object" && error !== null) {
    // FormatError lives in formats/types.ts and is not re-exported by dsh-entry,
    // so classify it through its stable class name plus a non-empty code.
    const name = (error as { name?: unknown }).name;
    const code = (error as { code?: unknown }).code;
    if (name === "FormatError" && typeof code === "string") return true;
    if (
      name === "ConversionError" &&
      typeof code === "string" &&
      /^(FORMAT_|CONVERSION_|PDF_)/.test(code)
    ) {
      return true;
    }
  }
  return false;
}

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "<untyped>";
}

export function describeError(error: unknown): string {
  if (error instanceof Error)
    return `${error.constructor.name}: ${error.message}`;
  return String(error);
}

/* ------------------------------------------------------------- workspace */

export interface TempWorkspace {
  root: string;
  service: DocumentService;
  dispose: () => Promise<void>;
}

export async function createTempWorkspace(
  prefix = "dsh-fuzz-",
): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const service = new DocumentService({
    workspaceRoot: root,
    allowedReadRoots: [root],
  });
  await service.init();
  return {
    root,
    service,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------- cases io */

export type CaseStatus = "passed" | "failed" | "documented";

export interface CaseOutcome {
  name: string;
  status: CaseStatus;
  detail?: string;
}

export interface CaseSummary {
  suite: string;
  cases: number;
  passed: number;
  failed: number;
  documented: number;
  durationMs: number;
}

/** Per-case reporter that also writes the machine-readable suite summary. */
export class FuzzReporter {
  readonly suite: string;
  readonly outcomes: CaseOutcome[] = [];
  private readonly started = Date.now();

  constructor(suite: string) {
    this.suite = suite;
  }

  pass(name: string): void {
    this.outcomes.push({ name, status: "passed" });
  }

  document(name: string, detail: string): void {
    this.outcomes.push({ name, status: "documented", detail });
  }

  fail(name: string, detail: string): void {
    this.outcomes.push({ name, status: "failed", detail });
  }

  summary(): CaseSummary {
    const failed = this.outcomes.filter(
      (entry) => entry.status === "failed",
    ).length;
    const documented = this.outcomes.filter(
      (entry) => entry.status === "documented",
    ).length;
    return {
      suite: this.suite,
      cases: this.outcomes.length,
      passed: this.outcomes.length - failed - documented,
      failed,
      documented,
      durationMs: Date.now() - this.started,
    };
  }

  async writeSummary(): Promise<CaseSummary> {
    const summary = this.summary();
    const directory = process.env.FUZZ_REPORT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${this.suite}.json`),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(`FUZZ_SUMMARY ${JSON.stringify(summary)}`);
    const failures = this.outcomes.filter((entry) => entry.status === "failed");
    if (failures.length > 0) {
      const lines = failures.map(
        (entry, index) => `${index + 1}. ${entry.name}\n${entry.detail ?? ""}`,
      );
      console.log(
        `FUZZ_FAILURES ${this.suite} (${failures.length}):\n${lines.join("\n\n")}`,
      );
    }
    return summary;
  }
}

/** Promise timeout wrapper (detects async hangs; cannot preempt sync CPU work). */
export async function withTimeout<T>(
  label: string,
  milliseconds: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TIMEOUT after ${milliseconds}ms: ${label}`));
    }, milliseconds);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- documents */

export interface BuiltDocument {
  documentId: string;
  document: DocDocument;
}

/** Creates a document from seeded paragraph strings. */
export async function createSeededDocument(
  service: DocumentService,
  title: string,
  paragraphs: string[],
): Promise<BuiltDocument> {
  const created = await service.createDocument({ title, paragraphs });
  return { documentId: created.documentId, document: created.document };
}

/** Paragraph seeds: index 0 exercises the 10,000 char paragraph, 1 the empty one. */
export function seedParagraphs(rng: Rng, index: number): string[] {
  if (index === 0) return ["x".repeat(10_000), "tail paragraph"];
  if (index === 1) return ["", ""];
  const count = rng.int(1, 4);
  const paragraphs: string[] = [];
  for (let position = 0; position < count; position += 1) {
    const roll = rng.next();
    if (roll < 0.1) {
      paragraphs.push("");
    } else if (roll < 0.5) {
      paragraphs.push(randomText(rng, 1, 40, { unicode: rng.chance(0.6) }));
    } else if (roll < 0.8) {
      paragraphs.push(
        randomText(rng, 41, 200, { unicode: rng.chance(0.5), tabs: true }),
      );
    } else if (roll < 0.95) {
      paragraphs.push(
        randomText(rng, 201, 1200, { unicode: rng.chance(0.5), tabs: true }),
      );
    } else {
      paragraphs.push(asciiText(rng, rng.int(1201, 3000)));
    }
  }
  if (index % 3 === 0) {
    paragraphs[0] = `😀 ${paragraphs[0] ?? ""} עברית e\u0301 \u200B\u200D${rng.pick(UNICODE_CHUNKS)}`;
  }
  return paragraphs;
}

/* ------------------------------------------------------------------- ops */

export const STYLE_IDS = [
  "Normal",
  "Heading1",
  "Heading2",
  "Heading3",
  "Title",
  "Quote",
] as const;

export type FuzzOpName =
  | "document_insert_text"
  | "document_replace_text"
  | "document_delete_range"
  | "document_format_text"
  | "document_format_paragraph"
  | "document_apply_style"
  | "document_insert_heading"
  | "document_insert_list"
  | "document_insert_table"
  | "document_edit_table"
  | "document_insert_hyperlink"
  | "document_insert_page_break"
  | "document_insert_section_break"
  | "document_edit_header"
  | "document_edit_footer"
  | "document_add_comment"
  | "document_insert_footnote"
  | "document_insert_toc"
  | "document_set_metadata"
  | "document_set_page_layout";

export interface FuzzOp {
  name: FuzzOpName;
  args: Record<string, unknown>;
}

export const TOOL_BACKED_OPS: readonly FuzzOpName[] = [
  "document_insert_text",
  "document_replace_text",
  "document_delete_range",
  "document_format_text",
  "document_format_paragraph",
  "document_apply_style",
  "document_insert_heading",
  "document_insert_list",
  "document_insert_table",
  "document_edit_table",
  "document_insert_hyperlink",
  "document_insert_page_break",
  "document_insert_section_break",
  "document_edit_header",
  "document_edit_footer",
  "document_add_comment",
  "document_insert_footnote",
  "document_insert_toc",
];

export function isToolBacked(op: FuzzOpName): boolean {
  return TOOL_BACKED_OPS.includes(op);
}

/** Applies one op to the service directly (the engine's own method path). */
export function applyOpDirect(
  service: DocumentService,
  documentId: string,
  op: FuzzOp,
): unknown {
  const args = op.args as never;
  switch (op.name) {
    case "document_insert_text":
      return service.insertText(documentId, args);
    case "document_replace_text":
      return service.replaceText(documentId, args);
    case "document_delete_range":
      return service.deleteRange(documentId, args);
    case "document_format_text":
      return service.formatText(documentId, args);
    case "document_format_paragraph":
      return service.formatParagraph(documentId, args);
    case "document_apply_style":
      return service.applyStyle(documentId, args);
    case "document_insert_heading":
      return service.insertHeading(documentId, args);
    case "document_insert_list":
      return service.insertList(documentId, args);
    case "document_insert_table":
      return service.insertTable(documentId, args);
    case "document_edit_table":
      return service.editTable(documentId, args);
    case "document_insert_hyperlink":
      return service.insertHyperlink(documentId, args);
    case "document_insert_page_break":
      return service.insertPageBreak(documentId, args);
    case "document_insert_section_break":
      return service.insertSectionBreak(documentId, args);
    case "document_edit_header":
      return service.editHeaderFooter(documentId, {
        ...(op.args as {
          sectionIndex?: number;
          variant?: string;
          text: string;
        }),
        part: "header",
      } as never);
    case "document_edit_footer":
      return service.editHeaderFooter(documentId, {
        ...(op.args as {
          sectionIndex?: number;
          variant?: string;
          text: string;
        }),
        part: "footer",
      } as never);
    case "document_add_comment":
      return service.addComment(documentId, args);
    case "document_insert_footnote":
      return service.addFootnote(documentId, args);
    case "document_insert_toc":
      return service.insertToc(documentId, args);
    case "document_set_metadata":
      return service.setDocumentMetadata(documentId, op.args.patch as never);
    case "document_set_page_layout":
      return service.setPageLayout(documentId, args);
    default:
      throw new Error(`Unsupported op: ${String(op.name)}`);
  }
}

/** Applies one op through the tool layer used by MCP (invokeTool). */
export async function applyOpViaTool(
  service: DocumentService,
  documentId: string,
  op: FuzzOp,
): Promise<{
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}> {
  return (await invokeTool(service, op.name, {
    documentId,
    ...op.args,
  })) as {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
}

/* -------------------------------------------------------------- op builders */

function positionIn(
  rng: Rng,
  paragraph: ParagraphTarget,
): Record<string, unknown> {
  return {
    blockId: paragraph.blockId,
    offset: rng.int(0, paragraph.text.length),
  };
}

function sortedRangeIn(
  rng: Rng,
  paragraph: ParagraphTarget,
): { start: Record<string, unknown>; end: Record<string, unknown> } {
  const length = paragraph.text.length;
  const from = rng.int(0, length);
  const to = rng.int(from, length);
  return {
    start: { blockId: paragraph.blockId, offset: from },
    end: { blockId: paragraph.blockId, offset: to },
  };
}

function randomRunProps(rng: Rng): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (rng.chance(0.5)) props.bold = rng.chance(0.6);
  if (rng.chance(0.5)) props.italic = rng.chance(0.6);
  if (rng.chance(0.35)) props.underline = rng.chance(0.5) ? "single" : "double";
  if (rng.chance(0.4))
    props.color = `#${rng.int(0, 0xffffff).toString(16).padStart(6, "0")}`;
  if (rng.chance(0.4)) props.fontSize = rng.int(8, 30);
  if (rng.chance(0.2)) props.strike = true;
  if (rng.chance(0.2))
    props.vertAlign = rng.chance(0.5) ? "superscript" : "subscript";
  return props;
}

/** Builds one random, mutation-only, valid-at-that-moment operation. */
export function makeMutationOp(
  rng: Rng,
  doc: DocDocument,
  options: { toolBackedOnly?: boolean } = {},
): FuzzOp | undefined {
  const paragraphs = paragraphTargets(doc);
  if (paragraphs.length === 0) return undefined;
  const anchors = topLevelBlocks(doc).map((block) => block.id);
  if (anchors.length === 0) return undefined;
  const tables = tableTargets(doc);
  const kinds: FuzzOpName[] = [
    "document_insert_text",
    "document_insert_text",
    "document_insert_text",
    "document_format_text",
    "document_format_text",
    "document_replace_text",
    "document_delete_range",
    "document_format_paragraph",
    "document_apply_style",
    "document_insert_heading",
    "document_insert_heading",
    "document_insert_list",
    "document_insert_list",
    "document_insert_table",
    "document_edit_table",
    "document_edit_table",
    "document_insert_hyperlink",
    "document_insert_page_break",
    "document_insert_section_break",
    "document_edit_header",
    "document_edit_footer",
    "document_add_comment",
    "document_insert_footnote",
    "document_insert_toc",
  ];
  if (!options.toolBackedOnly)
    kinds.push("document_set_page_layout", "document_set_metadata");
  let kind = rng.pick(kinds);
  if (kind === "document_edit_table" && tables.length === 0)
    kind = "document_insert_table";

  switch (kind) {
    case "document_insert_text": {
      const paragraph = rng.pick(paragraphs);
      const text = randomText(rng, 1, 30, {
        unicode: rng.chance(0.5),
        tabs: rng.chance(0.4),
      });
      const includeNewline = rng.chance(0.25);
      return {
        name: kind,
        args: {
          position: positionIn(rng, paragraph),
          text: includeNewline ? `${text}\n${randomText(rng, 0, 10)}` : text,
          ...(rng.chance(0.6) ? { props: randomRunProps(rng) } : {}),
        },
      };
    }
    case "document_replace_text": {
      const paragraph = rng.pick(paragraphs);
      return {
        name: kind,
        args: {
          range: sortedRangeIn(rng, paragraph),
          text: randomText(rng, 0, 20, { unicode: rng.chance(0.4) }),
        },
      };
    }
    case "document_delete_range": {
      const paragraph = rng.pick(paragraphs);
      return { name: kind, args: { range: sortedRangeIn(rng, paragraph) } };
    }
    case "document_format_text": {
      const paragraph = rng.pick(paragraphs);
      return {
        name: kind,
        args: {
          range: sortedRangeIn(rng, paragraph),
          props: randomRunProps(rng),
          ...(rng.chance(0.2) ? { clear: true } : {}),
        },
      };
    }
    case "document_format_paragraph": {
      const blockIds = rng
        .shuffled(paragraphs)
        .slice(0, rng.int(1, Math.min(3, paragraphs.length)))
        .map((paragraph) => paragraph.blockId);
      const props: Record<string, unknown> = {};
      if (rng.chance(0.5))
        props.alignment = rng.pick(["left", "center", "right", "justify"]);
      if (rng.chance(0.4)) props.spaceAfter = rng.int(0, 40);
      if (rng.chance(0.4)) props.spaceBefore = rng.int(0, 24);
      if (rng.chance(0.3))
        props.indent = { left: rng.int(0, 72), firstLine: rng.int(0, 24) };
      if (rng.chance(0.2)) props.keepNext = true;
      return { name: kind, args: { blockIds, props } };
    }
    case "document_apply_style": {
      const blockIds = rng
        .shuffled(paragraphs)
        .slice(0, rng.int(1, Math.min(3, paragraphs.length)))
        .map((paragraph) => paragraph.blockId);
      return {
        name: kind,
        args: {
          blockIds,
          styleId: rng.pick(STYLE_IDS),
          ...(rng.chance(0.3) ? { clearDirectFormatting: true } : {}),
        },
      };
    }
    case "document_insert_heading":
      return {
        name: kind,
        args: {
          text: randomText(rng, 1, 24, { unicode: rng.chance(0.4) }),
          level: rng.int(1, 4),
          afterBlockId: rng.pick(anchors),
        },
      };
    case "document_insert_list": {
      const items = Array.from({ length: rng.int(1, 3) }, () =>
        randomText(rng, 1, 18, { unicode: rng.chance(0.3) }),
      );
      return {
        name: kind,
        args: {
          items,
          kind: rng.chance(0.5) ? "bullet" : "number",
          afterBlockId: rng.pick(anchors),
          level: rng.int(0, 2),
          ...(rng.chance(0.4) ? { startAt: rng.int(1, 9) } : {}),
        },
      };
    }
    case "document_insert_table": {
      const rows = rng.int(1, 3);
      const columns = rng.int(1, 3);
      const withData = rng.chance(0.8);
      return {
        name: kind,
        args: {
          rows,
          columns,
          afterBlockId: rng.pick(anchors),
          ...(withData
            ? {
                data: Array.from({ length: rows }, () =>
                  Array.from({ length: columns }, () =>
                    randomText(rng, 0, 12, { unicode: rng.chance(0.3) }),
                  ),
                ),
              }
            : {}),
          ...(rng.chance(0.4) ? { headerRow: true } : {}),
        },
      };
    }
    case "document_edit_table": {
      const table = rng.pick(tables);
      const operation = rng.pick([
        "insertRow",
        "deleteRow",
        "insertColumn",
        "deleteColumn",
        "mergeCells",
        "splitCell",
        "deleteTable",
      ] as const);
      if (operation === "deleteRow" && table.rows <= 1) return undefined;
      if (operation === "deleteColumn" && table.columns <= 1) return undefined;
      if (operation === "deleteTable" && tables.length <= 1) return undefined;
      const args: Record<string, unknown> = {
        tableId: table.tableId,
        operation,
      };
      if (operation === "insertRow" || operation === "deleteRow") {
        args.index = rng.int(0, Math.max(0, table.rows - 1));
      } else if (operation === "insertColumn" || operation === "deleteColumn") {
        args.index = rng.int(0, Math.max(0, table.columns - 1));
      } else if (operation === "mergeCells") {
        // Merge regions must be rectangles of still-unmerged cells: the engine
        // rejects overlaps and out-of-grid coordinates instead of clamping.
        const tableBlock = walkSectionBlocks(doc).find(
          (block): block is Table =>
            block.type === "table" && block.id === table.tableId,
        );
        if (!tableBlock) return undefined;
        const region = pickMergeRegion(rng, tableBlock);
        if (!region) return undefined;
        args.region = region;
      } else if (operation === "splitCell") {
        const tableBlock = walkSectionBlocks(doc).find(
          (block): block is Table =>
            block.type === "table" && block.id === table.tableId,
        );
        const cell = tableBlock?.rows[0]?.cells[0];
        args.cellId = cell?.id ?? "";
        if (!cell) return undefined;
      }
      return { name: kind, args };
    }
    case "document_insert_hyperlink": {
      const paragraph = rng.pick(paragraphs);
      return {
        name: kind,
        args: {
          range: sortedRangeIn(rng, paragraph),
          href: `https://example.com/${rng.int(1, 999)}`,
          ...(rng.chance(0.3) ? { tooltip: randomText(rng, 1, 12) } : {}),
        },
      };
    }
    case "document_insert_page_break": {
      const paragraph = rng.pick(paragraphs);
      return {
        name: kind,
        args: {
          position: positionIn(rng, paragraph),
          kind: rng.pick(["page", "line", "column"]),
        },
      };
    }
    case "document_insert_section_break": {
      const sectionIndex = rng.int(0, doc.sections.length - 1);
      const section = doc.sections[sectionIndex];
      return {
        name: kind,
        args: {
          sectionIndex,
          blockIndex: rng.int(0, section.blocks.length),
          ...(rng.chance(0.6)
            ? {
                type: rng.pick([
                  "nextPage",
                  "continuous",
                  "oddPage",
                  "evenPage",
                ]),
              }
            : {}),
          ...(rng.chance(0.5) ? { landscape: rng.chance(0.5) } : {}),
        },
      };
    }
    case "document_edit_header":
    case "document_edit_footer":
      return {
        name: kind,
        args: {
          sectionIndex: rng.int(0, doc.sections.length - 1),
          variant: rng.pick(["default", "first", "even"]),
          text: randomText(rng, 0, 24, { unicode: rng.chance(0.3) }),
        },
      };
    case "document_add_comment": {
      const paragraph = rng.pick(paragraphs);
      return {
        name: kind,
        args: {
          range: sortedRangeIn(rng, paragraph),
          text: randomText(rng, 1, 40),
          ...(rng.chance(0.4) ? { author: `author-${rng.int(1, 5)}` } : {}),
        },
      };
    }
    case "document_insert_footnote": {
      const paragraph = rng.pick(paragraphs);
      return {
        name: kind,
        args: {
          position: positionIn(rng, paragraph),
          text: randomText(rng, 1, 30, { unicode: rng.chance(0.3) }),
          type: rng.chance(0.7) ? "footnote" : "endnote",
        },
      };
    }
    case "document_insert_toc":
      return {
        name: kind,
        args: {
          afterBlockId: rng.pick(anchors),
          minLevel: rng.int(1, 2),
          maxLevel: rng.int(2, 4),
          ...(rng.chance(0.3) ? { includeTitle: true } : {}),
        },
      };
    case "document_set_metadata":
      return {
        name: kind,
        args: {
          patch: {
            title: `title-${rng.int(1, 99)}`,
            ...(rng.chance(0.4) ? { keywords: ["alpha", "beta"] } : {}),
          },
        },
      };
    case "document_set_page_layout": {
      const args: Record<string, unknown> = {};
      if (rng.chance(0.7)) {
        const page: Record<string, unknown> = {};
        if (rng.chance(0.5))
          page.orientation = rng.chance(0.5) ? "landscape" : "portrait";
        if (rng.chance(0.5)) {
          page.margins = {
            top: rng.int(18, 90),
            right: rng.int(18, 90),
            bottom: rng.int(18, 90),
            left: rng.int(18, 90),
            header: rng.int(10, 40),
            footer: rng.int(10, 40),
            gutter: rng.int(0, 10),
          };
        }
        args.page = page;
      }
      if (rng.chance(0.3))
        args.columns = { count: rng.int(1, 3), space: rng.int(12, 48) };
      return { name: kind, args };
    }
    default:
      return undefined;
  }
}

/** Records an op as a stable, printable script entry. */
export function opScriptLine(index: number, op: FuzzOp): string {
  return `${index + 1}. ${op.name} ${JSON.stringify(op.args)}`;
}

export function formatOpScript(ops: FuzzOp[]): string {
  return ops.map((op, index) => opScriptLine(index, op)).join("\n");
}

/* ---------------------------------------------------- document generation */

export interface ContentBuildResult {
  ops: FuzzOp[];
  failures: string[];
}

/**
 * Applies a randomised content plan that exercises every block/run kind the
 * round-trip property is about: paragraphs (runs, tabs, hard breaks), headings,
 * bullet/number lists, tables with merged cells, hyperlinks, footnotes, TOC,
 * page breaks, section breaks, headers and page layout.
 */
export function buildContentPlan(rng: Rng): string[] {
  const plan: string[] = ["unicode_text"];
  const optional: Array<[string, number]> = [
    ["heading", 0.9],
    ["bullet_list", 0.8],
    ["number_list", 0.7],
    ["table_merge", 0.85],
    ["hyperlink", 0.8],
    ["line_break", 0.6],
    ["footnote", 0.6],
    ["page_break", 0.6],
    ["toc", 0.45],
    ["section_break", 0.45],
    ["header", 0.35],
    ["format_text", 0.8],
    ["format_paragraph", 0.6],
    ["apply_style", 0.5],
    ["comment", 0.3],
    ["page_layout", 0.3],
  ];
  for (const [kind, probability] of optional) {
    if (rng.chance(probability)) plan.push(kind);
  }
  return rng.shuffled(plan);
}

export function applyContentPlan(
  service: DocumentService,
  documentId: string,
  rng: Rng,
  plan: string[],
): ContentBuildResult {
  const ops: FuzzOp[] = [];
  const failures: string[] = [];
  for (const kind of plan) {
    const doc = service.session(documentId).document;
    const paragraphs = paragraphTargets(doc);
    const anchors = topLevelBlocks(doc).map((block) => block.id);
    if (paragraphs.length === 0 || anchors.length === 0) break;
    let op: FuzzOp | undefined;
    switch (kind) {
      case "unicode_text": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_insert_text",
          args: {
            position: {
              blockId: paragraph.blockId,
              offset: rng.int(0, paragraph.text.length),
            },
            text: `${rng.pick(UNICODE_CHUNKS)}${rng.pick(UNICODE_CHUNKS)} ${randomText(rng, 1, 12)}`,
          },
        };
        break;
      }
      case "heading":
        op = {
          name: "document_insert_heading",
          args: {
            text: `Heading ${rng.int(1, 3)} ${randomText(rng, 1, 10)}`,
            level: rng.int(1, 3),
            afterBlockId: rng.pick(anchors),
          },
        };
        break;
      case "bullet_list":
      case "number_list":
        op = {
          name: "document_insert_list",
          args: {
            items: Array.from({ length: rng.int(1, 3) }, () =>
              randomText(rng, 1, 14),
            ),
            kind: kind === "bullet_list" ? "bullet" : "number",
            afterBlockId: rng.pick(anchors),
            level: rng.int(0, 2),
            ...(rng.chance(0.4) ? { startAt: rng.int(1, 9) } : {}),
          },
        };
        break;
      case "table_merge": {
        const rows = rng.int(1, 3);
        const columns = rng.int(1, 3);
        const data = Array.from({ length: rows }, () =>
          Array.from({ length: columns }, () =>
            randomText(rng, 0, 10, { unicode: rng.chance(0.3) }),
          ),
        );
        const tableOp: FuzzOp = {
          name: "document_insert_table",
          args: {
            rows,
            columns,
            data,
            afterBlockId: rng.pick(anchors),
            headerRow: rng.chance(0.4),
          },
        };
        op = tableOp;
        break;
      }
      case "hyperlink": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_insert_hyperlink",
          args: {
            range: sortedRangeIn(rng, paragraph),
            href: `https://example.com/${rng.int(1, 999)}`,
          },
        };
        break;
      }
      case "line_break": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_insert_page_break",
          args: { position: positionIn(rng, paragraph), kind: "line" },
        };
        break;
      }
      case "page_break": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_insert_page_break",
          args: { position: positionIn(rng, paragraph), kind: "page" },
        };
        break;
      }
      case "footnote": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_insert_footnote",
          args: {
            position: positionIn(rng, paragraph),
            text: `footnote ${randomText(rng, 1, 20)}`,
            type: rng.chance(0.7) ? "footnote" : "endnote",
          },
        };
        break;
      }
      case "toc":
        op = {
          name: "document_insert_toc",
          args: {
            afterBlockId: rng.pick(anchors),
            minLevel: 1,
            maxLevel: rng.int(2, 4),
          },
        };
        break;
      case "section_break": {
        const sectionIndex = rng.int(0, doc.sections.length - 1);
        op = {
          name: "document_insert_section_break",
          args: {
            sectionIndex,
            blockIndex: rng.int(0, doc.sections[sectionIndex].blocks.length),
            ...(rng.chance(0.6) ? { landscape: rng.chance(0.5) } : {}),
          },
        };
        break;
      }
      case "header":
        op = {
          name: "document_edit_header",
          args: {
            sectionIndex: 0,
            variant: rng.pick(["default", "first", "even"]),
            text: `header ${randomText(rng, 1, 14)}`,
          },
        };
        break;
      case "format_text": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_format_text",
          args: {
            range: sortedRangeIn(rng, paragraph),
            props: randomRunProps(rng),
          },
        };
        break;
      }
      case "format_paragraph": {
        const blockIds = rng
          .shuffled(paragraphs)
          .slice(0, rng.int(1, Math.min(3, paragraphs.length)))
          .map((paragraph) => paragraph.blockId);
        op = {
          name: "document_format_paragraph",
          args: {
            blockIds,
            props: {
              alignment: rng.pick(["left", "center", "right", "justify"]),
              spaceAfter: rng.int(0, 24),
            },
          },
        };
        break;
      }
      case "apply_style": {
        const blockIds = rng
          .shuffled(paragraphs)
          .slice(0, rng.int(1, Math.min(2, paragraphs.length)))
          .map((paragraph) => paragraph.blockId);
        op = {
          name: "document_apply_style",
          args: { blockIds, styleId: rng.pick(STYLE_IDS) },
        };
        break;
      }
      case "comment": {
        const paragraph = rng.pick(paragraphs);
        op = {
          name: "document_add_comment",
          args: { range: sortedRangeIn(rng, paragraph), text: "fuzz comment" },
        };
        break;
      }
      case "page_layout":
        op = {
          name: "document_set_page_layout",
          args: {
            page: {
              orientation: rng.chance(0.5) ? "landscape" : "portrait",
              ...(rng.chance(0.5)
                ? {
                    margins: {
                      top: rng.int(18, 72),
                      right: rng.int(18, 72),
                      bottom: rng.int(18, 72),
                      left: rng.int(18, 72),
                      header: rng.int(10, 36),
                      footer: rng.int(10, 36),
                      gutter: 0,
                    },
                  }
                : {}),
            },
          },
        };
        break;
      default:
        op = undefined;
    }
    if (!op) continue;
    ops.push(op);
    try {
      applyOpDirect(service, documentId, op);
    } catch (error) {
      failures.push(
        `content op ${ops.length} ${op.name} ${JSON.stringify(op.args)} threw ${describeError(error)}`,
      );
    }
  }
  return { ops, failures };
}

/** Applies a specific merge op after the last inserted table (helper for content). */
function isMergedCell(cell: Table["rows"][number]["cells"][number]): boolean {
  return (cell.props.gridSpan ?? 1) > 1 || Boolean(cell.props.vMerge);
}

/**
 * Picks a rectangular region of still-unmerged cells (cell-matrix coordinates).
 * The engine rejects overlapping merges; a fuzzer that asked for them would be
 * generating invalid operations rather than valid ones.
 */
function pickMergeRegion(
  rng: Rng,
  table: Table,
):
  | {
      startRow: number;
      endRow: number;
      startColumn: number;
      endColumn: number;
    }
  | undefined {
  const candidates: Array<{ row: number; column: number }> = [];
  table.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, columnIndex) => {
      if (!isMergedCell(cell))
        candidates.push({ row: rowIndex, column: columnIndex });
    });
  });
  if (candidates.length === 0) return undefined;
  const anchor = rng.pick(candidates);
  const row = table.rows[anchor.row];
  let maxColumn = anchor.column;
  while (
    maxColumn + 1 < row.cells.length &&
    !isMergedCell(row.cells[maxColumn + 1])
  ) {
    maxColumn += 1;
  }
  const endColumn = rng.int(anchor.column, maxColumn);
  let maxRow = anchor.row;
  while (maxRow + 1 < table.rows.length) {
    const next = table.rows[maxRow + 1];
    if (next.cells.length <= endColumn) break;
    let open = true;
    for (let column = anchor.column; column <= endColumn; column += 1) {
      if (isMergedCell(next.cells[column])) {
        open = false;
        break;
      }
    }
    if (!open) break;
    maxRow += 1;
  }
  return {
    startRow: anchor.row,
    endRow: rng.int(anchor.row, maxRow),
    startColumn: anchor.column,
    endColumn,
  };
}

export function mergeLastTable(
  service: DocumentService,
  documentId: string,
  rng: Rng,
): FuzzOp | undefined {
  const doc = service.session(documentId).document;
  const tables = tableTargets(doc);
  const table = tables[tables.length - 1];
  if (!table) return undefined;
  const startRow = 0;
  const startColumn = 0;
  const endRow = Math.min(table.rows - 1, rng.int(0, 1));
  const endColumn = Math.min(table.columns - 1, rng.int(0, 1));
  if (endRow === 0 && endColumn === 0) {
    if (table.columns > 1)
      return {
        name: "document_edit_table",
        args: {
          tableId: table.tableId,
          operation: "mergeCells",
          region: { startRow, endRow: 0, startColumn: 0, endColumn: 1 },
        },
      };
    if (table.rows > 1)
      return {
        name: "document_edit_table",
        args: {
          tableId: table.tableId,
          operation: "mergeCells",
          region: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 },
        },
      };
    return undefined;
  }
  return {
    name: "document_edit_table",
    args: {
      tableId: table.tableId,
      operation: "mergeCells",
      region: { startRow, endRow, startColumn, endColumn },
    },
  };
}
