import JSZip from "jszip";
import { createHash } from "node:crypto";
import { FormatError } from "../formats/types.js";

export interface PackagePart {
  path: string;
  data: Buffer;
}

export interface OoxmlPackage {
  parts: Map<string, Buffer>;
  /** SHA-256 of the original package bytes. */
  digest: string;
  /** Whether any entry looked like an encryption/OLE container rather than a ZIP. */
  isEncrypted: boolean;
}

const MAX_PART_BYTES = 256 * 1024 * 1024;

export interface ReadPackageOptions {
  /** Original file name, used only for typed error messages. */
  fileName?: string;
}

function packageLabel(fileName?: string): string {
  return fileName ? `"${fileName}"` : "the document";
}

/**
 * Reads an OOXML package into a part map, preserving every entry verbatim.
 *
 * Every corruption path is translated into a typed `FormatError` naming the
 * document, never the raw library message.
 */
export async function readPackage(
  bytes: Buffer | Uint8Array,
  options: ReadPackageOptions = {},
): Promise<OoxmlPackage> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const digest = createHash("sha256").update(buffer).digest("hex");
  const label = packageLabel(options.fileName);
  // OLE compound file magic: encrypted OOXML and legacy binary formats.
  const isOle = buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0;
  if (isOle) {
    return { parts: new Map(), digest, isEncrypted: true };
  }
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} is not a DOCX/OOXML ZIP package (the archive is empty, truncated or has no ZIP header)`,
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
  } catch {
    throw new FormatError(
      "FORMAT_CORRUPT",
      `${label} is not a readable DOCX/OOXML ZIP package (corrupted, truncated or not a ZIP archive)`,
    );
  }
  const parts = new Map<string, Buffer>();
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  for (const entry of entries) {
    // Reject path traversal in hostile packages.
    const normalized = entry.name.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new FormatError(
        "FORMAT_CORRUPT",
        `${label} contains a package entry that escapes the package root (${entry.name})`,
      );
    }
    const declared = (
      entry as unknown as { _data?: { uncompressedSize?: number } }
    )._data?.uncompressedSize;
    if (typeof declared === "number" && declared > MAX_PART_BYTES) {
      throw new FormatError(
        "FORMAT_TOO_LARGE",
        `${label} declares a ${declared} byte part (${entry.name}), above the ${MAX_PART_BYTES} byte limit`,
      );
    }
    let data: Buffer;
    try {
      data = await entry.async("nodebuffer");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bomb = /size mismatch|uncompressed|invalid size|too large/i.test(
        message,
      );
      throw new FormatError(
        bomb ? "FORMAT_BOMB" : "FORMAT_CORRUPT",
        bomb
          ? `${label} contains a part (${entry.name}) whose declared uncompressed size does not match its payload (ZIP bomb shape)`
          : `${label} contains an unreadable part (${entry.name})`,
      );
    }
    if (data.byteLength > MAX_PART_BYTES) {
      throw new FormatError(
        "FORMAT_TOO_LARGE",
        `${label} contains a part too large to import (${entry.name}, ${data.byteLength} bytes)`,
      );
    }
    parts.set(normalized, Buffer.from(data));
  }
  return { parts, digest, isEncrypted: false };
}

export function readText(
  parts: Map<string, Buffer>,
  path: string,
): string | undefined {
  const data = parts.get(path);
  return data ? data.toString("utf8") : undefined;
}

export function hasPart(parts: Map<string, Buffer>, path: string): boolean {
  return parts.has(path);
}

/** Resolves a relationship target relative to a source part path. */
export function resolvePartPath(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const baseSegments = sourcePart.split("/").slice(0, -1);
  const segments = target.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") baseSegments.pop();
    else baseSegments.push(segment);
  }
  return baseSegments.join("/");
}

export async function writePackage(
  parts: Array<{ path: string; data: Buffer | string }>,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const part of parts) {
    zip.file(part.path, part.data);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
