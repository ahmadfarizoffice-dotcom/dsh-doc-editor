import JSZip from "jszip";
import { createHash } from "node:crypto";

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

/** Reads an OOXML package into a part map, preserving every entry verbatim. */
export async function readPackage(
  bytes: Buffer | Uint8Array,
): Promise<OoxmlPackage> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const digest = createHash("sha256").update(buffer).digest("hex");
  // OLE compound file magic: encrypted OOXML and legacy binary formats.
  const isOle = buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0;
  if (isOle) {
    return { parts: new Map(), digest, isEncrypted: true };
  }
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
  const parts = new Map<string, Buffer>();
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  for (const entry of entries) {
    // Reject path traversal in hostile packages.
    const normalized = entry.name.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`Package entry escapes the package root: ${entry.name}`);
    }
    const data = await entry.async("nodebuffer");
    if (data.byteLength > MAX_PART_BYTES) {
      throw new Error(
        `Package part too large: ${entry.name} (${data.byteLength} bytes)`,
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
