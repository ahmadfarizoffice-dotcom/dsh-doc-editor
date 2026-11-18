/**
 * Legacy Word 97-2003 binary (.doc) importer.
 *
 * This is a real (if deliberately narrow) implementation of the on-disk format:
 *
 *  - a Compound File Binary reader (512/4096-byte sectors, FAT, DIFAT, mini FAT,
 *    mini stream, directory entries) locates the `WordDocument` stream;
 *  - the FIB is parsed dynamically from `csw`/`cslw`/`cbRgFcLcb` (with the
 *    documented 0x01A2 `fcClx` fallback for Word 97) to find the CLX;
 *  - the CLX piece table (`Prc`/`Pcdt`) yields CP ranges and piece descriptors,
 *    including compressed CP1252 pieces and UTF-16LE pieces;
 *  - text is reassembled with field instructions dropped (cached results kept),
 *    paragraph marks on `\r`, line breaks on `\v`, page breaks on `\f`.
 *
 * Character formatting (CHPX), headers/footers, tables, images and the summary
 * metadata stream are *not* guessed: they are reported as losses. Export is not
 * supported, so the adapter is read-only.
 */
import type { DocDocument, FeatureSupport, Inline } from "../model/types.js";
import {
  buildCompatibilityReport,
  createDocumentContext,
  importResult,
  LossCollector,
  makeParagraph,
  pushText,
  type DocumentContext,
} from "./shared.js";
import { FormatError } from "./types.js";
import type {
  FormatAdapter,
  FormatCapabilities,
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

/* ------------------------------------------------------- compound file */

const CFB_SIGNATURE = 0xd0cf11e0;
const CFB_SIGNATURE_2 = 0xa1b11ae1;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const MAX_SECTORS = 1_048_576;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

export type CfbObjectType = "storage" | "stream" | "root" | "unknown";

/** One directory entry of a compound file. */
export interface CfbEntry {
  name: string;
  type: CfbObjectType;
  startSector: number;
  size: number;
  child: number;
  leftSibling: number;
  rightSibling: number;
}

/** A parsed compound file: directory plus stream access. */
export interface CompoundFile {
  entries: CfbEntry[];
  sectorSize: number;
  miniSectorSize: number;
  streamNames(): string[];
  readStream(name: string): Buffer | undefined;
}

interface CfbHeader {
  sectorSize: number;
  miniSectorSize: number;
  numFatSectors: number;
  firstDirSector: number;
  miniStreamCutoff: number;
  firstMiniFatSector: number;
  numMiniFatSectors: number;
  firstDifatSector: number;
  numDifatSectors: number;
  difat: number[];
}

function readCfbHeader(bytes: Buffer): CfbHeader {
  if (bytes.length < 512) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Compound file is smaller than its 512-byte header",
    );
  }
  if (
    bytes.readUInt32BE(0) !== CFB_SIGNATURE ||
    bytes.readUInt32BE(4) !== CFB_SIGNATURE_2
  ) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Missing OLE compound file signature",
    );
  }
  const byteOrder = bytes.readUInt16LE(28);
  if (byteOrder !== 0xfffe) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Unsupported compound file byte order: 0x${byteOrder.toString(16)}`,
    );
  }
  const sectorShift = bytes.readUInt16LE(30);
  const miniSectorShift = bytes.readUInt16LE(32);
  if ((sectorShift !== 9 && sectorShift !== 12) || miniSectorShift !== 6) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Unsupported compound file sector sizes (shift ${sectorShift}/${miniSectorShift})`,
    );
  }
  const difat: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    difat.push(bytes.readUInt32LE(76 + index * 4));
  }
  return {
    sectorSize: 1 << sectorShift,
    miniSectorSize: 1 << miniSectorShift,
    numFatSectors: bytes.readUInt32LE(44),
    firstDirSector: bytes.readUInt32LE(48),
    miniStreamCutoff: bytes.readUInt32LE(56),
    firstMiniFatSector: bytes.readUInt32LE(60),
    numMiniFatSectors: bytes.readUInt32LE(64),
    firstDifatSector: bytes.readUInt32LE(68),
    numDifatSectors: bytes.readUInt32LE(72),
    difat,
  };
}

