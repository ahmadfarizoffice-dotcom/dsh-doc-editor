/**
 * Optional LibreOffice engine adapter.
 *
 * LibreOffice is **not** bundled with this project and is not required. When a
 * `soffice` binary is present the adapter can convert documents with a real
 * `soffice --headless --convert-to ...` process; when it is absent every entry
 * point fails with `ENGINE_UNAVAILABLE` and returns the detection evidence
 * (candidate paths, existence, probe output) instead of pretending a file was
 * produced.
 *
 * Design rules:
 *  - Nothing is executed through a shell. `spawn` always receives an argument
 *    array with `shell: false`; a Windows `.cmd`/`.bat` shim is rejected because
 *    it would need `cmd.exe` to run.
 *  - Detection is explicit: candidates from `DSH_SOFFICE_PATH`, then `PATH`
 *    (probing every directory and Windows `PATHEXT` extension without a shell),
 *    then the documented standard install locations. A candidate only becomes
 *    the selected engine after `soffice --version` exits 0 and prints a
 *    recognisable LibreOffice version.
 *  - Each conversion gets a unique `-env:UserInstallation` profile under a
 *    per-call temporary directory, so concurrent calls cannot share state. The
 *    temporary directory (profile + output) is removed on success, failure and
 *    timeout.
 *  - Output must exist and be non-empty before it is reported. Partial files
 *    from a failed or killed process are never returned as success.
 *
 * Optional test hook: when `DSH_SOFFICE_PATH` explicitly points at a
 * `.js`/`.mjs`/`.cjs` file, the adapter launches it with the current Node
 * binary. This is the only way to run the repository's fake `soffice` on
 * Windows without a shell; script shims are never auto-discovered from `PATH`.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------- constants */

export const LIBREOFFICE_INSTALL_HINT =
  "winget install --id TheDocumentFoundation.LibreOffice";

export const DEFAULT_DETECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_CONVERSION_TIMEOUT_MS = 60_000;
export const MIN_CONVERSION_TIMEOUT_MS = 50;
export const MAX_CONVERSION_TIMEOUT_MS = 600_000;
export const MAX_PATH_LENGTH = 4_096;
const MAX_CAPTURED_OUTPUT = 1_024 * 1_024;
const VERSION_PATTERN = /LibreOffice(?:Dev)?\s+([0-9]+(?:\.[0-9]+)+)/i;

/* ---------------------------------------------------------------- errors */

export type LibreOfficeErrorCode =
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_FAILED"
  | "ENGINE_TIMEOUT"
  | "OUTPUT_MISSING"
  | "FORMAT_UNSUPPORTED"
  | "INVALID_ARGUMENT"
  | "PATH_OUTSIDE_WORKSPACE"
  | "READ_ONLY_MODE";

export class LibreOfficeError extends Error {
  readonly code: LibreOfficeErrorCode;
  readonly details?: unknown;

  constructor(code: LibreOfficeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "LibreOfficeError";
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------- file types */

export type LibreOfficeSource =
  "env" | "path" | "standard-windows" | "standard-macos" | "standard-linux";

export type CandidateRejection =
  | "nul-byte"
  | "not-absolute"
  | "windows-batch-requires-shell"
  | "unsupported-script"
  | "script-shim-not-auto-detected";

export interface LibreOfficeCandidate {
  path: string;
  source: LibreOfficeSource;
  exists: boolean;
  /** Set when the candidate exists but cannot be launched safely. */
  rejected?: CandidateRejection;
}

export interface ProcessProbe {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  spawnError?: { code: string; message: string };
  outputTruncated?: boolean;
}

export interface DetectionAttempt {
  path: string;
  reason: string;
  probe?: ProcessProbe;
}

export interface LibreOfficeDetection {
  available: boolean;
  path: string | null;
  version?: string;
  source: LibreOfficeSource | "none";
  candidates: LibreOfficeCandidate[];
  /** Why the engine is not available; always set when `available` is false. */
  reason?: string;
  attempts: DetectionAttempt[];
  /** True when the value came from the in-process detection cache. */
  cached?: boolean;
  checkedAt: string;
  installHint: string;
}

export interface DetectLibreOfficeOptions {
  /** Environment to inspect and to pass to the probed process. */
  env?: NodeJS.ProcessEnv;
  /** Platform to assume; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Ignore the cached detection and probe again. */
  refresh?: boolean;
  /** Timeout for the `--version` probe; defaults to 5 s. */
  timeoutMs?: number;
  /** Existence predicate override. Production uses `existsSync`. */
  exists?: (candidate: string) => boolean;
}

/* ---------------------------------------------------------- format table */

export interface LibreOfficeFormatDefinition {
  /** Output extension written by LibreOffice. */
  extension: string;
  /** Default `--convert-to` filter (may contain spaces). */
  filter: string;
  /** Input extensions accepted for this target format. */
  inputExtensions: readonly string[];
}

/**
 * Filters are written as `extension:FilterName`. LibreOffice accepts a bare
 * extension too, but naming the filter makes the requested transform explicit
 * and lets `format` carry an override such as `html:HTML (StarWriter)`.
 */
export const LIBREOFFICE_CONVERSION_FORMATS: Readonly<
  Record<string, LibreOfficeFormatDefinition>
> = Object.freeze({
  docx: {
    extension: "docx",
    filter: "MS Word 2007 XML",
    inputExtensions: ["docx", "dotx", "odt", "rtf", "txt", "html", "htm"],
  },
  odt: {
    extension: "odt",
    filter: "writer8",
    inputExtensions: ["docx", "dotx", "odt", "rtf", "txt", "html", "htm"],
  },
  rtf: {
    extension: "rtf",
    filter: "Rich Text Format",
    inputExtensions: ["docx", "dotx", "odt", "rtf", "txt", "html", "htm"],
  },
  txt: {
    extension: "txt",
    filter: "Text",
    inputExtensions: ["docx", "dotx", "odt", "rtf", "txt", "html", "htm"],
  },
  html: {
    extension: "html",
    filter: "HTML (StarWriter)",
    inputExtensions: ["docx", "dotx", "odt", "rtf", "txt", "html", "htm"],
  },
  pdf: {
    extension: "pdf",
    filter: "writer_pdf_Export",
    inputExtensions: ["docx", "dotx", "odt", "rtf", "txt", "html", "htm"],
  },
});

export function supportedLibreOfficeFormats(): string[] {
  return Object.keys(LIBREOFFICE_CONVERSION_FORMATS);
}

function supportedInputExtensions(): Set<string> {
  const extensions = new Set<string>();
  for (const definition of Object.values(LIBREOFFICE_CONVERSION_FORMATS)) {
    for (const extension of definition.inputExtensions) {
      extensions.add(extension);
    }
  }
  return extensions;
}

/* ------------------------------------------------------------- utilities */

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = env[name];
  if (typeof direct === "string") return direct;
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : env[key];
}

function splitPathValue(value: string, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .map((entry) => {
      // Windows allows quoted directories in PATH; strip one surrounding pair.
      if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
        return entry.slice(1, -1);
      }
      return entry;
    })
    .filter((entry) => entry.length > 0);
}

