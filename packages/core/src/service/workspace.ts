/**
 * Workspace storage with strict path confinement and audit logging.
 * Documents are persisted twice: a lossless JSON model snapshot (round-trips
 * ids, comments and revisions exactly) and a DOCX for interoperability.
 */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DocDocument } from "../model/types.js";

export class ServiceError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface DocumentRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceFormat: string;
  pageCount?: number;
  wordCount?: number;
}

export interface WorkspaceOptions {
  root: string;
  /** Additional roots that may be read (never written). */
  allowedReadRoots?: string[];
  readOnly?: boolean;
  auditPath?: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class Workspace {
  readonly root: string;
  readonly readOnly: boolean;
  private readonly allowedReadRoots: string[];
  private readonly auditPath: string;
  private readonly realRoot: string;

  constructor(options: WorkspaceOptions) {
    this.root = path.resolve(options.root);
    this.realRoot = this.root;
    this.readOnly = options.readOnly === true;
    this.allowedReadRoots = (options.allowedReadRoots ?? []).map((entry) =>
      path.resolve(entry),
    );
    this.auditPath = options.auditPath
      ? path.resolve(options.auditPath)
      : path.join(this.root, "audit.log");
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, "documents"), { recursive: true });
  }

  documentDir(id: string): string {
    if (!ID_PATTERN.test(id)) {
      throw new ServiceError(
        "INVALID_DOCUMENT_ID",
        `Invalid document id: ${id}`,
      );
    }
    const dir = path.join(this.root, "documents", id);
    this.assertInsideRoot(dir);
    return dir;
  }

  private assertInsideRoot(candidate: string): void {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ServiceError(
        "PATH_TRAVERSAL",
        "Path escapes the workspace root",
      );
    }
  }

  /** Validates an external read path against the workspace and allowed roots. */
  resolveReadPath(input: string): string {
    const resolved = path.resolve(input);
    const allowed = [this.root, ...this.allowedReadRoots];
    for (const root of allowed) {
      const relative = path.relative(root, resolved);
      if (!relative.startsWith("..") && !path.isAbsolute(relative))
        return resolved;
    }
    throw new ServiceError(
      "PATH_OUTSIDE_WORKSPACE",
      "File access is restricted to the workspace and configured read roots",
      { path: resolved },
    );
  }

  /** Validates a path that will be written (workspace only). */
  resolveWritePath(input: string): string {
    const resolved = path.resolve(input);
    this.assertInsideRoot(resolved);
    return resolved;
  }

  async list(): Promise<DocumentRecord[]> {
    const dir = path.join(this.root, "documents");
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const records: DocumentRecord[] = [];
    for (const entry of entries) {
      if (!ID_PATTERN.test(entry)) continue;
      try {
        const meta = await this.readJson<DocumentRecord>(
          path.join(dir, entry, "record.json"),
        );
        if (meta) records.push(meta);
      } catch {
        // Ignore unreadable entries; they are reported through the health API.
      }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async exists(id: string): Promise<boolean> {
    try {
      const info = await stat(this.documentDir(id));
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  async readJson<T>(file: string): Promise<T | undefined> {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async loadModel(id: string): Promise<DocDocument | undefined> {
    return this.readJson<DocDocument>(
      path.join(this.documentDir(id), "document.json"),
    );
  }

  async loadDocx(id: string): Promise<Buffer | undefined> {
    try {
      return await readFile(path.join(this.documentDir(id), "document.docx"));
    } catch {
      return undefined;
    }
  }

  async loadRecord(id: string): Promise<DocumentRecord | undefined> {
    return this.readJson<DocumentRecord>(
      path.join(this.documentDir(id), "record.json"),
    );
  }

  async saveDocument(
    id: string,
    document: DocDocument,
    docx: Buffer | undefined,
    record: Omit<DocumentRecord, "id" | "updatedAt">,
  ): Promise<DocumentRecord> {
    this.assertWritable();
    const dir = this.documentDir(id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "document.json"),
      JSON.stringify(document),
      "utf8",
    );
    if (docx) await writeFile(path.join(dir, "document.docx"), docx);
    const stored: DocumentRecord = {
      ...record,
      id,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(dir, "record.json"),
      JSON.stringify(stored, null, 2),
      "utf8",
    );
    return stored;
  }

  async deleteDocument(id: string): Promise<void> {
    this.assertWritable();
    await rm(this.documentDir(id), { recursive: true, force: true });
  }

  async readExternal(filePath: string): Promise<Buffer> {
    const resolved = this.resolveReadPath(filePath);
    const info = await stat(resolved).catch(() => undefined);
    if (!info || !info.isFile()) {
      throw new ServiceError("FILE_NOT_FOUND", `File not found: ${resolved}`);
    }
    if (info.size > 256 * 1024 * 1024) {
      throw new ServiceError(
        "FILE_TOO_LARGE",
        "Document exceeds the 256 MiB limit",
        { size: info.size },
      );
    }
    return readFile(resolved);
  }

  /** Appends an audit record. Content is never logged, only sizes and hashes. */
  async audit(event: {
    action: string;
    documentId?: string;
    tool?: string;
    outcome: "ok" | "error";
    detail?: Record<string, unknown>;
    actor?: string;
  }): Promise<void> {
    const record = {
      timestamp: new Date().toISOString(),
      actor: event.actor ?? "local-user",
      ...event,
    };
    try {
      await appendFile(this.auditPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Auditing must never break a document operation; the failure is silent by
      // design but recorded through the health endpoint's writability probe.
    }
  }

  async readAudit(limit = 100): Promise<unknown[]> {
    try {
      const raw = await readFile(this.auditPath, "utf8");
      const lines = raw.trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    } catch {
      return [];
    }
  }

  digest(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }

  assertWritable(): void {
    if (this.readOnly) {
      throw new ServiceError(
        "READ_ONLY_MODE",
        "The workspace is configured read-only",
      );
    }
  }
}