function sectorOffset(header: CfbHeader, sector: number): number {
  return (sector + 1) * header.sectorSize;
}

function readSector(bytes: Buffer, header: CfbHeader, sector: number): Buffer {
  const offset = sectorOffset(header, sector);
  if (sector < 0 || offset + header.sectorSize > bytes.length) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Sector ${sector} is outside the compound file`,
    );
  }
  return bytes.subarray(offset, offset + header.sectorSize);
}

/** Follows a FAT chain, returning the ordered sector list (bounded and loop-safe). */
function chainSectors(start: number, fat: number[], limit: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let current = start;
  while (current !== END_OF_CHAIN && current !== FREE_SECTOR) {
    if (current >= fat.length || seen.has(current) || out.length >= MAX_SECTORS)
      break;
    seen.add(current);
    out.push(current);
    if (out.length >= limit) break;
    current = fat[current];
  }
  return out;
}

function readChainedSectors(
  bytes: Buffer,
  header: CfbHeader,
  start: number,
  fat: number[],
): Buffer {
  const sectors = chainSectors(
    start,
    fat,
    Math.ceil(bytes.length / header.sectorSize) + 1,
  );
  const chunks = sectors.map((sector) => readSector(bytes, header, sector));
  return Buffer.concat(chunks);
}

/** Reads the OLE compound file directory and returns a stream reader. */
export function readCompoundFile(bytes: Buffer): CompoundFile {
  const header = readCfbHeader(bytes);

  // DIFAT: header entries, then the DIFAT sector chain.
  const fatSectorIds: number[] = header.difat.filter(
    (sector) => sector !== FREE_SECTOR && sector !== END_OF_CHAIN,
  );
  let difatSector = header.firstDifatSector;
  const perSector = header.sectorSize / 4;
  const visitedDifat = new Set<number>();
  while (
    difatSector !== END_OF_CHAIN &&
    difatSector !== FREE_SECTOR &&
    !visitedDifat.has(difatSector) &&
    visitedDifat.size <= header.numDifatSectors + 1
  ) {
    visitedDifat.add(difatSector);
    const sector = readSector(bytes, header, difatSector);
    for (let index = 0; index < perSector - 1; index += 1) {
      const id = sector.readUInt32LE(index * 4);
      if (id !== FREE_SECTOR && id !== END_OF_CHAIN) fatSectorIds.push(id);
    }
    difatSector = sector.readUInt32LE((perSector - 1) * 4);
  }
  if (
    header.numFatSectors > 0 &&
    fatSectorIds.length > header.numFatSectors + 1
  ) {
    fatSectorIds.length = header.numFatSectors;
  }

  const fat: number[] = [];
  for (const sectorId of fatSectorIds) {
    const sector = readSector(bytes, header, sectorId);
    for (let index = 0; index < perSector; index += 1)
      fat.push(sector.readUInt32LE(index * 4));
  }
  if (fat.length === 0) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Compound file has an empty allocation table",
    );
  }

  const directoryBytes = readChainedSectors(
    bytes,
    header,
    header.firstDirSector,
    fat,
  );
  const entries: CfbEntry[] = [];
  const entryCount = Math.floor(directoryBytes.length / 128);
  for (let index = 0; index < entryCount; index += 1) {
    const offset = index * 128;
    const nameLength = directoryBytes.readUInt16LE(offset + 64);
    if (nameLength === 0 || nameLength > 64) {
      entries.push({
        name: "",
        type: "unknown",
        startSector: END_OF_CHAIN,
        size: 0,
        child: -1,
        leftSibling: -1,
        rightSibling: -1,
      });
      continue;
    }
    const name = directoryBytes
      .subarray(offset, offset + nameLength - 2)
      .toString("utf16le")
      .replace(/\0+$/, "");
    const objectType = directoryBytes.readUInt8(offset + 66);
    const type: CfbObjectType =
      objectType === 1
        ? "storage"
        : objectType === 2
          ? "stream"
          : objectType === 5
            ? "root"
            : "unknown";
    const startSector = directoryBytes.readUInt32LE(offset + 116);
    // Version 3 files store a 32-bit size; the upper word is zero.
    const size = directoryBytes.readUInt32LE(offset + 120);
    entries.push({
      name,
      type,
      startSector,
      size,
      child: directoryBytes.readUInt32LE(offset + 76),
      leftSibling: directoryBytes.readUInt32LE(offset + 68),
      rightSibling: directoryBytes.readUInt32LE(offset + 72),
    });
  }

  const root = entries[0];
  if (!root || root.type !== "root") {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Compound file directory has no root entry",
    );
  }

  // Mini stream + mini FAT are only needed for small streams.
  const miniFat: number[] = [];
  if (header.numMiniFatSectors > 0) {
    const miniFatBytes = readChainedSectors(
      bytes,
      header,
      header.firstMiniFatSector,
      fat,
    );
    for (let index = 0; index + 3 < miniFatBytes.length; index += 4)
      miniFat.push(miniFatBytes.readUInt32LE(index));
  }
  let miniStream: Buffer | undefined;
  const getMiniStream = (): Buffer => {
    if (!miniStream) {
      miniStream = readChainedSectors(
        bytes,
        header,
        root.startSector,
        fat,
      ).subarray(0, root.size);
    }
    return miniStream;
  };

  const readMiniStream = (start: number, size: number): Buffer => {
    const stream = getMiniStream();
    const chunks: Buffer[] = [];
    const seen = new Set<number>();
    let current = start;
    while (
      current !== END_OF_CHAIN &&
      current !== FREE_SECTOR &&
      !seen.has(current)
    ) {
      seen.add(current);
      const offset = current * header.miniSectorSize;
      if (offset + header.miniSectorSize > stream.length) break;
      chunks.push(stream.subarray(offset, offset + header.miniSectorSize));
      current = miniFat[current] ?? END_OF_CHAIN;
      if (chunks.length * header.miniSectorSize >= size) break;
    }
    return Buffer.concat(chunks).subarray(0, size);
  };

  const readStream = (name: string): Buffer | undefined => {
    const entry = entries.find(
      (candidate) =>
        candidate.type === "stream" &&
        candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!entry) return undefined;
    const size = Math.min(entry.size, MAX_STREAM_BYTES);
    if (entry.size < header.miniStreamCutoff && entry.type !== "root") {
      return readMiniStream(entry.startSector, size);
    }
    return readChainedSectors(bytes, header, entry.startSector, fat).subarray(
      0,
      size,
    );
  };

  return {
    entries,
    sectorSize: header.sectorSize,
    miniSectorSize: header.miniSectorSize,
    streamNames: () =>
      entries
        .filter((entry) => entry.type === "stream")
        .map((entry) => entry.name),
    readStream,
  };
}

/* --------------------------------------------------------------- FIB/CLX */

interface FibInfo {
  nFib: number;
  flags: number;
  complex: boolean;
  fcMin: number;
  fcMac: number;
  fcClx?: number;
  lcbClx?: number;
}

function parseFib(stream: Buffer): FibInfo {
  if (stream.length < 34) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "WordDocument stream is too small for a FIB",
    );
  }
  const wIdent = stream.readUInt16LE(0);
  if (wIdent !== 0xa5ec) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Not a Word binary document (wIdent 0x${wIdent.toString(16)})`,
    );
  }
  const nFib = stream.readUInt16LE(2);
  const flags = stream.readUInt16LE(10);
  const fib: FibInfo = {
    nFib,
    flags,
    complex: (flags & 0x0004) !== 0,
    fcMin: stream.readInt32LE(24),
    fcMac: stream.readInt32LE(28),
  };

  // Dynamic layout: FibBase(32) csw(2) rgw97(csw*2) cslw(2) rglw97(cslw*4)
  // cbRgFcLcb(2) rgFcLcb(cbRgFcLcb*8). fcClx/lcbClx is pair 33.
  let fcClxOffset = -1;
  const csw = stream.readUInt16LE(32);
  const cslwOffset = 34 + csw * 2;
  if (csw > 0 && csw < 64 && cslwOffset + 2 <= stream.length) {
    const cslw = stream.readUInt16LE(cslwOffset);
    const cbOffset = cslwOffset + 2 + cslw * 4;
    if (cslw < 64 && cbOffset + 2 <= stream.length) {
      const cbRgFcLcb = stream.readUInt16LE(cbOffset);
      if (cbRgFcLcb > 33 && cbOffset + 2 + 34 * 8 <= stream.length) {
        fcClxOffset = cbOffset + 2 + 33 * 8;
      }
    }
  }
  if (fcClxOffset < 0 && stream.length >= 0x01a6) {
    // Documented Word 97 offsets (FibRgFcLcb97 starts at 0x9A).
    fcClxOffset = 0x01a2;
  }
  if (fcClxOffset >= 0 && fcClxOffset + 8 <= stream.length) {
    const fcClx = stream.readUInt32LE(fcClxOffset);
    const lcbClx = stream.readUInt32LE(fcClxOffset + 4);
    if (fcClx > 0 && lcbClx > 0 && fcClx + lcbClx <= stream.length) {
      fib.fcClx = fcClx;
      fib.lcbClx = lcbClx;
    }
  }
  return fib;
}