interface PathApi {
  join: (...parts: string[]) => string;
  isAbsolute: (candidate: string) => boolean;
  extname: (candidate: string) => string;
}

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalisePathext(env: NodeJS.ProcessEnv): string[] {
  const raw = environmentValue(env, "PATHEXT");
  const declared =
    raw && raw.trim().length > 0
      ? raw.split(";")
      : [".COM", ".EXE", ".BAT", ".CMD"];
  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const entry of declared) {
    const extension = entry.trim().toLowerCase();
    if (!/^\.[a-z0-9]+$/.test(extension)) continue;
    if (seen.has(extension)) continue;
    seen.add(extension);
    extensions.push(extension);
  }
  // Prefer the console wrapper (`.com`) over the GUI launcher (`.exe`):
  // `soffice.exe` detaches and returns before the conversion is complete.
  return extensions.sort((left, right) => {
    const priority = (extension: string) =>
      extension === ".com"
        ? 0
        : extension === ".exe"
          ? 1
          : extension === ".bin"
            ? 2
            : 3;
    return priority(left) - priority(right);
  });
}

function standardPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === "win32") {
    const programFiles =
      environmentValue(env, "ProgramFiles") ?? "C:\\Program Files";
    const programFilesX86 =
      environmentValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
    const directories = [
      path.win32.join(programFiles, "LibreOffice", "program"),
      path.win32.join(programFilesX86, "LibreOffice", "program"),
    ];
    const localAppData = environmentValue(env, "LOCALAPPDATA");
    if (localAppData && localAppData.trim().length > 0) {
      directories.push(
        path.win32.join(localAppData, "Programs", "LibreOffice", "program"),
      );
    }
    // `soffice.com` is the console wrapper that runs synchronously;
    // `soffice.exe` detaches and can return before the output exists. Both are
    // listed, console wrapper first.
    return directories.flatMap((directory) => [
      path.win32.join(directory, "soffice.com"),
      path.win32.join(directory, "soffice.exe"),
    ]);
  }
  if (platform === "darwin") {
    const home =
      environmentValue(env, "HOME") ??
      environmentValue(env, "USERPROFILE") ??
      "";
    const candidates = ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
    if (home.trim().length > 0) {
      candidates.push(
        path.posix.join(
          home,
          "Applications",
          "LibreOffice.app",
          "Contents",
          "MacOS",
          "soffice",
        ),
      );
    }
    return candidates;
  }
  return [
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
  ];
}

/* ---------------------------------------------------------- candidate list */

export interface CandidateListOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
}

function safeExists(
  exists: (candidate: string) => boolean,
  candidate: string,
): boolean {
  if (candidate.includes("\u0000")) return false;
  try {
    return exists(candidate) === true;
  } catch {
    return false;
  }
}

/**
 * Windows installs ship `soffice.exe` (a launcher that detaches immediately)
 * next to `soffice.com` (a console wrapper that runs synchronously and reports
 * the exit code). When an override points at the launcher, prefer the wrapper.
 */
function preferConsoleWrapper(
  candidatePath: string,
  platform: NodeJS.Platform,
  exists: (candidate: string) => boolean,
): string {
  if (platform !== "win32") return candidatePath;
  if (!candidatePath.toLowerCase().endsWith(".exe")) return candidatePath;
  const wrapper = `${candidatePath.slice(0, -4)}.com`;
  return safeExists(exists, wrapper) ? wrapper : candidatePath;
}

