/**
 * Workspace document store.
 *
 * Documents live in `<repo>/.workspace` as `<id>.json` records (model JSON plus
 * metadata) and `<id>.docx` files. Ids are strictly validated and every resolved
 * path is checked to stay inside the workspace directory.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, } from "node:fs/promises";
import path from "node:path";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
/** Document ids are restricted to `[A-Za-z0-9_-]+` to rule out traversal. */
export function isValidDocumentId(id) {
    return typeof id === "string" && ID_PATTERN.test(id);
}
/**
 * Minimal structural validation of a document payload.
 *
 * It accepts anything the shared model could plausibly own (schemaVersion,
 * sections with blocks and page geometry, styles, id sequence). Full validation
 * is delegated to the core model when it is available; this check exists so the
 * store never persists arbitrary JSON under a document id.
 */
export function validateDocumentShape(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, reason: "document must be an object" };
    }
    const document = value;
    if (typeof document.schemaVersion !== "string") {
        return { ok: false, reason: "document.schemaVersion must be a string" };
    }
    if (!Array.isArray(document.sections) || document.sections.length === 0) {
        return { ok: false, reason: "document.sections must be a non-empty array" };
    }
    for (const [index, section] of document.sections.entries()) {
        if (!section || typeof section !== "object") {
            return {
                ok: false,
                reason: `document.sections[${index}] must be an object`,
            };
        }
        const candidate = section;
        if (!Array.isArray(candidate.blocks)) {
            return {
                ok: false,
                reason: `document.sections[${index}].blocks must be an array`,
            };
        }
        const page = candidate.page;
        if (!page ||
            typeof page !== "object" ||
            typeof page.width !== "number" ||
            typeof page.height !== "number") {
            return {
                ok: false,
                reason: `document.sections[${index}].page must carry numeric width and height`,
            };
        }
    }
    if (!document.styles || typeof document.styles !== "object") {
        return { ok: false, reason: "document.styles must be an object" };
    }
    if (typeof document.idSeq !== "number") {
        return { ok: false, reason: "document.idSeq must be a number" };
    }
    return { ok: true };
}
/** Deterministic, filesystem-safe identifier derived from time plus randomness. */
export function makeDocumentId(now = Date.now(), random = Math.random) {
    const suffix = Math.floor(random() * 36 ** 4)
        .toString(36)
        .padStart(4, "0");
    return `doc-${now.toString(36)}-${suffix}`;
}
/** Filename stem for exports: readable, ASCII-only, bounded. */
export function exportFileName(title, format) {
    const base = (title || "document")
        .normalize("NFKD")
        .replace(/[^\w\s-]+/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 80);
    return `${base || "document"}.${format}`;
}
/** Finds the repository root by walking up to the workspace manifest. */
export function findRepositoryRoot(startDirectory = process.cwd()) {
    let current = path.resolve(startDirectory);
    for (let depth = 0; depth < 8; depth += 1) {
        if (existsSync(path.join(current, "pnpm-workspace.yaml")))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return path.resolve(startDirectory);
}
export class WorkspaceStore {
    root;
    constructor(root) {
        this.root = path.resolve(root);
    }
    async ensure() {
        await mkdir(this.root, { recursive: true });
    }
    /** Resolves a document path, refusing anything that escapes the workspace. */
    resolvePath(id, extension) {
        if (!isValidDocumentId(id))
            throw new Error(`Invalid document id: ${String(id)}`);
        const resolved = path.resolve(this.root, `${id}.${extension === "json" ? "json" : "docx"}`);
        const prefix = this.root.endsWith(path.sep)
            ? this.root
            : `${this.root}${path.sep}`;
        if (!resolved.startsWith(prefix))
            throw new Error("Resolved path escapes the workspace");
        return resolved;
    }
    async list() {
        await this.ensure();
        const entries = await readdir(this.root, { withFileTypes: true });
        const summaries = [];
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const extension = path.extname(entry.name).toLowerCase();
            if (extension !== ".json" && extension !== ".docx")
                continue;
            const id = path.basename(entry.name, extension);
            if (!isValidDocumentId(id))
                continue;
            const fullPath = path.join(this.root, entry.name);
            const info = await stat(fullPath);
            const kind = extension === ".json" ? "json" : "docx";
            let title = id;
            if (kind === "json") {
                try {
                    const record = await this.readJson(id);
                    if (record?.title)
                        title = record.title;
                }
                catch {
                    title = `${id} (unreadable)`;
                }
            }
            summaries.push({
                id,
                title,
                kind,
                bytes: info.size,
                updatedAt: info.mtime.toISOString(),
            });
        }
        summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return summaries;
    }
    async readJson(id) {
        const fullPath = this.resolvePath(id, "json");
        let raw;
        try {
            const info = await stat(fullPath);
            if (info.size > MAX_RECORD_BYTES)
                throw new Error(`Document ${id} exceeds the ${MAX_RECORD_BYTES} byte limit`);
            raw = await readFile(fullPath, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !parsed.document) {
            throw new Error(`Document ${id} is not a valid workspace record`);
        }
        return { ...parsed, id };
    }
    async readDocx(id) {
        const fullPath = this.resolvePath(id, "docx");
        try {
            return await readFile(fullPath);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    async writeJson(record) {
        await this.ensure();
        const id = record.id;
        if (!isValidDocumentId(id))
            throw new Error(`Invalid document id: ${String(id)}`);
        const fullPath = this.resolvePath(id, "json");
        const now = new Date().toISOString();
        const normalized = {
            ...record,
            id,
            createdAt: record.createdAt ?? now,
            updatedAt: now,
        };
        const payload = JSON.stringify(normalized, null, 2);
        const temporary = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, fullPath);
        return normalized;
    }
    async remove(id) {
        let removed = false;
        for (const extension of ["json", "docx"]) {
            const fullPath = this.resolvePath(id, extension);
            try {
                await unlink(fullPath);
                removed = true;
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        return removed;
    }
    async exists(id) {
        const check = async (extension) => {
            try {
                await stat(this.resolvePath(id, extension));
                return true;
            }
            catch {
                return false;
            }
        };
        return { json: await check("json"), docx: await check("docx") };
    }
    /** Content digest used in API responses (never derived from client-supplied data). */
    static digest(bytes) {
        return createHash("sha256").update(bytes).digest("hex");
    }
}
//# sourceMappingURL=workspace.js.map