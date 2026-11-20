/**
 * Workspace storage with strict path confinement and audit logging.
 * Documents are persisted twice: a lossless JSON model snapshot (round-trips
 * ids, comments and revisions exactly) and a DOCX for interoperability.
 */
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
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
  /**
   * Engine that wrote the stored `document.docx`. The model exporter always
   * writes it, so this is `internal`; it is recorded so a reader never has to
   * guess whether the bytes came from LibreOffice.
   */
  engine?: "internal" | "libreoffice";
  /** Service-level engine preference in effect at save time. */
  enginePreference?: "auto" | "libreoffice" | "internal";
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
  private canonicalRootsCache?: string[];
  private readonly documentLocks = new Map<string, Promise<void>>();

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

  private static contains(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  /**
   * Canonical roots (symlinks/junctions resolved) used for containment checks.
   * A root that cannot be resolved yet keeps its lexical form.
   */
  private async canonicalRoots(): Promise<string[]> {
    if (this.canonicalRootsCache) return this.canonicalRootsCache;
    const roots = [this.root, ...this.allowedReadRoots];
    const canonical: string[] = [];
    for (const root of roots) {
      try {
        canonical.push(await realpath(root));
      } catch {
        canonical.push(path.resolve(root));
      }
    }
    this.canonicalRootsCache = canonical;
    return canonical;
  }

  /**
   * Validates an external read path and returns its canonical (realpath)
   * location. Directory junctions and symlinks inside the workspace that point
   * outside every configured root are rejected before the file is read.
   */
  async resolveReadPathCanonical(input: string): Promise<string> {
    const resolved = this.resolveReadPath(input);
    let canonical = resolved;
    try {
      canonical = await realpath(resolved);
    } catch {
      // Missing target: the lexical check above already passed; the caller
      // reports FILE_NOT_FOUND.
      canonical = resolved;
    }
    const roots = await this.canonicalRoots();
    if (!roots.some((root) => Workspace.contains(root, canonical))) {
      throw new ServiceError(
        "PATH_OUTSIDE_WORKSPACE",
        "File access is restricted to the workspace and configured read roots",
        { path: canonical },
      );
    }
    return canonical;
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

  /**
   * Serializes writers for one document so concurrent saves cannot interleave
   * their stage/backup/rename steps.
   */
  private async withDocumentLock<T>(
    id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.documentLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.documentLocks.set(id, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.documentLocks.get(id) === tail) this.documentLocks.delete(id);
    }
  }

  async saveDocument(
    id: string,
    document: DocDocument,
    docx: Buffer | undefined,
    record: Omit<DocumentRecord, "id" | "updatedAt">,
  ): Promise<DocumentRecord> {
    this.assertWritable();
    return this.withDocumentLock(id, () =>
      this.saveDocumentUnlocked(id, document, docx, record),
    );
  }

  private async saveDocumentUnlocked(
    id: string,
    document: DocDocument,
    docx: Buffer | undefined,
    record: Omit<DocumentRecord, "id" | "updatedAt">,
  ): Promise<DocumentRecord> {
    const dir = this.documentDir(id);
    await mkdir(dir, { recursive: true });
    const stored: DocumentRecord = {
      ...record,
      id,
      updatedAt: new Date().toISOString(),
    };
    if (docx && !(docx.length >= 2 && docx[0] === 0x50 && docx[1] === 0x4b)) {
      throw new ServiceError(
        "SAVE_FAILED",
        `Refusing to store a non-ZIP payload as document.docx for ${id}`,
      );
    }
    const files: Array<{ name: string; data: string | Buffer }> = [
      { name: "document.json", data: JSON.stringify(document) },
      ...(docx ? [{ name: "document.docx", data: docx }] : []),
      { name: "record.json", data: JSON.stringify(stored, null, 2) },
    ];
    const targets = files.map((file) => path.join(dir, file.name));

    // Preflight every destination before changing anything: a directory or other
    // non-regular entry can never be replaced atomically, so fail early.
    for (let index = 0; index < targets.length; index += 1) {
      const info = await stat(targets[index]).catch(() => undefined);
      if (info && !info.isFile()) {
        throw new ServiceError(
          "SAVE_FAILED",
          `Cannot save document ${id}: ${files[index].name} is not a regular file`,
          { path: targets[index] },
        );
      }
    }

    const stamp = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const staged: string[] = [];
    const backups: Array<{ target: string; backup: string }> = [];
    try {
      // Stage every payload next to its destination first.
      for (let index = 0; index < files.length; index += 1) {
        const temp = `${targets[index]}.${stamp}.tmp`;
        await writeFile(temp, files[index].data);
        staged.push(temp);
      }
      // Move the previous files aside so a mid-commit failure can be undone.
      for (const target of targets) {
        const info = await stat(target).catch(() => undefined);
        if (!info) continue;
        const backup = `${target}.${stamp}.bak`;
        await rename(target, backup);
        backups.push({ target, backup });
      }
      for (let index = 0; index < staged.length; index += 1) {
        await rename(staged[index], targets[index]);
      }
    } catch (error) {
      // Roll back: restore the previous snapshot and drop anything staged.
      for (const { target, backup } of backups.reverse()) {
        await rm(target, { force: true }).catch(() => undefined);
        await rename(backup, target).catch(() => undefined);
      }
      for (const temp of staged) {
        await rm(temp, { force: true }).catch(() => undefined);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ServiceError(
        "SAVE_FAILED",
        `Could not save document ${id}: ${detail}`,
        { path: dir },
      );
    }
    for (const { backup } of backups) {
      await rm(backup, { force: true }).catch(() => undefined);
    }
    return stored;
  }

  async deleteDocument(id: string): Promise<void> {
    this.assertWritable();
    await this.withDocumentLock(id, () =>
      rm(this.documentDir(id), { recursive: true, force: true }),
    );
  }

  async readExternal(filePath: string): Promise<Buffer> {
    const resolved = await this.resolveReadPathCanonical(filePath);
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