function rejectionFor(
  candidate: string,
  source: LibreOfficeSource,
  platform: NodeJS.Platform,
): CandidateRejection | undefined {
  if (candidate.includes("\u0000")) return "nul-byte";
  if (!pathApiFor(platform).isAbsolute(candidate)) return "not-absolute";
  const extension = pathApiFor(platform).extname(candidate).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return "windows-batch-requires-shell";
  }
  if (extension === ".ps1" || extension === ".vbs") {
    return "unsupported-script";
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    // Only an explicit environment override may point at a script; a random
    // `soffice.js` found on PATH must never be executed.
    return source === "env" ? undefined : "script-shim-not-auto-detected";
  }
  return undefined;
}

/**
 * Builds the ordered candidate list without running anything. Existence is
 * probed with a plain predicate (`existsSync` in production), never a shell
 * command. The list is deduplicated case-insensitively on Windows.
 */
export function libreOfficeCandidates(
  options: CandidateListOptions = {},
): LibreOfficeCandidate[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const api = pathApiFor(platform);
  const raw: Array<{ path: string; source: LibreOfficeSource }> = [];

  const override = environmentValue(env, "DSH_SOFFICE_PATH");
  if (typeof override === "string" && override.trim().length > 0) {
    const trimmed = override.trim();
    const preferred = preferConsoleWrapper(trimmed, platform, exists);
    raw.push({ path: preferred, source: "env" });
    if (preferred !== trimmed) {
      raw.push({ path: trimmed, source: "env" });
    }
  }

  const pathEntries = splitPathValue(
    environmentValue(env, "PATH") ?? environmentValue(env, "Path") ?? "",
    platform,
  );
  const pathext = platform === "win32" ? normalisePathext(env) : [];
  const names = platform === "win32" ? ["soffice"] : ["soffice", "soffice.bin"];
  for (const directory of pathEntries) {
    for (const name of names) {
      if (platform === "win32") {
        for (const extension of pathext) {
          raw.push({
            path: api.join(directory, `${name}${extension}`),
            source: "path",
          });
        }
      } else {
        raw.push({ path: api.join(directory, name), source: "path" });
      }
    }
  }

  for (const candidate of standardPaths(platform, env)) {
    const source: LibreOfficeSource =
      platform === "win32"
        ? "standard-windows"
        : platform === "darwin"
          ? "standard-macos"
          : "standard-linux";
    raw.push({ path: candidate, source });
  }

  const seen = new Set<string>();
  const candidates: LibreOfficeCandidate[] = [];
  for (const entry of raw) {
    if (entry.path.includes("\u0000")) {
      candidates.push({
        path: entry.path,
        source: entry.source,
        exists: false,
        rejected: "nul-byte",
      });
      continue;
    }
    const key = platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const rejected = rejectionFor(entry.path, entry.source, platform);
    candidates.push({
      path: entry.path,
      source: entry.source,
      exists: safeExists(exists, entry.path),
      ...(rejected ? { rejected } : {}),
    });
  }
  return candidates;
}

/** Exposed for the tests: `standard-*` sources name the platform. */
export function libreOfficeStandardPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return standardPaths(platform, env);
}

export function classifyLibreOfficeCandidate(
  candidate: LibreOfficeCandidate,
  platform: NodeJS.Platform = process.platform,
): CandidateRejection | undefined {
  return rejectionFor(candidate.path, candidate.source, platform);
}

/* ------------------------------------------------------------ process run */

interface RunProcessOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface RunProcessResult extends ProcessProbe {
  command: string;
  args: string[];
}

function killChild(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may already be gone; the close/error handler reports it.
  }
}

function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  return new Promise<RunProcessResult>((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    const timers: {
      timeout?: ReturnType<typeof setTimeout>;
      hard?: ReturnType<typeof setTimeout>;
    } = {};
    let child: ReturnType<typeof spawn> | undefined;

    const finish = (
      exitCode: number | null,
      signal: string | null,
      spawnError?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (timers.hard) clearTimeout(timers.hard);
      const result: RunProcessResult = {
        command,
        args,
        exitCode,
        signal,
        stdout: stdout.slice(0, MAX_CAPTURED_OUTPUT),
        stderr: stderr.slice(0, MAX_CAPTURED_OUTPUT),
        timedOut,
        durationMs: Date.now() - started,
        ...(stdoutTruncated || stderrTruncated
          ? { outputTruncated: true }
          : {}),
        ...(spawnError
          ? {
              spawnError: {
                code: (spawnError as NodeJS.ErrnoException).code ?? "UNKNOWN",
                message: spawnError.message,
              },
            }
          : {}),
      };
      resolve(result);
    };

    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    } catch (error) {
      finish(null, null, error as Error);
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > MAX_CAPTURED_OUTPUT) {
        stdoutTruncated = true;
        stdout += chunk.slice(
          0,
          Math.max(0, MAX_CAPTURED_OUTPUT - stdout.length),
        );
      } else {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length + chunk.length > MAX_CAPTURED_OUTPUT) {
        stderrTruncated = true;
        stderr += chunk.slice(
          0,
          Math.max(0, MAX_CAPTURED_OUTPUT - stderr.length),
        );
      } else {
        stderr += chunk;
      }
    });
    child.on("error", (error: Error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));

    timers.timeout = setTimeout(() => {
      timedOut = true;
      if (child) killChild(child);
      // A detached grandchild can keep the pipes open. Never leave the caller
      // waiting forever: settle shortly after the kill even if `close` is late.
      timers.hard = setTimeout(() => finish(null, "SIGKILL"), 2_000);
      timers.hard.unref?.();
    }, options.timeoutMs);
    timers.timeout.unref?.();
  });
}