interface TextPiece {
  cpStart: number;
  cpEnd: number;
  fc: number;
  compressed: boolean;
}

function parseClx(stream: Buffer, fcClx: number, lcbClx: number): TextPiece[] {
  const end = Math.min(stream.length, fcClx + lcbClx);
  let offset = fcClx;
  let guard = 0;
  while (offset < end && guard < 4096) {
    guard += 1;
    const kind = stream.readUInt8(offset);
    if (kind === 0x01) {
      if (offset + 3 > end) break;
      const cb = stream.readUInt16LE(offset + 1);
      offset += 3 + cb;
      continue;
    }
    if (kind === 0x02) {
      if (offset + 5 > end) break;
      const lcb = stream.readUInt32LE(offset + 1);
      const plcStart = offset + 5;
      const plcEnd = Math.min(end, plcStart + lcb);
      const available = plcEnd - plcStart;
      const count = Math.floor((available - 4) / 12);
      if (count <= 0) return [];
      const pieces: TextPiece[] = [];
      const cpBase = plcStart;
      const pcdBase = plcStart + (count + 1) * 4;
      for (let index = 0; index < count; index += 1) {
        const cpStart = stream.readUInt32LE(cpBase + index * 4);
        const cpEnd = stream.readUInt32LE(cpBase + (index + 1) * 4);
        if (cpEnd < cpStart) continue;
        const pcdOffset = pcdBase + index * 8;
        if (pcdOffset + 8 > plcEnd) break;
        let fc = stream.readUInt32LE(pcdOffset + 2);
        const compressed = (fc & 0x40000000) !== 0;
        fc = fc & 0x3fffffff;
        if (compressed) fc = Math.floor(fc / 2);
        pieces.push({ cpStart, cpEnd, fc, compressed });
        if (pieces.length >= 100_000) break;
      }
      return pieces;
    }
    break;
  }
  return [];
}