/* --------------------------------------------------------------- detection */

interface LaunchSpec {
  command: string;
  prefixArgs: string[];
  mode: "native" | "node-script";
}

function launchSpecFor(
  candidatePath: string,
  source: LibreOfficeSource | "none",
  platform: NodeJS.Platform,
): LaunchSpec | { rejection: CandidateRejection } {
  const rejected = rejectionFor(
    candidatePath,
    source as LibreOfficeSource,
    platform,
  );
  if (rejected && rejected !== "script-shim-not-auto-detected") {
    return { rejection: rejected };
  }
  if (rejected === "script-shim-not-auto-detected") {
    return { rejection: rejected };
  }
  const extension = pathApiFor(platform).extname(candidatePath).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return {
      command: process.execPath,
      prefixArgs: [candidatePath],
      mode: "node-script",
    };
  }
  return { command: candidatePath, prefixArgs: [], mode: "native" };
}

function parseVersion(stdout: string): string | undefined {
  const match = VERSION_PATTERN.exec(stdout);
  return match?.[1];
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

const detectionCache = new Map<string, LibreOfficeDetection>();

export function clearLibreOfficeCache(): void {
  detectionCache.clear();
}

function detectionCacheKey(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  return [
    platform,
    environmentValue(env, "DSH_SOFFICE_PATH") ?? "",
    environmentValue(env, "PATH") ?? environmentValue(env, "Path") ?? "",
    environmentValue(env, "PATHEXT") ?? "",
  ].join("\u0000");
}

const OPTION_KEYS = new Set([
  "env",
  "platform",
  "refresh",
  "timeoutMs",
  "exists",
]);

function looksLikeOptions(input: object): boolean {
  return Object.keys(input).some((key) => OPTION_KEYS.has(key));
}

/**
 * Detects a usable LibreOffice binary.
 *
 * Accepts either an options object or a plain environment object; a plain
 * environment is treated as `{ env }`. The result is cached per environment and
 * platform until `refresh: true` (or `clearLibreOfficeCache()`).
 */
export async function detectLibreOffice(
  input: DetectLibreOfficeOptions | NodeJS.ProcessEnv = {},
): Promise<LibreOfficeDetection> {
  const options: DetectLibreOfficeOptions =
    looksLikeOptions(input as object) && !Array.isArray(input)
      ? (input as DetectLibreOfficeOptions)
      : { env: input as NodeJS.ProcessEnv };
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const key = detectionCacheKey(env, platform);
  if (options.refresh !== true) {
    const cached = detectionCache.get(key);
    if (cached) return { ...cached, cached: true };
  } else {
    detectionCache.delete(key);
  }

  const candidates = libreOfficeCandidates({
    env,
    platform,
    exists: options.exists,
  });
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 60_000)
      : DEFAULT_DETECTION_TIMEOUT_MS;
  const attempts: DetectionAttempt[] = [];
  const existing = candidates.filter((candidate) => candidate.exists);
  let available: LibreOfficeDetection | undefined;

  for (const candidate of existing) {
    if (candidate.rejected) {
      attempts.push({
        path: candidate.path,
        reason: `candidate-rejected:${candidate.rejected}`,
      });
      continue;
    }
    if (isDirectory(candidate.path)) {
      attempts.push({ path: candidate.path, reason: "candidate-not-file" });
      continue;
    }
    // On Windows `soffice.exe` is a GUI launcher that detaches immediately and
    // leaves `soffice.bin` behind; never probe it when auto-discovered without
    // the synchronous `soffice.com` wrapper next to it.
    if (
      platform === "win32" &&
      candidate.source !== "env" &&
      candidate.path.toLowerCase().endsWith("soffice.exe")
    ) {
      const wrapper = `${candidate.path.slice(0, -4)}.com`;
      const exists = options.exists ?? existsSync;
      if (!safeExists(exists, wrapper)) {
        attempts.push({
          path: candidate.path,
          reason: "windows-launcher-detaches",
        });
        continue;
      }
    }
    const launch = launchSpecFor(candidate.path, candidate.source, platform);
    if ("rejection" in launch) {
      attempts.push({
        path: candidate.path,
        reason: `candidate-rejected:${launch.rejection}`,
      });
      continue;
    }
    const probe = await runProcess(
      launch.command,
      [...launch.prefixArgs, "--version"],
      { timeoutMs, env },
    );
    if (probe.spawnError) {
      attempts.push({
        path: candidate.path,
        reason: `spawn-${probe.spawnError.code.toLowerCase()}`,
        probe,
      });
      continue;
    }
    if (probe.timedOut) {
      attempts.push({
        path: candidate.path,
        reason: "version-timeout",
        probe,
      });
      continue;
    }
    if (probe.exitCode !== 0) {
      attempts.push({
        path: candidate.path,
        reason: "version-exit-nonzero",
        probe,
      });
      continue;
    }
    if (probe.stdout.trim().length === 0) {
      attempts.push({
        path: candidate.path,
        reason: "version-empty",
        probe,
      });
      continue;
    }
    const version = parseVersion(probe.stdout);
    if (!version) {
      attempts.push({
        path: candidate.path,
        reason: "version-unrecognized",
        probe,
      });
      continue;
    }
    available = {
      available: true,
      path: candidate.path,
      version,
      source: candidate.source,
      candidates,
      attempts,
      checkedAt: new Date().toISOString(),
      installHint: LIBREOFFICE_INSTALL_HINT,
    };
    break;
  }

  if (!available) {
    let reason = "not-found";
    if (existing.length > 0) {
      reason =
        attempts.length > 0
          ? attempts[attempts.length - 1].reason
          : "no-executable-candidate";
    }
    available = {
      available: false,
      path: null,
      source: "none",
      candidates,
      reason,
      attempts,
      checkedAt: new Date().toISOString(),
      installHint: LIBREOFFICE_INSTALL_HINT,
    };
  }

  detectionCache.set(key, available);
  return available;
}

/* ------------------------------------------------------- conversion format */

export interface ResolvedConversionFormat {
  extension: string;
  filter: string;
  /** The exact argument passed to `--convert-to`. */
  convertTo: string;
  definition: LibreOfficeFormatDefinition;
}

export function resolveConversionFormat(
  format: string,
): ResolvedConversionFormat {
  if (typeof format !== "string") {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "Conversion format must be a string",
      { format },
    );
  }
  if (format.includes("\u0000")) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "Conversion format must not contain NUL bytes",
    );
  }
  const trimmed = format.trim();
  if (trimmed.length === 0 || trimmed.length > 160) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "Conversion format must be 1-160 characters",
      { length: trimmed.length },
    );
  }
  if (/[\r\n]/.test(trimmed) || trimmed.includes("\u0000")) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "Conversion format must not contain control characters",
    );
  }
  const match = /^([A-Za-z0-9]+)(?::(.*))?$/.exec(trimmed);
  if (!match) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      `Unsupported conversion format: ${format}`,
      { format },
    );
  }
  const extension = match[1].toLowerCase();
  const definition = LIBREOFFICE_CONVERSION_FORMATS[extension];
  if (!definition) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      `LibreOffice conversion does not support '${extension}'`,
      { format, supported: supportedLibreOfficeFormats() },
    );
  }
  const explicitFilter = match[2]?.trim();
  if (explicitFilter !== undefined && explicitFilter.length === 0) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "An explicit LibreOffice filter must not be empty",
      { format },
    );
  }
  if (
    explicitFilter !== undefined &&
    (explicitFilter.length > 120 ||
      /[\r\n]/.test(explicitFilter) ||
      explicitFilter.includes("\u0000"))
  ) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "LibreOffice filter names must be 1-120 printable characters",
      { format },
    );
  }
  const filter = explicitFilter ?? definition.filter;
  return {
    extension,
    filter,
    convertTo: `${extension}:${filter}`,
    definition,
  };
}

/* --------------------------------------------------------------- conversion */

export interface ConvertWithLibreOfficeOptions {
  inputPath: string;
  /** `docx`, `odt`, `rtf`, `txt`, `html`, `pdf`, or `ext:Filter Name`. */
  format: string;
  /** Optional workspace-confined destination for the converted bytes. */
  outputPath?: string;
  /** Conversion timeout; default 60 s, accepted range 50 ms - 600 s. */
  timeoutMs?: number;
  /** Environment used for detection and the child process. */
  env?: NodeJS.ProcessEnv;
  /** Reuse an existing detection instead of running detection again. */
  detection?: LibreOfficeDetection;
  /** Refuse to write when an output path is supplied. */
  readOnly?: boolean;
  /** When set, `outputPath` must stay inside this directory. */
  workspaceRoot?: string;
  /** Internal/test hook: directory that holds per-call temporary folders. */
  tempDirectory?: string;
}

export interface LibreOfficeConversionResult {
  ok: true;
  engine: "libreoffice";
  version: string | null;
  executable: string;
  format: string;
  filter: string;
  inputPath: string;
  path: string | null;
  bytes: number;
  sha256: string;
  durationMs: number;
  warnings: string[];
  command: { executable: string; args: string[] };
  userProfile: string;
  stdout: string;
  stderr: string;
  /** Base64 payload when no output path was requested. */
  dataBase64?: string;
}

interface InternalConversion {
  buffer: Buffer;
  outputPath: string | null;
  result: LibreOfficeConversionResult;
  detection: LibreOfficeDetection;
}

function assertUsablePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new LibreOfficeError("INVALID_ARGUMENT", `${label} must be a string`);
  }
  if (value.includes("\u0000")) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `${label} must not contain NUL bytes`,
    );
  }
  if (value.length === 0) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `${label} must not be empty`,
    );
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `${label} exceeds ${MAX_PATH_LENGTH} characters`,
      { length: value.length },
    );
  }
  return value;
}

export function normalizeConversionTimeout(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_CONVERSION_TIMEOUT_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      "timeoutMs must be a finite integer",
      { timeoutMs: value },
    );
  }
  if (value < MIN_CONVERSION_TIMEOUT_MS || value > MAX_CONVERSION_TIMEOUT_MS) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `timeoutMs must be between ${MIN_CONVERSION_TIMEOUT_MS} and ${MAX_CONVERSION_TIMEOUT_MS}`,
      { timeoutMs: value },
    );
  }
  return value;
}