const CP1252_MAP: Record<number, string> = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203A",
  0x9c: "\u0153",
  0x9e: "\u017E",
  0x9f: "\u0178",
};

function decodeCp1252Byte(byte: number): string {
  return CP1252_MAP[byte] ?? String.fromCharCode(byte);
}

/** Extracts the main document text from the WordDocument stream. */
function extractText(stream: Buffer, fib: FibInfo): string {
  const pieces =
    fib.fcClx !== undefined && fib.lcbClx !== undefined
      ? parseClx(stream, fib.fcClx, fib.lcbClx)
      : [];
  if (pieces.length > 0) {
    const chunks: string[] = [];
    for (const piece of pieces) {
      const length = Math.max(0, piece.cpEnd - piece.cpStart);
      if (length === 0) continue;
      if (piece.compressed) {
        const start = piece.fc;
        const stop = Math.min(stream.length, start + length);
        if (start < 0 || start >= stream.length) continue;
        const slice = stream.subarray(start, stop);
        let text = "";
        for (const byte of slice) text += decodeCp1252Byte(byte);
        chunks.push(text);
      } else {
        const start = piece.fc;
        const stop = Math.min(stream.length, start + length * 2);
        if (start < 0 || start + 1 >= stream.length) continue;
        chunks.push(stream.subarray(start, stop).toString("utf16le"));
      }
      if (
        chunks.reduce((sum, chunk) => sum + chunk.length, 0) > MAX_STREAM_BYTES
      )
        break;
    }
    return chunks.join("");
  }
  // No piece table: fall back to the contiguous fcMin..fcMac range.
  const start = Math.max(0, Math.min(fib.fcMin, stream.length));
  const stop = Math.max(start, Math.min(fib.fcMac, stream.length));
  if (stop - start < 2) return "";
  return stream.subarray(start, stop).toString("utf16le");
}