function assertOutputExtension(outputPath: string, extension: string): void {
  const actual = path.extname(outputPath).slice(1).toLowerCase();
  if (actual !== extension) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `Output extension .${actual || "(none)"} does not match requested format .${extension}`,
      { outputPath, extension },
    );
  }
}

function assertInsideWorkspace(
  workspaceRoot: string,
  outputPath: string,
): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(outputPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LibreOfficeError(
      "PATH_OUTSIDE_WORKSPACE",
      "Conversion output must stay inside the workspace",
      { workspaceRoot: root, outputPath: target },
    );
  }
}

function tail(value: string, limit = 4_000): string {
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function collectWarnings(stdout: string, stderr: string): string[] {
  const warnings: string[] = [];
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    if (!/warn/i.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (warnings.includes(trimmed)) continue;
    warnings.push(trimmed);
    if (warnings.length >= 20) break;
  }
  return warnings;
}

async function findProducedFile(
  outputDirectory: string,
  expectedName: string,
  extension: string,
): Promise<string | undefined> {
  const expected = path.join(outputDirectory, expectedName);
  try {
    const info = await stat(expected);
    if (info.isFile()) return expected;
  } catch {
    // Fall through to a case-insensitive scan of the output directory.
  }
  let entries: string[] = [];
  try {
    entries = await readdir(outputDirectory);
  } catch {
    return undefined;
  }
  const suffix = `.${extension}`.toLowerCase();
  const matching = entries.filter((entry) =>
    entry.toLowerCase().endsWith(suffix),
  );
  if (matching.length === 1) {
    return path.join(outputDirectory, matching[0]);
  }
  return undefined;
}

async function performConversion(
  options: ConvertWithLibreOfficeOptions,
): Promise<InternalConversion> {
  const inputPath = assertUsablePath(options.inputPath, "inputPath");
  if (!path.isAbsolute(inputPath)) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      "inputPath must be absolute",
      { inputPath },
    );
  }
  let inputInfo;
  try {
    inputInfo = await stat(inputPath);
  } catch {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `Input file does not exist: ${inputPath}`,
      { inputPath },
    );
  }
  if (!inputInfo.isFile()) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      `Input path is not a file: ${inputPath}`,
      { inputPath },
    );
  }
  const inputExtension = path.extname(inputPath).slice(1).toLowerCase();
  if (!supportedInputExtensions().has(inputExtension)) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      `Unsupported input extension .${inputExtension || "(none)"}`,
      { inputPath, supported: [...supportedInputExtensions()] },
    );
  }

  const resolvedFormat = resolveConversionFormat(options.format);
  if (!resolvedFormat.definition.inputExtensions.includes(inputExtension)) {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      `Cannot convert .${inputExtension} to ${resolvedFormat.extension}`,
      {
        inputExtension,
        format: resolvedFormat.extension,
        supportedInputs: resolvedFormat.definition.inputExtensions,
      },
    );
  }

  const timeoutMs = normalizeConversionTimeout(options.timeoutMs);

  let outputPath: string | undefined;
  if (options.outputPath !== undefined) {
    outputPath = assertUsablePath(options.outputPath, "outputPath");
    if (!path.isAbsolute(outputPath)) {
      throw new LibreOfficeError(
        "INVALID_ARGUMENT",
        "outputPath must be absolute",
        { outputPath },
      );
    }
    assertOutputExtension(outputPath, resolvedFormat.extension);
    if (options.workspaceRoot) {
      assertInsideWorkspace(options.workspaceRoot, outputPath);
    }
    if (options.readOnly === true) {
      throw new LibreOfficeError(
        "READ_ONLY_MODE",
        "The workspace is read-only; external conversion cannot write output",
        { outputPath },
      );
    }
    try {
      const existing = await stat(outputPath);
      if (existing.isDirectory()) {
        throw new LibreOfficeError(
          "INVALID_ARGUMENT",
          `Output path is a directory: ${outputPath}`,
          { outputPath },
        );
      }
    } catch (error) {
      if (error instanceof LibreOfficeError) throw error;
      // ENOENT is expected for a new output file.
    }
  }

  const detection =
    options.detection ?? (await detectLibreOffice({ env: options.env }));
  if (!detection.available || !detection.path) {
    throw new LibreOfficeError(
      "ENGINE_UNAVAILABLE",
      `LibreOffice is not available (${detection.reason ?? "not found"}); ${LIBREOFFICE_INSTALL_HINT}`,
      { detection },
    );
  }

  const launch = launchSpecFor(
    detection.path,
    detection.source as LibreOfficeSource,
    process.platform,
  );
  if ("rejection" in launch) {
    throw new LibreOfficeError(
      "ENGINE_UNAVAILABLE",
      `The detected LibreOffice executable cannot be launched without a shell (${launch.rejection})`,
      { detection, rejection: launch.rejection },
    );
  }

  const tempDirectory =
    options.tempDirectory ?? path.join(tmpdir(), "dsh-libreoffice-");
  const tempRoot = await mkdtemp(tempDirectory).catch((error: Error) => {
    throw new LibreOfficeError(
      "ENGINE_FAILED",
      `Could not create a temporary conversion directory: ${error.message}`,
    );
  });
  const outDirectory = path.join(tempRoot, "out");
  const userProfile = path.join(tempRoot, "profile");
  const profileUrl = pathToFileURL(userProfile).href;

  try {
    await mkdir(outDirectory, { recursive: true });
    await mkdir(userProfile, { recursive: true });

    const args = [
      `-env:UserInstallation=${profileUrl}`,
      "--headless",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--convert-to",
      resolvedFormat.convertTo,
      "--outdir",
      outDirectory,
      inputPath,
    ];
    const command = launch.command;
    const fullArgs = [...launch.prefixArgs, ...args];
    const started = Date.now();
    const probe = await runProcess(command, fullArgs, {
      timeoutMs,
      env: options.env,
      cwd: tempRoot,
    });
    const durationMs = Date.now() - started;

    if (probe.spawnError) {
      throw new LibreOfficeError(
        "ENGINE_UNAVAILABLE",
        `LibreOffice could not be started (${probe.spawnError.code}): ${probe.spawnError.message}`,
        {
          detection,
          executable: command,
          spawnError: probe.spawnError,
        },
      );
    }
    if (probe.timedOut) {
      throw new LibreOfficeError(
        "ENGINE_TIMEOUT",
        `LibreOffice conversion exceeded ${timeoutMs} ms and was killed`,
        {
          timeoutMs,
          durationMs,
          executable: command,
          args: fullArgs,
          stdoutTail: tail(probe.stdout),
          stderrTail: tail(probe.stderr),
          detection,
        },
      );
    }
    if (probe.exitCode !== 0 || (probe.exitCode === null && probe.signal)) {
      throw new LibreOfficeError(
        "ENGINE_FAILED",
        `LibreOffice exited with ${probe.signal ? `signal ${probe.signal}` : `code ${probe.exitCode}`}`,
        {
          exitCode: probe.exitCode,
          signal: probe.signal,
          executable: command,
          args: fullArgs,
          stdoutTail: tail(probe.stdout),
          stderrTail: tail(probe.stderr),
          detection,
        },
      );
    }

    const expectedName = `${path.parse(inputPath).name}.${resolvedFormat.extension}`;
    const produced = await findProducedFile(
      outDirectory,
      expectedName,
      resolvedFormat.extension,
    );
    if (!produced) {
      throw new LibreOfficeError(
        "OUTPUT_MISSING",
        `LibreOffice reported success but produced no .${resolvedFormat.extension} file`,
        {
          expectedName,
          outDirectoryFiles: await readdir(outDirectory).catch(() => []),
          executable: command,
          args: fullArgs,
          stdoutTail: tail(probe.stdout),
          stderrTail: tail(probe.stderr),
        },
      );
    }
    let producedInfo;
    try {
      producedInfo = await stat(produced);
    } catch {
      throw new LibreOfficeError(
        "OUTPUT_MISSING",
        `LibreOffice output disappeared before it could be read: ${produced}`,
        { produced, executable: command, args: fullArgs },
      );
    }
    if (!producedInfo.isFile()) {
      throw new LibreOfficeError(
        "OUTPUT_MISSING",
        `LibreOffice output is not a file: ${produced}`,
        { produced, executable: command, args: fullArgs },
      );
    }
    if (producedInfo.size === 0) {
      throw new LibreOfficeError(
        "OUTPUT_MISSING",
        `LibreOffice produced an empty file: ${produced}`,
        { produced, bytes: 0, executable: command, args: fullArgs },
      );
    }

    const buffer = await readFile(produced).catch((error: Error) => {
      throw new LibreOfficeError(
        "ENGINE_FAILED",
        `Could not read LibreOffice output: ${error.message}`,
        { produced },
      );
    });
    const sha256 = createHash("sha256").update(buffer).digest("hex");

    if (outputPath !== undefined) {
      try {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, buffer);
      } catch (error) {
        throw new LibreOfficeError(
          "ENGINE_FAILED",
          `Could not write the converted file: ${(error as Error).message}`,
          { outputPath },
        );
      }
    }

    const result: LibreOfficeConversionResult = {
      ok: true,
      engine: "libreoffice",
      version: detection.version ?? null,
      executable: detection.path,
      format: resolvedFormat.extension,
      filter: resolvedFormat.filter,
      inputPath,
      path: outputPath ?? null,
      bytes: buffer.byteLength,
      sha256,
      durationMs,
      warnings: collectWarnings(probe.stdout, probe.stderr),
      command: { executable: command, args: fullArgs },
      userProfile: profileUrl,
      stdout: probe.stdout,
      stderr: probe.stderr,
      ...(outputPath === undefined
        ? { dataBase64: buffer.toString("base64") }
        : {}),
    };
    return { buffer, outputPath: outputPath ?? null, result, detection };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Converts one document through LibreOffice. The temporary profile and output
 * directory are always removed. When `outputPath` is omitted the bytes are
 * returned as base64; when it is present they are written there and also
 * reported as a size and SHA-256.
 */