interface SanitizedText {
  text: string;
  fields: number;
  tables: number;
  images: number;
}

/**
 * Drops field instructions (keeping cached results) and converts Word's
 * control characters into a small, explicit text vocabulary.
 */
function sanitizeWordText(raw: string): SanitizedText {
  let text = "";
  let inInstruction = 0;
  let fields = 0;
  let tables = 0;
  let images = 0;
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    switch (code) {
      case 0x13: // field begin
        fields += 1;
        inInstruction += 1;
        continue;
      case 0x14: // field separator: instruction ends, result begins
        inInstruction = Math.max(0, inInstruction - 1);
        continue;
      case 0x15: // field end
        inInstruction = Math.max(0, inInstruction - 1);
        continue;
      case 0x07: // cell / row mark
        tables += 1;
        text += "\r";
        continue;
      case 0x0b: // vertical tab = manual line break
        text += "\v";
        continue;
      case 0x0c: // form feed = page break
        text += "\f";
        continue;
      case 0x0d:
        text += "\r";
        continue;
      case 0x0a:
        text += "\v";
        continue;
      case 0x1e:
        text += "-";
        continue;
      case 0x1f:
        continue;
      case 0x01:
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x05:
      case 0x08:
        images += 1;
        continue;
      default:
        if (inInstruction > 0) continue;
        if (code < 0x20 && code !== 0x09) continue;
        text += char;
        continue;
    }
  }
  return { text, fields, tables, images };
}

interface WordSegment {
  text: string;
  pageBreakAfter: boolean;
}

interface WordSegments {
  segments: WordSegment[];
  pageBreaks: number;
}

function splitParagraphs(text: string): WordSegments {
  const segments: WordSegment[] = [];
  let current = "";
  let pageBreaks = 0;
  for (const char of text) {
    if (char === "\r") {
      segments.push({ text: current, pageBreakAfter: false });
      current = "";
      continue;
    }
    if (char === "\f") {
      segments.push({ text: current, pageBreakAfter: true });
      current = "";
      pageBreaks += 1;
      continue;
    }
    if (char === "\v") {
      current += "\n";
      continue;
    }
    current += char;
  }
  segments.push({ text: current, pageBreakAfter: false });
  return { segments, pageBreaks };
}

/** Builds model paragraphs from a legacy text stream (exposed for tests). */
export function paragraphsFromLegacyText(
  ctx: DocumentContext,
  text: string,
): { count: number; pageBreaks: number } {
  const split = splitParagraphs(text);
  let count = 0;
  let pageBreakParagraphs = 0;
  for (const segment of split.segments) {
    const pieces = segment.text.split("\n");
    const inlines: Inline[] = [];
    pieces.forEach((piece, pieceIndex) => {
      pushText(inlines, piece, {});
      if (pieceIndex < pieces.length - 1)
        inlines.push({ type: "break", kind: "line" });
    });
    ctx.blocks.push(makeParagraph(ctx, inlines));
    count += 1;
    if (segment.pageBreakAfter) {
      ctx.blocks.push(makeParagraph(ctx, [{ type: "break", kind: "page" }]));
      pageBreakParagraphs += 1;
    }
  }
  return { count, pageBreaks: pageBreakParagraphs };
}

/* ---------------------------------------------------------------- import */

/**
 * Imports a Word 97-2003 binary document by reading the OLE compound file,
 * the FIB and the CLX piece table. Rich-formatting streams are reported as
 * losses instead of being guessed.
 */
export async function importLegacyDoc(
  bytes: Buffer | Uint8Array,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `Legacy DOC input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  const compound = readCompoundFile(buffer);
  const stream = compound.readStream("WordDocument");
  if (!stream) {
    const streams = compound.streamNames();
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      `Compound file has no WordDocument stream (found: ${streams.slice(0, 8).join(", ") || "none"})`,
    );
  }
  const fib = parseFib(stream);
  if ((fib.flags & 0x0100) !== 0) {
    throw new FormatError(
      "FORMAT_UNSUPPORTED_CONTAINER",
      "The document is encrypted (fEncrypted is set)",
    );
  }

  const losses = new LossCollector();
  const sanitized = sanitizeWordText(extractText(stream, fib));
  if (!fib.complex && sanitized.text.length === 0) {
    losses.partial(
      "content.plain",
      "Document has no complex piece table and an empty text range",
      undefined,
      false,
    );
  }

  const ctx = createDocumentContext({
    metadata: { title: titleFromFileName(options.fileName) },
  });
  const { count, pageBreaks } = paragraphsFromLegacyText(ctx, sanitized.text);
  ctx.syncIds();
  const doc = ctx.doc;

  if (sanitized.tables > 0) {
    losses.partial(
      "table",
      "Binary table cell/row marks were flattened into paragraph breaks; table structure is not rebuilt",
      undefined,
      false,
    );
  }
  if (sanitized.images > 0) {
    losses.unsupported(
      "image",
      "Inline picture anchors and embedded images are not extracted",
      undefined,
      false,
    );
  }
  if (sanitized.fields > 0) {
    losses.partial(
      "fields",
      "Field instructions are dropped; cached field results are kept as text",
      undefined,
      false,
    );
  }
  losses.partial(
    "character.formatting",
    "CHPX/PAPX formatting runs are not parsed; text is imported without bold/italic/size",
    undefined,
    false,
  );
  losses.unsupported(
    "headerFooter",
    "Headers and footers live in separate streams and are not imported",
    undefined,
    false,
  );
  losses.unsupported(
    "footnote",
    "Footnotes are stored in the footnote subdocument and are not imported",
    undefined,
    false,
  );
  losses.unsupported(
    "comment",
    "Comment subdocuments are not imported",
    undefined,
    false,
  );
  losses.unsupported(
    "metadata",
    "SummaryInformation and DocumentSummaryInformation streams are not parsed",
    undefined,
    false,
  );
  if (pageBreaks > 0) {
    losses.partial(
      "pageBreak",
      "Page breaks are imported as page-break paragraphs",
      undefined,
      true,
    );
  }

  const features: FeatureSupport[] = [
    {
      feature: "document.legacyDoc",
      label: "Word 97-2003 binary document",
      level: "partial",
      occurrences: 1,
    },
    {
      feature: "paragraph.text",
      label: "Paragraph text",
      level: "full",
      occurrences: count,
    },
    {
      feature: "compoundFile",
      label: "OLE compound file",
      level: "full",
      occurrences: compound.entries.length,
    },
    {
      feature: "fib",
      label: "File information block",
      level: "full",
      occurrences: fib.nFib,
    },
    {
      feature: "pieceTable",
      label: "CLX piece table",
      level: fib.fcClx !== undefined ? "full" : "partial",
      occurrences: fib.fcClx !== undefined ? 1 : 0,
    },
  ];
  const lossesList = losses.all();
  doc.compatibility = buildCompatibilityReport({
    format: "legacy-doc",
    fileName: options.fileName,
    features,
    losses: lossesList,
    unknownElements: [],
  });
  return importResult(doc, lossesList, [
    "Legacy .doc import is text-focused: formatting, tables, images and metadata are reported as losses.",
  ]);
}

function titleFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : undefined;
}

/* ------------------------------------------------------------- descriptor */

const CAPABILITIES: FormatCapabilities = {
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
    "Read-only adapter: imports the main text stream only.",
    "Compound file, FIB and CLX piece table are parsed for real (CP1252 and UTF-16LE pieces).",
    "Formatting, tables, images, notes, comments and metadata are reported as losses, never guessed.",
  ],
};

const LEGACY_EXTENSIONS = ["doc", "dot"];

function looksLikeCompoundFile(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes.readUInt32BE(0) === CFB_SIGNATURE &&
    bytes.readUInt32BE(4) === CFB_SIGNATURE_2
  );
}

function mentionsWordStream(bytes: Buffer): boolean {
  return bytes
    .subarray(0, Math.min(bytes.length, 65536))
    .includes(Buffer.from("WordDocument", "utf16le"));
}

/** Legacy Word binary format descriptor (import only). */
export const legacyDocAdapter: FormatAdapter = {
  id: "legacy-doc",
  label: "Word 97-2003 (legacy .doc, import only)",
  extensions: LEGACY_EXTENSIONS,
  mimeTypes: ["application/msword"],
  readOnly: true,
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    const extension = fileName
      ? (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] ?? "").toLowerCase()
      : "";
    if (LEGACY_EXTENSIONS.includes(extension) && looksLikeCompoundFile(bytes))
      return true;
    return looksLikeCompoundFile(bytes) && mentionsWordStream(bytes);
  },
  import: importLegacyDoc,
};

/** Exported for tests that need the raw FIB view. */
export function inspectLegacyDoc(bytes: Buffer): {
  fib: {
    nFib: number;
    complex: boolean;
    fcMin: number;
    fcMac: number;
    hasClx: boolean;
  };
  streams: string[];
  textLength: number;
} {
  const compound = readCompoundFile(bytes);
  const stream = compound.readStream("WordDocument");
  if (!stream)
    throw new FormatError("FORMAT_INVALID_INPUT", "No WordDocument stream");
  const fib = parseFib(stream);
  const text = extractText(stream, fib);
  return {
    fib: {
      nFib: fib.nFib,
      complex: fib.complex,
      fcMin: fib.fcMin,
      fcMac: fib.fcMac,
      hasClx: fib.fcClx !== undefined,
    },
    streams: compound.streamNames(),
    textLength: text.length,
  };
}

/** Unused but exported: keeps the parser helpers testable without duplicating logic. */
export const legacyDocInternals = {
  parseFib,
  parseClx,
  extractText,
  sanitizeWordText,
  readCfbHeader,
};

/** Re-exported document type alias for consumers that only need the result. */
export type LegacyDocDocument = DocDocument;