export async function convertWithLibreOffice(
  options: ConvertWithLibreOfficeOptions,
): Promise<LibreOfficeConversionResult> {
  const { result } = await performConversion(options);
  return result;
}

export interface RenderPdfResult {
  engine: "libreoffice";
  bytes: number;
  sha256: string;
  buffer: Buffer;
  dataBase64: string;
  durationMs: number;
  version: string | null;
  path: null;
  warnings: string[];
}

/**
 * Differential hook: renders a DOCX with LibreOffice and returns the PDF bytes
 * plus their SHA-256. Nothing is compared pixel-by-pixel here.
 */
export async function renderPdfWithLibreOffice(
  docxPath: string,
  options: Omit<
    ConvertWithLibreOfficeOptions,
    "inputPath" | "format" | "outputPath"
  > = {},
): Promise<RenderPdfResult> {
  const validated = assertUsablePath(docxPath, "docxPath");
  if (!path.isAbsolute(validated)) {
    throw new LibreOfficeError(
      "INVALID_ARGUMENT",
      "docxPath must be absolute",
      { docxPath: validated },
    );
  }
  const extension = path.extname(validated).slice(1).toLowerCase();
  if (extension !== "docx" && extension !== "dotx") {
    throw new LibreOfficeError(
      "FORMAT_UNSUPPORTED",
      "renderPdfWithLibreOffice expects a .docx or .dotx input",
      { docxPath: validated, extension },
    );
  }
  const { result } = await performConversion({
    ...options,
    inputPath: validated,
    format: "pdf",
  });
  const buffer = Buffer.from(result.dataBase64 ?? "", "base64");
  return {
    engine: "libreoffice",
    bytes: buffer.byteLength,
    sha256: result.sha256,
    buffer,
    dataBase64: result.dataBase64 ?? "",
    durationMs: result.durationMs,
    version: result.version,
    path: null,
    warnings: result.warnings,
  };
}

/* ------------------------------------------------------- differential PDF */

export interface PdfEngineSide {
  present: boolean;
  bytes: number;
  sha256?: string;
  pageCount?: number;
  path?: string | null;
  reason?: string;
}

export interface PdfEngineComparison {
  docxPath: string;
  internal: PdfEngineSide;
  libreoffice: PdfEngineSide;
  bothPresent: boolean;
  byteIdentical: boolean;
  /** This helper never performs raster comparison. */
  pixelComparison: "not-performed";
  notes: string[];
  checkedAt: string;
}

/** Counts `/Type /Page` objects; returns undefined when the PDF is unreadable. */
export function countPdfPages(bytes: Buffer): number | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  const text = bytes.toString("latin1");
  if (!text.includes("%PDF-")) return undefined;
  const matches = text.match(/\/Type\s*\/Page(?![s])/g);
  return matches ? matches.length : undefined;
}

async function readPdfSide(
  input: Buffer | string | null | undefined,
  label: string,
  notes: string[],
): Promise<PdfEngineSide> {
  let bytes: Buffer | undefined;
  let sourcePath: string | null = null;
  if (Buffer.isBuffer(input)) {
    bytes = input;
  } else if (typeof input === "string" && input.length > 0) {
    sourcePath = input;
    try {
      const info = await stat(input);
      if (info.isFile()) bytes = await readFile(input);
      else notes.push(`${label}: path is not a file`);
    } catch {
      notes.push(`${label}: PDF path does not exist`);
    }
  }
  if (!bytes || bytes.byteLength === 0) {
    notes.push(`${label}: no PDF bytes were supplied`);
    return {
      present: false,
      bytes: 0,
      path: sourcePath,
      reason: "missing",
    };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pageCount = countPdfPages(bytes);
  const isPdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!isPdf) notes.push(`${label}: bytes do not start with %PDF-`);
  return {
    present: true,
    bytes: bytes.byteLength,
    sha256,
    ...(pageCount === undefined ? {} : { pageCount }),
    path: sourcePath,
    ...(isPdf ? {} : { reason: "not-pdf-magic" }),
  };
}

/**
 * Reports whether the internal renderer and LibreOffice both produced a PDF for
 * the same DOCX, with honest sizes/page counts. It deliberately does not claim
 * visual equivalence: byte identity is reported, pixel comparison is not done.
 */
export async function comparePdfEngines(input: {
  docxPath: string;
  internalPdf?: Buffer | string | null;
  libreOfficePdf?: Buffer | string | null;
  libreOfficeResult?: RenderPdfResult | null;
}): Promise<PdfEngineComparison> {
  const docxPath = assertUsablePath(input.docxPath, "docxPath");
  const notes: string[] = [];
  const internal = await readPdfSide(input.internalPdf, "internal PDF", notes);
  const libreOffice = await readPdfSide(
    input.libreOfficeResult
      ? input.libreOfficeResult.buffer
      : input.libreOfficePdf,
    "LibreOffice PDF",
    notes,
  );
  if (internal.present && libreOffice.present) {
    if (
      internal.pageCount === undefined ||
      libreOffice.pageCount === undefined
    ) {
      notes.push("page counts could not be parsed from at least one PDF");
    }
    if (internal.pageCount !== libreOffice.pageCount) {
      notes.push(
        `page counts differ (internal ${internal.pageCount ?? "?"}, LibreOffice ${libreOffice.pageCount ?? "?"})`,
      );
    }
  }
  return {
    docxPath,
    internal,
    libreoffice: libreOffice,
    bothPresent: internal.present && libreOffice.present,
    byteIdentical:
      internal.present &&
      libreOffice.present &&
      internal.sha256 === libreOffice.sha256,
    pixelComparison: "not-performed",
    notes,
    checkedAt: new Date().toISOString(),
  };
}
