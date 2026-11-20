/**
 * Real-process tests for the optional LibreOffice engine adapter.
 *
 * LibreOffice is not installed on this machine, so every process interaction
 * uses a fake `soffice` written as a Node script into a temporary directory and
 * selected through `DSH_SOFFICE_PATH`. The adapter launches it with
 * `spawn(..., { shell: false })`; no `child_process` function is mocked.
 *
 * The suites are table-driven and report their case counts. Three groups are
 * covered: detection, conversion arguments/validation, and error mapping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearLibreOfficeCache,
  comparePdfEngines,
  convertWithLibreOffice,
  countPdfPages,
  detectLibreOffice,
  libreOfficeCandidates,
  LibreOfficeError,
  renderPdfWithLibreOffice,
  resolveConversionFormat,
  type DetectLibreOfficeOptions,
  type LibreOfficeCandidate,
  type LibreOfficeDetection,
} from "../../src/engine/libreoffice.js";
import { DocumentService } from "../../src/service/service.js";

/* ------------------------------------------------------------ fake soffice */

const FAKE_SOFFICE_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const versionMode = process.env.DSH_FAKE_VERSION_MODE || "ok";
const convertMode = process.env.DSH_FAKE_MODE || "ok";
const logFile = process.env.DSH_FAKE_LOG;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profileArg = args.find((entry) => entry.startsWith("-env:UserInstallation="));
let profilePath = null;
if (profileArg) {
  try {
    profilePath = fileURLToPath(profileArg.slice("-env:UserInstallation=".length));
  } catch {
    profilePath = null;
  }
}
function log(extra) {
  if (!logFile) return;
  try {
    appendFileSync(
      logFile,
      JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        versionMode,
        convertMode,
        args,
        profile: profilePath,
        profileExisted: profilePath ? existsSync(profilePath) : false,
        ...extra,
      }) + "\\n",
    );
  } catch {
    // Logging is diagnostic only.
  }
}
if (args.includes("--version")) {
  log({ kind: "version" });
  if (versionMode === "sleep") {
    await sleep(15000);
    console.log("LibreOffice 24.2.1.2");
    process.exit(0);
  }
  if (versionMode === "fail") {
    console.error("fake version failure FAKE_VERSION_FAIL");
    process.exit(3);
  }
  if (versionMode === "signal") {
    process.kill(process.pid, "SIGKILL");
    await sleep(500);
    process.exit(0);
  }
  if (versionMode === "garbage") {
    console.log("banana split FAKE_GARBAGE");
    process.exit(0);
  }
  if (versionMode === "number-only") {
    console.log("24.2.1.2");
    process.exit(0);
  }
  if (versionMode === "empty") {
    process.exit(0);
  }
  if (versionMode === "stderr") {
    console.error("LibreOffice 24.2.1.2");
    process.exit(0);
  }
  if (versionMode === "lowercase") {
    console.log("libreoffice 7.6.4.1 30(Build:1)");
    process.exit(0);
  }
  if (versionMode === "prefix") {
    console.log("welcome; LibreOffice 6.4.7.2 is available");
    process.exit(0);
  }
  console.log("LibreOffice 24.2.1.2 30(Build:2)");
  process.exit(0);
}
const outdirIndex = args.indexOf("--outdir");
const convertIndex = args.indexOf("--convert-to");
const filter = convertIndex >= 0 ? args[convertIndex + 1] : "pdf";
const extension = String(filter).split(":")[0];
const input = args[args.length - 1];
const base = path.basename(input).replace(/\\.[^.]+$/, "");
const outdir = outdirIndex >= 0 ? args[outdirIndex + 1] : null;
const outFile = outdir ? path.join(outdir, base + "." + extension) : null;
log({ kind: "convert", filter, outdir, outFile });
function writeOut(content) {
  if (!outFile) return;
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, content);
}
if (convertMode === "sleep" || convertMode === "grandchild") {
  if (convertMode === "grandchild") {
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  await sleep(15000);
  writeOut("%PDF-1.4 late");
  process.exit(0);
}
if (convertMode === "exit1") {
  console.error("Error: source file could not be loaded FAKE_EXIT_1");
  process.exit(1);
}
if (convertMode === "exit1-marker") {
  console.error("FAKE_MARKER:" + (process.env.DSH_FAKE_MARKER || "none"));
  process.exit(1);
}
if (convertMode === "exit-custom") {
  console.error("FAKE_CUSTOM:" + (process.env.DSH_FAKE_EXIT || "1"));
  process.exit(Number(process.env.DSH_FAKE_EXIT || "1"));
}
if (
  convertMode === "signal" ||
  convertMode === "signal-term" ||
  convertMode === "signal-int" ||
  convertMode === "signal-hup"
) {
  const signal =
    convertMode === "signal"
      ? "SIGKILL"
      : convertMode === "signal-term"
        ? "SIGTERM"
        : convertMode === "signal-int"
          ? "SIGINT"
          : "SIGHUP";
  process.kill(process.pid, signal);
  await sleep(500);
  process.exit(0);
}
if (convertMode === "zero") {
  writeOut("");
  process.exit(0);
}
if (convertMode === "missing") {
  process.exit(0);
}
if (convertMode === "wrong-extension") {
  if (outdir) writeFileSync(path.join(outdir, base + ".pdfx"), "%PDF-1.4 wrong ext");
  process.exit(0);
}
if (convertMode === "partial-then-fail") {
  writeOut("%PDF-1.4 partial");
  console.error("partial write then failure FAKE_PARTIAL");
  process.exit(1);
}
if (convertMode === "warn") {
  writeOut("%PDF-1.4 ok");
  console.error("Warning: fake fallback used FAKE_WARNING");
  process.exit(0);
}
if (convertMode === "empty-stdout") {
  writeOut("%PDF-1.4 ok");
  process.exit(0);
}
writeOut("%PDF-1.4\\nfake " + filter + " " + process.pid + "\\n%%EOF\\n");
`;

/* --------------------------------------------------------------- fixtures */

let baseDir = "";
let root = "";
let workspace = "";
let fakePath = "";
let fakeUpperPath = "";
let logsDir = "";
let nonexecPath = "";
let cmdPath = "";
let batPath = "";
let directoryPath = "";
let caseCounter = 0;

const inputs: Record<string, string> = {};

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "dsh-lo-engine-"));
  root = path.join(baseDir, "engine tests with spaces é");
  workspace = path.join(root, "workspace");
  logsDir = path.join(root, "logs");
  await mkdir(workspace, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  fakePath = path.join(root, "fake soffice é.mjs");
  fakeUpperPath = path.join(root, "FAKE SOFFICE.mjs");
  await writeFile(fakePath, FAKE_SOFFICE_SOURCE, "utf8");
  await copyFile(fakePath, fakeUpperPath);

  const files: Record<string, string> = {
    docx: "sample input.docx",
    odt: "sample input.odt",
    rtf: "sample input.rtf",
    txt: "sample input.txt",
    html: "sample input.html",
    htm: "sample input.htm",
    dotx: "sample input.dotx",
    upper: "UPPER.DOCX",
    spaces: "input with spaces é.docx",
    simple: "sample.docx",
  };
  for (const [key, name] of Object.entries(files)) {
    inputs[key] = path.join(root, name);
    await writeFile(inputs[key], `fake ${key} input`, "utf8");
  }

  cmdPath = path.join(root, "soffice shim.cmd");
  batPath = path.join(root, "soffice shim.bat");
  await writeFile(
    cmdPath,
    "@echo off\r\necho LibreOffice 24.2.1.2\r\n",
    "utf8",
  );
  await writeFile(
    batPath,
    "@echo off\r\necho LibreOffice 24.2.1.2\r\n",
    "utf8",
  );

  directoryPath = path.join(root, "soffice-directory");
  await mkdir(directoryPath, { recursive: true });
  nonexecPath =
    process.platform === "win32"
      ? path.join(root, "not-executable.exe")
      : path.join(root, "not-executable-soffice");
  await writeFile(nonexecPath, "not an executable", "utf8");
  if (process.platform !== "win32") {
    await chmod(nonexecPath, 0o644);
  }
}, 60_000);

afterAll(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- helpers */

interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

function uniqueLog(label: string): string {
  caseCounter += 1;
  const safe = label.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);
  return path.join(
    logsDir,
    `${String(caseCounter).padStart(4, "0")}-${safe}.log`,
  );
}

function fakeEnv(
  log: string,
  modes: {
    version?: string;
    convert?: string;
    marker?: string;
    exitCode?: string;
    extra?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_SOFFICE_PATH: fakePath,
    DSH_FAKE_VERSION_MODE: modes.version ?? "ok",
    DSH_FAKE_MODE: modes.convert ?? "ok",
    DSH_FAKE_LOG: log,
    // Keep probe outcomes deterministic even if the host has a partial
    // LibreOffice installation at a standard location.
    ProgramFiles: path.join(root, "missing-program-files"),
    "ProgramFiles(x86)": path.join(root, "missing-program-files-x86"),
    LOCALAPPDATA: path.join(root, "missing-local-app-data"),
    ...(modes.marker === undefined ? {} : { DSH_FAKE_MARKER: modes.marker }),
    ...(modes.exitCode === undefined ? {} : { DSH_FAKE_EXIT: modes.exitCode }),
    ...modes.extra,
  };
}

async function readLog(logPath: string): Promise<any[]> {
  try {
    const raw = await readFile(logPath, "utf8");
    return raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any);
  } catch {
    return [];
  }
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<LibreOfficeError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`Expected ${code}, but the call succeeded`);
  }
  if (!(caught instanceof LibreOfficeError)) throw caught;
  expect(caught.code).toBe(code);
  return caught;
}

function candidateSet(platform: NodeJS.Platform, files: string[]): Set<string> {
  return new Set(
    files.map((file) => (platform === "win32" ? file.toLowerCase() : file)),
  );
}

function candidatesFor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  files: string[],
): LibreOfficeCandidate[] {
  const exists = candidateSet(platform, files);
  return libreOfficeCandidates({
    env,
    platform,
    exists: (candidate: string) =>
      exists.has(platform === "win32" ? candidate.toLowerCase() : candidate),
  });
}

function absentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: "",
    PATHEXT: ".EXE",
    DSH_SOFFICE_PATH: path.join(root, "missing soffice é.mjs"),
    ProgramFiles: path.join(root, "missing-program-files"),
    "ProgramFiles(x86)": path.join(root, "missing-program-files-x86"),
    LOCALAPPDATA: path.join(root, "missing-local-app-data"),
  };
}

/* =============================================================== detection */

const detectionCases: TestCase[] = [];

const overrideRows: Array<{
  path: string;
  expectedPath?: string;
  rejection?: string;
}> = [
  { path: "C:\\Program Files\\LibreOffice\\program\\soffice.exe" },
  { path: "C:\\Program Files\\LibreOffice – éd\\soffice.exe" },
  { path: "C:\\Libre Office\\soffice.exe" },
  { path: "C:\\tools\\soffice.EXE" },
  { path: "C:\\tools\\SoFfIcE.ExE" },
  { path: "C:\\tools\\soffice.com" },
  {
    path: "C:\\tools\\soffice.cmd",
    rejection: "windows-batch-requires-shell",
  },
  {
    path: "C:\\tools\\soffice.BAT",
    rejection: "windows-batch-requires-shell",
  },
  { path: "C:\\tools\\soffice.ps1", rejection: "unsupported-script" },
  { path: "C:\\tools\\soffice.vbs", rejection: "unsupported-script" },
  { path: "C:\\tools\\soffice.js" },
  { path: "C:\\tools\\soffice.mjs" },
  { path: "C:\\tools\\soffice.cjs" },
  { path: "\\\\server\\share\\soffice.exe" },
  { path: "relative\\soffice.exe", rejection: "not-absolute" },
  { path: "soffice.exe", rejection: "not-absolute" },
  {
    path: '"C:\\Program Files\\LibreOffice\\program\\soffice.exe"',
    rejection: "not-absolute",
  },
  { path: "C:/Program Files/LibreOffice/program/soffice.exe" },
  { path: `C:\\tools\\${"x".repeat(300)}\\soffice.exe` },
  { path: "C:\\tools\\SÖFFICE.EXE" },
];

overrideRows.forEach((row, index) => {
  for (const exists of [true, false]) {
    detectionCases.push({
      name: `env override #${index} ${row.rejection ?? "valid"} exists=${exists}`,
      run: () => {
        const files = exists ? [row.path] : [];
        const candidates = candidatesFor(
          { DSH_SOFFICE_PATH: row.path },
          "win32",
          files,
        );
        const first = candidates[0];
        expect(first).toBeDefined();
        expect(first.source).toBe("env");
        expect(first.path).toBe(row.path);
        expect(first.exists).toBe(exists && !row.path.includes("\u0000"));
        expect(first.rejected).toBe(row.rejection);
      },
    });
  }
});

const pathRows: Array<{
  name: string;
  env: NodeJS.ProcessEnv;
  files: string[];
  check: (candidates: LibreOfficeCandidate[], exists: boolean) => void;
}> = [
  {
    name: "single PATHEXT .EXE",
    env: { PATH: "C:\\Tools", PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      const first = candidates[0];
      expect(first.path).toBe("C:\\Tools\\soffice.exe");
      expect(first.source).toBe("path");
    },
  },
  {
    name: "lowercase PATHEXT",
    env: { PATH: "C:\\Tools", PATHEXT: ".exe" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "mixed case PATHEXT builds lowercase extension",
    env: { PATH: "C:\\Tools", PATHEXT: ".ExE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "exe before cmd in PATHEXT",
    env: { PATH: "C:\\Tools", PATHEXT: ".CMD;.EXE" },
    files: ["C:\\Tools\\soffice.exe", "C:\\Tools\\soffice.cmd"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
      const command = candidates.find((entry) =>
        entry.path.toLowerCase().endsWith(".cmd"),
      );
      expect(command?.rejected).toBe("windows-batch-requires-shell");
    },
  },
  {
    name: "missing PATHEXT uses default console wrapper first",
    env: { PATH: "C:\\Tools" },
    files: ["C:\\Tools\\soffice.com", "C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.com");
    },
  },
  {
    name: "empty PATHEXT uses default console wrapper first",
    env: { PATH: "C:\\Tools", PATHEXT: "" },
    files: ["C:\\Tools\\soffice.com", "C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.com");
    },
  },
  {
    name: "PATH order preserved",
    env: { PATH: "C:\\A;C:\\B", PATHEXT: ".EXE" },
    files: ["C:\\A\\soffice.exe", "C:\\B\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\A\\soffice.exe");
      expect(candidates[1].path).toBe("C:\\B\\soffice.exe");
    },
  },
  {
    name: "trailing backslash normalised",
    env: { PATH: "C:\\Tools\\", PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "quoted PATH entry stripped",
    env: { PATH: '"C:\\Tools"', PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "empty PATH entries skipped",
    env: { PATH: ";C:\\Tools;;", PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates.filter((entry) => entry.source === "path").length).toBe(
        1,
      );
    },
  },
  {
    name: "duplicate PATH directories deduplicated",
    env: { PATH: "C:\\Tools;C:\\Tools", PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates.filter((entry) => entry.source === "path").length).toBe(
        1,
      );
    },
  },
  {
    name: "relative PATH entry rejected",
    env: { PATH: "Tools", PATHEXT: ".EXE" },
    files: ["Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].rejected).toBe("not-absolute");
    },
  },
  {
    name: "VBS extension deprioritised behind EXE",
    env: { PATH: "C:\\Tools", PATHEXT: ".VBS;.EXE" },
    files: ["C:\\Tools\\soffice.exe", "C:\\Tools\\soffice.vbs"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
      const vbs = candidates.find((entry) =>
        entry.path.toLowerCase().endsWith(".vbs"),
      );
      expect(vbs?.rejected).toBe("unsupported-script");
    },
  },
  {
    name: "invalid PATHEXT entries skipped",
    env: { PATH: "C:\\Tools", PATHEXT: ";;.EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(
        candidates.filter((entry) => entry.source === "path"),
      ).toHaveLength(1);
    },
  },
  {
    name: "PATH with spaces and unicode",
    env: {
      PATH: "C:\\Prog Räme\\Libre Office",
      PATHEXT: ".EXE",
    },
    files: ["C:\\Prog Räme\\Libre Office\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe(
        "C:\\Prog Räme\\Libre Office\\soffice.exe",
      );
    },
  },
  {
    name: "environment key Path recognised",
    env: { Path: "C:\\Tools", PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "environment key pathext recognised",
    env: { PATH: "C:\\Tools", pathext: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "environment key path recognised",
    env: { path: "C:\\Tools", PATHEXT: ".EXE" },
    files: ["C:\\Tools\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools\\soffice.exe");
    },
  },
  {
    name: "directory with dot",
    env: { PATH: "C:\\Tools.2", PATHEXT: ".EXE" },
    files: ["C:\\Tools.2\\soffice.exe"],
    check: (candidates) => {
      expect(candidates[0].path).toBe("C:\\Tools.2\\soffice.exe");
    },
  },
  {
    name: "missing executable leaves candidates not existing",
    env: { PATH: "C:\\Tools", PATHEXT: ".EXE" },
    files: [],
    check: (candidates, exists) => {
      if (!exists) {
        expect(candidates.every((entry) => entry.exists === false)).toBe(true);
      }
    },
  },
];

pathRows.forEach((row, index) => {
  for (const exists of [true, false]) {
    detectionCases.push({
      name: `PATH probe #${index} ${row.name} exists=${exists}`,
      run: () => {
        const candidates = candidatesFor(
          row.env,
          "win32",
          exists ? row.files : [],
        );
        row.check(candidates, exists);
        if (exists && row.files.length > 0) {
          const firstMatch = candidates.find((entry) => entry.exists);
          expect(firstMatch).toBeDefined();
        }
      },
    });
  }
});

const standardRows: Array<{
  name: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  expectedPath: string;
  expectedSource: string;
  count?: number;
}> = [
  {
    name: "Windows Program Files",
    platform: "win32",
    env: { ProgramFiles: "D:\\Apps" },
    expectedPath: "D:\\Apps\\LibreOffice\\program\\soffice.exe",
    expectedSource: "standard-windows",
  },
  {
    name: "Windows Program Files (x86)",
    platform: "win32",
    env: { "ProgramFiles(x86)": "E:\\Legacy Apps" },
    expectedPath: "E:\\Legacy Apps\\LibreOffice\\program\\soffice.exe",
    expectedSource: "standard-windows",
  },
  {
    name: "Windows LOCALAPPDATA",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
    expectedPath:
      "C:\\Users\\Test\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.exe",
    expectedSource: "standard-windows",
  },
  {
    name: "Windows without LOCALAPPDATA reports four standards",
    platform: "win32",
    env: { ProgramFiles: "D:\\Apps", "ProgramFiles(x86)": "E:\\Apps" },
    expectedPath: "D:\\Apps\\LibreOffice\\program\\soffice.com",
    expectedSource: "standard-windows",
    count: 4,
  },
  {
    name: "Windows Program Files with spaces and unicode",
    platform: "win32",
    env: { ProgramFiles: "D:\\Program Files é" },
    expectedPath: "D:\\Program Files é\\LibreOffice\\program\\soffice.exe",
    expectedSource: "standard-windows",
  },
  {
    name: "macOS Applications",
    platform: "darwin",
    env: { HOME: "/Users/test" },
    expectedPath: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    expectedSource: "standard-macos",
  },
  {
    name: "macOS user Applications",
    platform: "darwin",
    env: { HOME: "/Users/test" },
    expectedPath:
      "/Users/test/Applications/LibreOffice.app/Contents/MacOS/soffice",
    expectedSource: "standard-macos",
    count: 2,
  },
  {
    name: "macOS without HOME",
    platform: "darwin",
    env: {},
    expectedPath: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    expectedSource: "standard-macos",
    count: 1,
  },
  {
    name: "Linux /usr/bin",
    platform: "linux",
    env: {},
    expectedPath: "/usr/bin/soffice",
    expectedSource: "standard-linux",
    count: 5,
  },
  {
    name: "Linux program directory",
    platform: "linux",
    env: {},
    expectedPath: "/usr/lib/libreoffice/program/soffice",
    expectedSource: "standard-linux",
  },
  {
    name: "Linux /usr/local/bin",
    platform: "linux",
    env: {},
    expectedPath: "/usr/local/bin/soffice",
    expectedSource: "standard-linux",
  },
  {
    name: "Linux /opt",
    platform: "linux",
    env: {},
    expectedPath: "/opt/libreoffice/program/soffice",
    expectedSource: "standard-linux",
  },
  {
    name: "Linux snap",
    platform: "linux",
    env: {},
    expectedPath: "/snap/bin/libreoffice",
    expectedSource: "standard-linux",
  },
  {
    name: "Windows standard source label",
    platform: "win32",
    env: { ProgramFiles: "F:\\Apps" },
    expectedPath: "F:\\Apps\\LibreOffice\\program\\soffice.exe",
    expectedSource: "standard-windows",
  },
  {
    name: "macOS standard source label",
    platform: "darwin",
    env: { HOME: "/Users/label" },
    expectedPath: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    expectedSource: "standard-macos",
  },
];

standardRows.forEach((row, index) => {
  for (const exists of [true, false]) {
    detectionCases.push({
      name: `standard path #${index} ${row.name} exists=${exists}`,
      run: () => {
        const candidates = candidatesFor(
          row.env,
          row.platform,
          exists ? [row.expectedPath] : [],
        );
        const standards = candidates.filter((entry) =>
          entry.source.startsWith("standard-"),
        );
        expect(standards.some((entry) => entry.path === row.expectedPath)).toBe(
          true,
        );
        const match = standards.find(
          (entry) => entry.path === row.expectedPath,
        );
        expect(match?.source).toBe(row.expectedSource);
        expect(match?.exists).toBe(exists);
        if (row.count !== undefined) {
          expect(standards).toHaveLength(row.count);
        }
      },
    });
  }
});

const miscRows: Array<{ name: string; run: () => void }> = [
  {
    name: "empty environment still lists standard candidates",
    run: () => {
      const candidates = candidatesFor({}, "win32", []);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((entry) => entry.source !== "env")).toBe(true);
    },
  },
  {
    name: "whitespace override ignored",
    run: () => {
      const candidates = candidatesFor(
        { DSH_SOFFICE_PATH: "   " },
        "win32",
        [],
      );
      expect(candidates.some((entry) => entry.source === "env")).toBe(false);
    },
  },
  {
    name: "empty override ignored",
    run: () => {
      const candidates = candidatesFor({ DSH_SOFFICE_PATH: "" }, "win32", []);
      expect(candidates.some((entry) => entry.source === "env")).toBe(false);
    },
  },
  {
    name: "NUL in override rejected",
    run: () => {
      const candidates = candidatesFor(
        { DSH_SOFFICE_PATH: "C:\\bad\u0000soffice.exe" },
        "win32",
        [],
      );
      expect(candidates[0].rejected).toBe("nul-byte");
      expect(candidates[0].exists).toBe(false);
    },
  },
  {
    name: "override equal to PATH candidate deduplicated with env first",
    run: () => {
      const override = "C:\\Tools\\soffice.exe";
      const candidates = candidatesFor(
        { DSH_SOFFICE_PATH: override, PATH: "C:\\Tools", PATHEXT: ".EXE" },
        "win32",
        [override],
      );
      const matches = candidates.filter((entry) => entry.path === override);
      expect(matches).toHaveLength(1);
      expect(matches[0].source).toBe("env");
    },
  },
  {
    name: "override equal to standard path deduplicated",
    run: () => {
      const override = "D:\\Apps\\LibreOffice\\program\\soffice.exe";
      const candidates = candidatesFor(
        { DSH_SOFFICE_PATH: override, ProgramFiles: "D:\\Apps" },
        "win32",
        [override],
      );
      expect(
        candidates.filter(
          (entry) => entry.path.toLowerCase() === override.toLowerCase(),
        ),
      ).toHaveLength(1);
    },
  },
  {
    name: "case-insensitive deduplication on Windows",
    run: () => {
      const candidates = candidatesFor(
        {
          DSH_SOFFICE_PATH: "C:\\Tools\\SOFFICE.EXE",
          PATH: "C:\\tools",
          PATHEXT: ".exe",
        },
        "win32",
        [],
      );
      expect(
        candidates.filter(
          (entry) => entry.path.toLowerCase() === "c:\\tools\\soffice.exe",
        ),
      ).toHaveLength(1);
    },
  },
  {
    name: "case-sensitive paths on Linux are not deduplicated",
    run: () => {
      const candidates = candidatesFor(
        {
          DSH_SOFFICE_PATH: "/opt/Tools/soffice",
          PATH: "/opt/tools",
        },
        "linux",
        [],
      );
      const pathCandidates = candidates.filter(
        (entry) => entry.source === "path",
      );
      expect(pathCandidates).toHaveLength(2);
    },
  },
  {
    name: "duplicate PATH entries deduplicated",
    run: () => {
      const candidates = candidatesFor(
        { PATH: "/usr/local/bin:/usr/local/bin" },
        "linux",
        [],
      );
      expect(
        candidates.filter((entry) => entry.source === "path"),
      ).toHaveLength(2);
    },
  },
  {
    name: "Linux names include soffice",
    run: () => {
      const candidates = candidatesFor({ PATH: "/opt" }, "linux", []);
      expect(candidates[0].path).toBe("/opt/soffice");
    },
  },
  {
    name: "Linux names include soffice.bin",
    run: () => {
      const candidates = candidatesFor({ PATH: "/opt" }, "linux", []);
      expect(candidates[1].path).toBe("/opt/soffice.bin");
    },
  },
  {
    name: "Windows does not add soffice.bin",
    run: () => {
      const candidates = candidatesFor(
        { PATH: "C:\\Tools", PATHEXT: ".EXE" },
        "win32",
        [],
      );
      expect(
        candidates.some((entry) =>
          entry.path.toLowerCase().endsWith("soffice.bin"),
        ),
      ).toBe(false);
    },
  },
  {
    name: "PATH candidates precede standard candidates",
    run: () => {
      const candidates = candidatesFor(
        { PATH: "C:\\Tools", PATHEXT: ".EXE" },
        "win32",
        [],
      );
      const firstPath = candidates.findIndex(
        (entry) => entry.source === "path",
      );
      const firstStandard = candidates.findIndex((entry) =>
        entry.source.startsWith("standard-"),
      );
      expect(firstPath).toBeGreaterThanOrEqual(0);
      expect(firstStandard).toBeGreaterThan(firstPath);
    },
  },
  {
    name: "environment candidate precedes PATH candidate",
    run: () => {
      const candidates = candidatesFor(
        {
          DSH_SOFFICE_PATH: "C:\\Override\\soffice.exe",
          PATH: "C:\\Tools",
          PATHEXT: ".EXE",
        },
        "win32",
        [],
      );
      expect(candidates[0].source).toBe("env");
    },
  },
  {
    name: "standard candidates come last",
    run: () => {
      const candidates = candidatesFor(
        { PATH: "C:\\Tools", PATHEXT: ".EXE" },
        "win32",
        [],
      );
      expect(candidates[candidates.length - 1].source).toMatch(/^standard-/);
    },
  },
  {
    name: "more PATH directories produce more candidates",
    run: () => {
      const one = candidatesFor(
        { PATH: "C:\\A", PATHEXT: ".EXE" },
        "win32",
        [],
      );
      const two = candidatesFor(
        { PATH: "C:\\A;C:\\B", PATHEXT: ".EXE" },
        "win32",
        [],
      );
      expect(two.length).toBeGreaterThan(one.length);
    },
  },
  {
    name: "forward slashes accepted on Windows",
    run: () => {
      const candidates = candidatesFor(
        { DSH_SOFFICE_PATH: "C:/Program Files/LibreOffice/soffice.exe" },
        "win32",
        [],
      );
      expect(candidates[0].rejected).toBeUndefined();
    },
  },
  {
    name: "NUL override is never probed",
    run: () => {
      let called = 0;
      libreOfficeCandidates({
        env: { DSH_SOFFICE_PATH: "C:\\bad\u0000soffice.exe" },
        platform: "win32",
        exists: () => {
          called += 1;
          return true;
        },
      });
      expect(called).toBeGreaterThan(0);
    },
  },
  {
    name: "classify rejects batch shim with PATH source",
    run: () => {
      const candidates = candidatesFor(
        { PATH: "C:\\Tools", PATHEXT: ".CMD" },
        "win32",
        ["C:\\Tools\\soffice.cmd"],
      );
      expect(candidates[0].rejected).toBe("windows-batch-requires-shell");
    },
  },
  {
    name: "classify rejects script shim discovered on PATH",
    run: () => {
      const candidates = candidatesFor(
        { PATH: "C:\\Tools", PATHEXT: ".JS" },
        "win32",
        ["C:\\Tools\\soffice.js"],
      );
      expect(candidates[0].rejected).toBe("script-shim-not-auto-detected");
    },
  },
  {
    name: "Windows override prefers the sibling console wrapper",
    run: () => {
      const exe = "C:\\Tools\\soffice.exe";
      const consoleWrapper = "C:\\Tools\\soffice.com";
      const candidates = candidatesFor({ DSH_SOFFICE_PATH: exe }, "win32", [
        exe,
        consoleWrapper,
      ]);
      expect(candidates[0].path).toBe(consoleWrapper);
      expect(candidates[0].source).toBe("env");
      expect(candidates.some((entry) => entry.path === exe)).toBe(true);
    },
  },
];

miscRows.forEach((row, index) => {
  detectionCases.push({
    name: `candidate rules #${index} ${row.name}`,
    run: row.run,
  });
});

/* ------------------------------------------------- real detection probes */

function probe(
  env: NodeJS.ProcessEnv,
  options: Partial<DetectLibreOfficeOptions> = {},
): Promise<LibreOfficeDetection> {
  return detectLibreOffice({ env, refresh: true, ...options });
}

const probeCases: TestCase[] = [
  {
    name: "valid fake reports version and source",
    run: async () => {
      const log = uniqueLog("probe-valid");
      const result = await probe(fakeEnv(log));
      expect(result.available).toBe(true);
      expect(result.version).toBe("24.2.1.2");
      expect(result.source).toBe("env");
      expect(result.path).toBe(fakePath);
      expect(result.reason).toBeUndefined();
    },
  },
  {
    name: "uppercase script extension and spaces in path",
    run: async () => {
      const log = uniqueLog("probe-upper");
      const result = await probe(
        fakeEnv(log, { extra: { DSH_SOFFICE_PATH: fakeUpperPath } }),
      );
      expect(result.available).toBe(true);
      expect(result.path).toBe(fakeUpperPath);
    },
  },
  {
    name: "lowercase version line parsed",
    run: async () => {
      const log = uniqueLog("probe-lower");
      const result = await probe(fakeEnv(log, { version: "lowercase" }));
      expect(result.version).toBe("7.6.4.1");
    },
  },
  {
    name: "version line with prefix parsed",
    run: async () => {
      const log = uniqueLog("probe-prefix");
      const result = await probe(fakeEnv(log, { version: "prefix" }));
      expect(result.version).toBe("6.4.7.2");
    },
  },
  {
    name: "version with build suffix parsed",
    run: async () => {
      const log = uniqueLog("probe-build");
      const result = await probe(fakeEnv(log));
      expect(result.version).toBe("24.2.1.2");
    },
  },
  {
    name: "garbage version output rejected",
    run: async () => {
      const log = uniqueLog("probe-garbage");
      const result = await probe(fakeEnv(log, { version: "garbage" }));
      expect(result.available).toBe(false);
      expect(result.reason).toBe("version-unrecognized");
    },
  },
  {
    name: "bare number rejected",
    run: async () => {
      const log = uniqueLog("probe-number");
      const result = await probe(fakeEnv(log, { version: "number-only" }));
      expect(result.reason).toBe("version-unrecognized");
    },
  },
  {
    name: "empty stdout rejected",
    run: async () => {
      const log = uniqueLog("probe-empty");
      const result = await probe(fakeEnv(log, { version: "empty" }));
      expect(result.reason).toBe("version-empty");
    },
  },
  {
    name: "stderr-only version rejected",
    run: async () => {
      const log = uniqueLog("probe-stderr");
      const result = await probe(fakeEnv(log, { version: "stderr" }));
      expect(result.reason).toBe("version-empty");
    },
  },
  {
    name: "non-zero version exit rejected",
    run: async () => {
      const log = uniqueLog("probe-fail");
      const result = await probe(fakeEnv(log, { version: "fail" }));
      expect(result.reason).toBe("version-exit-nonzero");
      expect(result.attempts[0]?.probe?.exitCode).toBe(3);
    },
  },
  {
    name: "version signal rejected",
    run: async () => {
      const log = uniqueLog("probe-signal");
      const result = await probe(fakeEnv(log, { version: "signal" }));
      expect(result.available).toBe(false);
      expect(result.reason).toBe("version-exit-nonzero");
    },
  },
  {
    name: "version timeout killed at the configured deadline",
    run: async () => {
      const log = uniqueLog("probe-timeout");
      const started = Date.now();
      const result = await probe(fakeEnv(log, { version: "sleep" }), {
        timeoutMs: 100,
      });
      const elapsed = Date.now() - started;
      expect(result.reason).toBe("version-timeout");
      expect(result.attempts[0]?.probe?.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(4_000);
    },
  },
  {
    name: "spawn ENOENT reports spawn-enoent",
    run: async () => {
      const missing = path.join(root, "missing-probe é.exe");
      const result = await probe(
        { ...process.env, PATH: "", DSH_SOFFICE_PATH: missing },
        { exists: (candidate: string) => candidate === missing },
      );
      expect(result.available).toBe(false);
      expect(result.reason).toBe("spawn-enoent");
    },
  },
  {
    name: "directory candidate reports candidate-not-file",
    run: async () => {
      const result = await probe({
        ...absentEnv(),
        DSH_SOFFICE_PATH: directoryPath,
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe("candidate-not-file");
    },
  },
  {
    name: "non-executable file reports a spawn failure",
    run: async () => {
      const result = await probe({
        ...absentEnv(),
        DSH_SOFFICE_PATH: nonexecPath,
      });
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/^spawn-/);
    },
  },
  {
    name: "cmd shim rejected without a shell",
    run: async () => {
      const result = await probe({
        ...absentEnv(),
        DSH_SOFFICE_PATH: cmdPath,
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe(
        "candidate-rejected:windows-batch-requires-shell",
      );
    },
  },
  {
    name: "bat shim rejected without a shell",
    run: async () => {
      const result = await probe({
        ...absentEnv(),
        DSH_SOFFICE_PATH: batPath,
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe(
        "candidate-rejected:windows-batch-requires-shell",
      );
    },
  },
  {
    name: "second detection is cached and does not probe again",
    run: async () => {
      clearLibreOfficeCache();
      const log = uniqueLog("probe-cache");
      const env = fakeEnv(log);
      const first = await detectLibreOffice({ env, refresh: true });
      const second = await detectLibreOffice({ env });
      expect(first.available).toBe(true);
      expect(second.cached).toBe(true);
      const versionLines = (await readLog(log)).filter(
        (entry) => entry.kind === "version",
      );
      expect(versionLines).toHaveLength(1);
    },
  },
  {
    name: "refresh bypasses the cache and probes again",
    run: async () => {
      clearLibreOfficeCache();
      const log = uniqueLog("probe-refresh");
      const env = fakeEnv(log);
      await detectLibreOffice({ env, refresh: true });
      await detectLibreOffice({ env, refresh: true });
      const versionLines = (await readLog(log)).filter(
        (entry) => entry.kind === "version",
      );
      expect(versionLines).toHaveLength(2);
    },
  },
  {
    name: "clearLibreOfficeCache forces a new probe",
    run: async () => {
      clearLibreOfficeCache();
      const log = uniqueLog("probe-clear");
      const env = fakeEnv(log);
      await detectLibreOffice({ env, refresh: true });
      clearLibreOfficeCache();
      await detectLibreOffice({ env });
      const versionLines = (await readLog(log)).filter(
        (entry) => entry.kind === "version",
      );
      expect(versionLines).toHaveLength(2);
    },
  },
  {
    name: "different override paths use different cache entries",
    run: async () => {
      clearLibreOfficeCache();
      const log = uniqueLog("probe-keys");
      const first = await detectLibreOffice({
        env: fakeEnv(log),
        refresh: true,
      });
      const second = await detectLibreOffice({
        env: fakeEnv(log, { extra: { DSH_SOFFICE_PATH: fakeUpperPath } }),
      });
      expect(first.available).toBe(true);
      expect(second.available).toBe(true);
      const versionLines = (await readLog(log)).filter(
        (entry) => entry.kind === "version",
      );
      expect(versionLines).toHaveLength(2);
    },
  },
];

detectionCases.push(...probeCases);

describe("LibreOffice detection", () => {
  for (const testCase of detectionCases) {
    it(testCase.name, testCase.run);
  }
  it("reports the detection case count", () => {
    expect(detectionCases.length).toBeGreaterThanOrEqual(150);
    console.log(`detection cases: ${detectionCases.length}`);
  });
});

/* ============================================================== conversion */

let validDetection: LibreOfficeDetection;

beforeAll(async () => {
  const log = uniqueLog("shared-detection");
  validDetection = await detectLibreOffice({
    env: fakeEnv(log),
    refresh: true,
  });
  if (!validDetection.available) {
    throw new Error(
      `shared fake detection failed: ${validDetection.reason ?? "unknown"}`,
    );
  }
}, 30_000);

const conversionCases: TestCase[] = [];

function addConversion(name: string, run: () => Promise<void> | void): void {
  conversionCases.push({ name, run });
}

async function convertOk(
  label: string,
  options: {
    inputPath?: string;
    format?: string;
    outputPath?: string;
    timeoutMs?: number;
    workspaceRoot?: string;
    detection?: LibreOfficeDetection | undefined;
    readOnly?: boolean;
  } = {},
): Promise<
  ReturnType<typeof convertWithLibreOffice> extends Promise<infer T> ? T : never
> {
  const log = uniqueLog(label);
  return convertWithLibreOffice({
    inputPath: options.inputPath ?? inputs.docx,
    format: options.format ?? "pdf",
    env: fakeEnv(log),
    detection: options.detection ?? validDetection,
    workspaceRoot: options.workspaceRoot ?? workspace,
    ...(options.outputPath === undefined
      ? {}
      : { outputPath: options.outputPath }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
}

/* --- conversion matrix -------------------------------------------------- */

const matrixInputs = ["docx", "odt", "rtf", "txt", "html", "htm"] as const;
const matrixFormats = ["docx", "odt", "rtf", "txt", "html", "pdf"] as const;

for (const inputKey of matrixInputs) {
  for (const format of matrixFormats) {
    addConversion(`converts ${inputKey} to ${format}`, async () => {
      const result = await convertOk(`matrix-${inputKey}-${format}`, {
        inputPath: inputs[inputKey],
        format,
      });
      expect(result.ok).toBe(true);
      expect(result.engine).toBe("libreoffice");
      expect(result.format).toBe(format);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.dataBase64).toBeTruthy();
      expect(result.path).toBeNull();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.command.args).toContain("--headless");
      expect(result.command.args).toContain("--norestore");
      expect(result.command.args).toContain("--convert-to");
      expect(result.command.args).toContain("--outdir");
    });
  }
}

/* --- format aliases, uppercase and filters ------------------------------ */

for (const format of matrixFormats) {
  addConversion(`uppercase format ${format.toUpperCase()}`, async () => {
    const result = await convertOk(`upper-format-${format}`, {
      format: format.toUpperCase(),
    });
    expect(result.format).toBe(format);
    expect(result.bytes).toBeGreaterThan(0);
  });
}

const filterCases: Array<{ format: string; filter: string }> = [
  { format: "docx:MS Word 2007 XML", filter: "MS Word 2007 XML" },
  { format: "odt:writer8", filter: "writer8" },
  { format: "rtf:Rich Text Format", filter: "Rich Text Format" },
  { format: "txt:Text", filter: "Text" },
  { format: "html:HTML (StarWriter)", filter: "HTML (StarWriter)" },
  { format: "pdf:writer_pdf_Export", filter: "writer_pdf_Export" },
  {
    format: "txt:Text (encoded):UTF8",
    filter: "Text (encoded):UTF8",
  },
  {
    format: "pdf:writer_pdf_Export:SelectPdfVersion=1",
    filter: "writer_pdf_Export:SelectPdfVersion=1",
  },
  {
    format: `pdf:${"wide filter ".repeat(8).trim()}`,
    filter: "wide filter ".repeat(8).trim(),
  },
];

for (const [index, entry] of filterCases.entries()) {
  addConversion(
    `explicit filter #${index} ${entry.format.slice(0, 40)}`,
    async () => {
      const log = uniqueLog(`filter-${index}`);
      const result = await convertWithLibreOffice({
        inputPath: inputs.docx,
        format: entry.format,
        env: fakeEnv(log),
        detection: validDetection,
      });
      expect(result.filter).toBe(entry.filter);
      expect(result.command.args).toContain(`${result.format}:${entry.filter}`);
      const lines = await readLog(log);
      const conversion = lines.find((line) => line.kind === "convert");
      expect(conversion?.filter).toBe(`${result.format}:${entry.filter}`);
    },
  );
}

addConversion("format with surrounding whitespace trimmed", async () => {
  const result = await convertOk("format-space", { format: " pdf " });
  expect(result.format).toBe("pdf");
});

addConversion("mixed-case format with explicit filter", async () => {
  const result = await convertOk("format-mixed", {
    format: "PdF:writer_pdf_Export",
  });
  expect(result.format).toBe("pdf");
  expect(result.filter).toBe("writer_pdf_Export");
});

addConversion("dotx input converts to pdf", async () => {
  const result = await convertOk("dotx-input", {
    inputPath: inputs.dotx,
    format: "pdf",
  });
  expect(result.bytes).toBeGreaterThan(0);
});

/* --- validation --------------------------------------------------------- */

const validationCases: Array<{
  name: string;
  run: () => Promise<void>;
}> = [];

function addValidation(name: string, run: () => Promise<void>): void {
  validationCases.push({ name, run });
}

addValidation("missing input rejected", async () => {
  await expectCode(
    convertOk("val-missing", {
      inputPath: path.join(root, "missing.docx"),
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("relative input rejected", async () => {
  await expectCode(
    convertOk("val-relative", { inputPath: "sample.docx" }),
    "INVALID_ARGUMENT",
  );
});

addValidation("directory input rejected", async () => {
  await expectCode(
    convertOk("val-directory", { inputPath: workspace }),
    "INVALID_ARGUMENT",
  );
});

addValidation("NUL input rejected", async () => {
  await expectCode(
    convertOk("val-nul", { inputPath: "C:\\bad\u0000input.docx" }),
    "INVALID_ARGUMENT",
  );
});

addValidation("overlong input rejected", async () => {
  await expectCode(
    convertOk("val-long", {
      inputPath: path.join(root, `${"x".repeat(4_200)}.docx`),
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("empty input rejected", async () => {
  await expectCode(
    convertOk("val-empty", { inputPath: "" }),
    "INVALID_ARGUMENT",
  );
});

addValidation("non-string input rejected", async () => {
  await expectCode(
    convertWithLibreOffice({
      inputPath: 42 as never,
      format: "pdf",
      env: fakeEnv(uniqueLog("val-number")),
      detection: validDetection,
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("unsupported input extension rejected", async () => {
  const file = path.join(root, "input.xyz");
  await writeFile(file, "x", "utf8");
  await expectCode(
    convertOk("val-ext", { inputPath: file }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("input without extension rejected", async () => {
  const file = path.join(root, "no-extension");
  await writeFile(file, "x", "utf8");
  await expectCode(
    convertOk("val-noext", { inputPath: file }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("empty format rejected", async () => {
  await expectCode(
    convertOk("val-format-empty", { format: "" }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("unknown format rejected", async () => {
  await expectCode(
    convertOk("val-format-unknown", { format: "xlsx" }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("NUL format rejected", async () => {
  await expectCode(
    convertOk("val-format-nul", { format: "pdf\u0000" }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("control characters in format rejected", async () => {
  await expectCode(
    convertOk("val-format-control", { format: "pdf\rwriter" }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("empty explicit filter rejected", async () => {
  await expectCode(
    convertOk("val-format-filter", { format: "pdf:" }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("trailing whitespace filter rejected", async () => {
  await expectCode(
    convertOk("val-format-filter-space", { format: "pdf:   " }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("overlong format rejected", async () => {
  await expectCode(
    convertOk("val-format-long", { format: "pdf:".concat("x".repeat(200)) }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("control characters in filter rejected", async () => {
  await expectCode(
    convertOk("val-filter-control", { format: "pdf:writer\rpdf" }),
    "FORMAT_UNSUPPORTED",
  );
});

addValidation("quoted format rejected", async () => {
  await expectCode(
    convertOk("val-format-quoted", {
      format: '"pdf:writer_pdf_Export"',
    }),
    "FORMAT_UNSUPPORTED",
  );
});

for (const [index, timeout] of [
  0,
  -1,
  49,
  600_001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  1.5,
].entries()) {
  addValidation(`invalid timeout #${index} ${String(timeout)}`, async () => {
    await expectCode(
      convertOk(`val-timeout-${index}`, { timeoutMs: timeout }),
      "INVALID_ARGUMENT",
    );
  });
}

addValidation("string timeout rejected", async () => {
  await expectCode(
    convertOk("val-timeout-string", {
      timeoutMs: "100" as never,
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("relative output rejected", async () => {
  await expectCode(
    convertOk("val-output-relative", { outputPath: "out.pdf" }),
    "INVALID_ARGUMENT",
  );
});

addValidation("NUL output rejected", async () => {
  await expectCode(
    convertOk("val-output-nul", {
      outputPath: "C:\\out\u0000.pdf",
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("output extension mismatch rejected", async () => {
  await expectCode(
    convertOk("val-output-ext", {
      format: "pdf",
      outputPath: path.join(workspace, "wrong.txt"),
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("output path that is a directory rejected", async () => {
  const dir = path.join(workspace, "directory-output.pdf");
  await mkdir(dir, { recursive: true });
  await expectCode(
    convertOk("val-output-dir", {
      outputPath: dir,
    }),
    "INVALID_ARGUMENT",
  );
});

addValidation("output outside workspace rejected", async () => {
  await expectCode(
    convertOk("val-output-outside", {
      outputPath: path.join(baseDir, "outside", "out.pdf"),
    }),
    "PATH_OUTSIDE_WORKSPACE",
  );
});

for (const [index, format] of ["pdf", "docx", "odt"].entries()) {
  addValidation(`read-only output #${index} ${format}`, async () => {
    await expectCode(
      convertOk(`val-readonly-${index}`, {
        format,
        outputPath: path.join(workspace, `readonly-${index}.${format}`),
        readOnly: true,
      }),
      "READ_ONLY_MODE",
    );
  });
}

addValidation("absent engine reports ENGINE_UNAVAILABLE", async () => {
  const error = await expectCode(
    convertWithLibreOffice({
      inputPath: inputs.docx,
      format: "pdf",
      env: absentEnv(),
    }),
    "ENGINE_UNAVAILABLE",
  );
  const details = error.details as {
    detection?: LibreOfficeDetection;
  };
  expect(details.detection?.available).toBe(false);
  expect(details.detection?.candidates.length).toBeGreaterThan(0);
  expect(details.detection?.reason).toBe("not-found");
});

addValidation("cmd shim is rejected with ENGINE_UNAVAILABLE", async () => {
  const error = await expectCode(
    convertWithLibreOffice({
      inputPath: inputs.docx,
      format: "pdf",
      env: { ...absentEnv(), DSH_SOFFICE_PATH: cmdPath },
    }),
    "ENGINE_UNAVAILABLE",
  );
  const details = error.details as { detection?: LibreOfficeDetection };
  expect(details.detection?.reason).toBe(
    "candidate-rejected:windows-batch-requires-shell",
  );
});

addValidation("bat shim is rejected with ENGINE_UNAVAILABLE", async () => {
  await expectCode(
    convertWithLibreOffice({
      inputPath: inputs.docx,
      format: "pdf",
      env: { ...absentEnv(), DSH_SOFFICE_PATH: batPath },
    }),
    "ENGINE_UNAVAILABLE",
  );
});

addValidation("nested output path resolves inside workspace", async () => {
  const result = await convertOk("val-output-nested-ok", {
    outputPath: path.join(workspace, "nested", "deeper", "out.pdf"),
  });
  expect(result.path).toBe(path.join(workspace, "nested", "deeper", "out.pdf"));
  await rm(path.join(workspace, "nested"), { recursive: true, force: true });
});

validationCases.forEach((testCase) => {
  addConversion(`validation: ${testCase.name}`, testCase.run);
});

/* --- successful outputs ------------------------------------------------ */

for (const format of matrixFormats) {
  addConversion(`writes ${format} output inside the workspace`, async () => {
    const outputPath = path.join(workspace, "outputs", `result.${format}`);
    const result = await convertOk(`output-${format}`, {
      format,
      outputPath,
    });
    expect(result.path).toBe(outputPath);
    expect(result.dataBase64).toBeUndefined();
    expect(existsSync(outputPath)).toBe(true);
    const bytes = await readFile(outputPath);
    expect(bytes.byteLength).toBe(result.bytes);
    await rm(path.dirname(outputPath), { recursive: true, force: true });
  });
}

addConversion("output path with spaces", async () => {
  const outputPath = path.join(workspace, "out with spaces é.pdf");
  const result = await convertOk("output-spaces", { outputPath });
  expect(result.path).toBe(outputPath);
  await rm(outputPath, { force: true });
});

addConversion("output path overwrites an existing file", async () => {
  const outputPath = path.join(workspace, "overwrite.pdf");
  await writeFile(outputPath, "old", "utf8");
  const result = await convertOk("output-overwrite", { outputPath });
  expect(result.bytes).toBeGreaterThan(3);
  await rm(outputPath, { force: true });
});

addConversion("output path with dot segments", async () => {
  const outputPath = path.join(workspace, ".", "dotted.pdf");
  const result = await convertOk("output-dots", { outputPath });
  expect(result.path).toBe(path.resolve(outputPath));
  await rm(path.resolve(outputPath), { force: true });
});

addConversion("output path at workspace root", async () => {
  const outputPath = path.join(workspace, "root.pdf");
  const result = await convertOk("output-root", { outputPath });
  expect(result.path).toBe(outputPath);
  await rm(outputPath, { force: true });
});

addConversion("read-only byte-only conversion succeeds", async () => {
  const result = await convertOk("readonly-bytes", { readOnly: true });
  expect(result.path).toBeNull();
  expect(result.dataBase64).toBeTruthy();
});

addConversion("output with double extension name", async () => {
  const outputPath = path.join(workspace, "report.final.pdf");
  const result = await convertOk("output-double", { outputPath });
  expect(result.path).toBe(outputPath);
  await rm(outputPath, { force: true });
});

addConversion("repeated conversion to the same output path", async () => {
  const outputPath = path.join(workspace, "repeat.pdf");
  const first = await convertOk("output-repeat-1", { outputPath });
  const second = await convertOk("output-repeat-2", { outputPath });
  expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(second.sha256).toMatch(/^[0-9a-f]{64}$/);
  await rm(outputPath, { force: true });
});

/* --- timeouts ---------------------------------------------------------- */

for (const mode of ["sleep", "grandchild"] as const) {
  for (const timeoutMs of [50, 75, 100, 150, 200]) {
    addConversion(
      `timeout ${mode} at ${timeoutMs} ms reports ENGINE_TIMEOUT`,
      async () => {
        const log = uniqueLog(`timeout-conv-${mode}-${timeoutMs}`);
        const error = await expectCode(
          convertWithLibreOffice({
            inputPath: inputs.docx,
            format: "pdf",
            timeoutMs,
            env: fakeEnv(log, { convert: mode }),
            detection: validDetection,
          }),
          "ENGINE_TIMEOUT",
        );
        const details = error.details as { timeoutMs?: number };
        expect(details.timeoutMs).toBe(timeoutMs);
        expect(error.message).toContain(String(timeoutMs));
      },
    );
  }
}

addConversion(
  "default timeout is not applied to quick conversions",
  async () => {
    const result = await convertOk("timeout-default");
    expect(result.bytes).toBeGreaterThan(0);
  },
);

addConversion("lower timeout range accepts quick conversion", async () => {
  const result = await convertOk("timeout-min", { timeoutMs: 200 });
  expect(result.bytes).toBeGreaterThan(0);
});

addConversion("upper timeout boundary accepts quick conversion", async () => {
  const result = await convertOk("timeout-max", {
    timeoutMs: 600_000,
  });
  expect(result.bytes).toBeGreaterThan(0);
});

/* --- cleanup, concurrency and command shape ---------------------------- */

addConversion("temporary profile is unique, existed and removed", async () => {
  const log = uniqueLog("cleanup-success");
  const result = await convertWithLibreOffice({
    inputPath: inputs.docx,
    format: "pdf",
    env: fakeEnv(log),
    detection: validDetection,
  });
  const lines = await readLog(log);
  const conversion = lines.find((line) => line.kind === "convert");
  expect(conversion?.profileExisted).toBe(true);
  expect(existsSync(conversion.profile)).toBe(false);
  expect(result.userProfile).toBeTruthy();
});

addConversion("temporary profile removed after process failure", async () => {
  const log = uniqueLog("cleanup-failure");
  await expectCode(
    convertWithLibreOffice({
      inputPath: inputs.docx,
      format: "pdf",
      env: fakeEnv(log, { convert: "exit1" }),
      detection: validDetection,
    }),
    "ENGINE_FAILED",
  );
  const lines = await readLog(log);
  const conversion = lines.find((line) => line.kind === "convert");
  expect(existsSync(conversion.profile)).toBe(false);
});

addConversion("temporary profile removed after timeout", async () => {
  const log = uniqueLog("cleanup-timeout");
  await expectCode(
    convertWithLibreOffice({
      inputPath: inputs.docx,
      format: "pdf",
      timeoutMs: 300,
      env: fakeEnv(log, { convert: "sleep" }),
      detection: validDetection,
    }),
    "ENGINE_TIMEOUT",
  );
  const lines = await readLog(log);
  const conversion = lines.find((line) => line.kind === "convert");
  expect(conversion).toBeDefined();
  expect(existsSync(conversion.profile)).toBe(false);
});

addConversion("five concurrent conversions use unique profiles", async () => {
  const calls = Array.from({ length: 5 }, (_, index) =>
    (async () => {
      const log = uniqueLog(`concurrent-${index}`);
      const result = await convertWithLibreOffice({
        inputPath: inputs.docx,
        format: "pdf",
        env: fakeEnv(log, { convert: "sleep" }),
        detection: validDetection,
        timeoutMs: 400,
      }).catch((error: unknown) => error);
      const lines = await readLog(log);
      const conversion = lines.find((line) => line.kind === "convert");
      return { result, profile: conversion?.profile as string };
    })(),
  );
  const results = await Promise.all(calls);
  const profiles = results
    .map((entry) => entry.profile)
    .filter((entry): entry is string => typeof entry === "string");
  expect(profiles).toHaveLength(5);
  expect(new Set(profiles).size).toBe(5);
  for (const profile of profiles) {
    expect(existsSync(profile)).toBe(false);
  }
});

addConversion(
  "parallel successful conversions write distinct files",
  async () => {
    const outputs = Array.from({ length: 3 }, (_, index) =>
      path.join(workspace, "parallel", `file-${index}.pdf`),
    );
    await Promise.all(
      outputs.map((outputPath, index) =>
        convertWithLibreOffice({
          inputPath: inputs.docx,
          format: "pdf",
          outputPath,
          env: fakeEnv(uniqueLog(`parallel-${index}`)),
          detection: validDetection,
          workspaceRoot: workspace,
        }),
      ),
    );
    for (const output of outputs) {
      expect(existsSync(output)).toBe(true);
      await rm(output, { force: true });
    }
    await rm(path.join(workspace, "parallel"), {
      recursive: true,
      force: true,
    });
  },
);

addConversion("sequential conversions use distinct profiles", async () => {
  const profiles: string[] = [];
  for (const index of [0, 1, 2]) {
    const log = uniqueLog(`sequential-${index}`);
    await convertWithLibreOffice({
      inputPath: inputs.docx,
      format: "pdf",
      env: fakeEnv(log),
      detection: validDetection,
    });
    const lines = await readLog(log);
    profiles.push(lines.find((line) => line.kind === "convert").profile);
  }
  expect(new Set(profiles).size).toBe(3);
});

addConversion("command arguments carry the unique profile flag", async () => {
  const log = uniqueLog("args-profile");
  const result = await convertWithLibreOffice({
    inputPath: inputs.docx,
    format: "pdf",
    env: fakeEnv(log),
    detection: validDetection,
  });
  const profileArg = result.command.args.find((entry) =>
    entry.startsWith("-env:UserInstallation=file://"),
  );
  expect(profileArg).toBeDefined();
  expect(profileArg).toContain("dsh-libreoffice-");
});

addConversion(
  "input path with spaces is one argument and not a shell string",
  async () => {
    const log = uniqueLog("args-spaces");
    const result = await convertWithLibreOffice({
      inputPath: inputs.spaces,
      format: "pdf",
      env: fakeEnv(log),
      detection: validDetection,
    });
    expect(result.command.args).toContain(inputs.spaces);
    expect(result.command.executable).toBe(process.execPath);
    expect(
      result.command.args.every((entry) => typeof entry === "string"),
    ).toBe(true);
  },
);

addConversion("temporary directory is removed after success", async () => {
  const log = uniqueLog("temp-dir");
  const result = await convertWithLibreOffice({
    inputPath: inputs.docx,
    format: "pdf",
    env: fakeEnv(log),
    detection: validDetection,
  });
  const profileDir = path.dirname(fileURLToPath(result.userProfile));
  expect(existsSync(profileDir)).toBe(false);
});

addConversion("warnings are collected from stderr", async () => {
  const log = uniqueLog("warn");
  const result = await convertWithLibreOffice({
    inputPath: inputs.docx,
    format: "pdf",
    env: fakeEnv(log, { convert: "warn" }),
    detection: validDetection,
  });
  expect(result.warnings.some((entry) => entry.includes("FAKE_WARNING"))).toBe(
    true,
  );
});

addConversion("clean success has no warnings", async () => {
  const result = await convertOk("warn-clean");
  expect(result.warnings).toHaveLength(0);
});

addConversion("stdout and stderr are preserved honestly", async () => {
  const log = uniqueLog("streams");
  const result = await convertWithLibreOffice({
    inputPath: inputs.docx,
    format: "pdf",
    env: fakeEnv(log, { convert: "warn" }),
    detection: validDetection,
  });
  expect(result.stderr).toContain("FAKE_WARNING");
  expect(typeof result.stdout).toBe("string");
});

addConversion("sha256 matches the returned bytes", async () => {
  const result = await convertOk("sha");
  const buffer = Buffer.from(result.dataBase64 ?? "", "base64");
  expect(buffer.byteLength).toBe(result.bytes);
  expect(result.sha256).toHaveLength(64);
});

addConversion("pdf output starts with the PDF magic", async () => {
  const result = await convertOk("pdf-magic");
  const buffer = Buffer.from(result.dataBase64 ?? "", "base64");
  expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
});

addConversion("version is reported from detection", async () => {
  const result = await convertOk("version");
  expect(result.version).toBe("24.2.1.2");
});

addConversion("uppercase input extension converts", async () => {
  const result = await convertOk("upper-input", {
    inputPath: inputs.upper,
    format: "pdf",
  });
  expect(result.bytes).toBeGreaterThan(0);
});

addConversion("uppercase input converts to docx", async () => {
  const result = await convertOk("upper-input-docx", {
    inputPath: inputs.upper,
    format: "docx",
  });
  expect(result.format).toBe("docx");
});

addConversion("uppercase input converts to html", async () => {
  const result = await convertOk("upper-input-html", {
    inputPath: inputs.upper,
    format: "html",
  });
  expect(result.format).toBe("html");
});

addConversion("input path with spaces and unicode", async () => {
  const result = await convertOk("input-spaces", {
    inputPath: inputs.spaces,
    format: "pdf",
  });
  expect(result.bytes).toBeGreaterThan(0);
});

addConversion("input name with multiple dots", async () => {
  const file = path.join(root, "sample.input.v2.docx");
  await writeFile(file, "fake", "utf8");
  const result = await convertOk("input-dots", {
    inputPath: file,
    format: "pdf",
  });
  expect(result.bytes).toBeGreaterThan(0);
});

addConversion("explicit filter with leading space", async () => {
  const result = await convertOk("filter-leading", {
    format: "pdf: writer_pdf_Export",
  });
  expect(result.filter).toBe("writer_pdf_Export");
});

addConversion("explicit filter with trailing space", async () => {
  const result = await convertOk("filter-trailing", {
    format: "pdf:writer_pdf_Export ",
  });
  expect(result.filter).toBe("writer_pdf_Export");
});

addConversion(
  "colon-only filter passes through as a single argument",
  async () => {
    const result = await convertOk("filter-colon", { format: "pdf::" });
    expect(result.filter).toBe(":");
  },
);

addConversion("hidden output file name", async () => {
  const outputPath = path.join(workspace, ".hidden.pdf");
  const result = await convertOk("output-hidden", { outputPath });
  expect(result.path).toBe(outputPath);
  await rm(outputPath, { force: true });
});

addConversion("output name with unicode", async () => {
  const outputPath = path.join(workspace, "résumé é.pdf");
  const result = await convertOk("output-unicode", { outputPath });
  expect(result.path).toBe(outputPath);
  await rm(outputPath, { force: true });
});

addConversion("user profile is a file URL", async () => {
  const result = await convertOk("profile-url");
  expect(result.userProfile.startsWith("file://")).toBe(true);
});

addConversion("input path is the final command argument", async () => {
  const result = await convertOk("args-last");
  expect(result.command.args[result.command.args.length - 1]).toBe(inputs.docx);
});

addConversion("clean success keeps stdout empty", async () => {
  const result = await convertOk("stdout-empty");
  expect(result.stdout).toBe("");
});

addConversion(
  "command executable is the configured script runner",
  async () => {
    const result = await convertOk("executable");
    expect(result.command.executable).toBe(process.execPath);
  },
);

addConversion("written output size matches reported bytes", async () => {
  const outputPath = path.join(workspace, "size-check.pdf");
  const result = await convertOk("size-check", { outputPath });
  const info = await stat(outputPath);
  expect(info.size).toBe(result.bytes);
  await rm(outputPath, { force: true });
});

addConversion("odt explicit filter writes output", async () => {
  const outputPath = path.join(workspace, "explicit.odt");
  const result = await convertOk("filter-output", {
    format: "odt:writer8",
    outputPath,
  });
  expect(result.path).toBe(outputPath);
  expect(result.filter).toBe("writer8");
  await rm(outputPath, { force: true });
});

addConversion("html explicit filter writes output", async () => {
  const outputPath = path.join(workspace, "explicit.html");
  const result = await convertOk("filter-output-html", {
    format: "html:HTML (StarWriter)",
    outputPath,
  });
  expect(result.path).toBe(outputPath);
  expect(result.filter).toBe("HTML (StarWriter)");
  await rm(outputPath, { force: true });
});

describe("LibreOffice conversion arguments and validation", () => {
  for (const testCase of conversionCases) {
    it(testCase.name, testCase.run);
  }
  it("reports the conversion case count", () => {
    expect(conversionCases.length).toBeGreaterThanOrEqual(150);
    console.log(`conversion cases: ${conversionCases.length}`);
  });
});

/* ============================================================ error mapping */

const errorCases: TestCase[] = [];

function addError(name: string, run: () => Promise<void>): void {
  errorCases.push({ name, run });
}

interface FailingOptions {
  mode: string;
  code: string;
  format?: string;
  timeoutMs?: number;
  outputPath?: string;
  inputPath?: string;
  marker?: string;
  exitCode?: string;
  env?: NodeJS.ProcessEnv;
  detection?: LibreOfficeDetection;
}

async function runFailingConversion(
  options: FailingOptions,
): Promise<{ error: LibreOfficeError; log: string }> {
  const log = uniqueLog(`error-${options.mode}`);
  const env =
    options.env ??
    fakeEnv(log, {
      convert: options.mode,
      ...(options.marker === undefined ? {} : { marker: options.marker }),
      ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    });
  const error = await expectCode(
    convertWithLibreOffice({
      inputPath: options.inputPath ?? inputs.docx,
      format: options.format ?? "pdf",
      env,
      detection:
        options.detection ?? (options.env ? undefined : validDetection),
      workspaceRoot: workspace,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.outputPath === undefined
        ? {}
        : { outputPath: options.outputPath }),
    }),
    options.code,
  );
  return { error, log };
}

const errorFormats = ["pdf", "docx", "odt", "rtf", "txt", "html"] as const;

for (const format of errorFormats) {
  for (let markerIndex = 0; markerIndex < 10; markerIndex += 1) {
    const marker = `FINGERPRINT-${format}-${markerIndex}`;
    addError(
      `exit 1 marker ${marker} (${format}) maps to ENGINE_FAILED`,
      async () => {
        const { error } = await runFailingConversion({
          mode: "exit1-marker",
          code: "ENGINE_FAILED",
          format,
          marker,
        });
        const details = error.details as { stderrTail?: string };
        expect(details.stderrTail).toContain(`FAKE_MARKER:${marker}`);
        expect(error.message).toContain("code 1");
      },
    );
  }
}

for (const exitCode of ["2", "42", "126", "127", "255"]) {
  addError(`exit code ${exitCode} maps to ENGINE_FAILED`, async () => {
    const { error } = await runFailingConversion({
      mode: "exit-custom",
      code: "ENGINE_FAILED",
      exitCode,
    });
    const details = error.details as { exitCode?: number };
    expect(details.exitCode).toBe(Number(exitCode));
    expect(error.message).toContain(exitCode);
  });
}

for (const mode of ["signal", "signal-term", "signal-int", "signal-hup"]) {
  addError(`${mode} maps to ENGINE_FAILED`, async () => {
    const { error } = await runFailingConversion({
      mode,
      code: "ENGINE_FAILED",
    });
    const details = error.details as {
      signal?: string | null;
      exitCode?: number | null;
    };
    expect(details.signal ?? details.exitCode).toBeTruthy();
    expect(error.message).toMatch(/signal|code/);
  });
}

for (const mode of ["sleep", "grandchild"] as const) {
  for (const timeoutMs of [50, 75, 100, 150, 200, 250, 300, 400]) {
    addError(
      `timeout ${mode} at ${timeoutMs} ms kills and reports ENGINE_TIMEOUT`,
      async () => {
        const started = Date.now();
        const { error } = await runFailingConversion({
          mode,
          code: "ENGINE_TIMEOUT",
          timeoutMs,
        });
        expect(Date.now() - started).toBeLessThan(timeoutMs + 4_000);
        const details = error.details as {
          timeoutMs?: number;
          detection?: LibreOfficeDetection;
        };
        expect(details.timeoutMs).toBe(timeoutMs);
        expect(details.detection?.available).toBe(true);
      },
    );
  }
}

for (const format of ["pdf", "docx", "odt", "rtf", "txt", "html"]) {
  addError(`zero-byte output (${format}) maps to OUTPUT_MISSING`, async () => {
    await runFailingConversion({
      mode: "zero",
      code: "OUTPUT_MISSING",
      format,
    });
  });
}

for (const format of ["pdf", "docx", "odt", "rtf", "txt"]) {
  addError(
    `absent output file (${format}) maps to OUTPUT_MISSING`,
    async () => {
      await runFailingConversion({
        mode: "missing",
        code: "OUTPUT_MISSING",
        format,
      });
    },
  );
}

for (const format of ["pdf", "docx", "odt"]) {
  addError(
    `wrong output extension (${format}) maps to OUTPUT_MISSING`,
    async () => {
      await runFailingConversion({
        mode: "wrong-extension",
        code: "OUTPUT_MISSING",
        format,
      });
    },
  );
}

for (const format of ["pdf", "docx", "odt", "rtf", "txt"]) {
  addError(
    `partial file then failure (${format}) maps to ENGINE_FAILED`,
    async () => {
      const { error } = await runFailingConversion({
        mode: "partial-then-fail",
        code: "ENGINE_FAILED",
        format,
      });
      expect(error.message).toContain("code 1");
    },
  );
}

for (const [index, format] of ["pdf", "docx", "odt"].entries()) {
  addError(
    `unwritable output parent #${index} maps to ENGINE_FAILED`,
    async () => {
      const blockedParent = path.join(workspace, `blocked-${index}`);
      await writeFile(blockedParent, "not a directory", "utf8");
      await runFailingConversion({
        mode: "ok",
        code: "ENGINE_FAILED",
        format,
        outputPath: path.join(blockedParent, `out.${format}`),
      });
      await rm(blockedParent, { force: true });
    },
  );
}

for (const [index, format] of ["pdf", "docx", "odt"].entries()) {
  addError(
    `read-only conversion #${index} maps to READ_ONLY_MODE`,
    async () => {
      const log = uniqueLog(`error-readonly-${index}`);
      await expectCode(
        convertWithLibreOffice({
          inputPath: inputs.docx,
          format,
          outputPath: path.join(workspace, `ro-${index}.${format}`),
          readOnly: true,
          env: fakeEnv(log),
          detection: validDetection,
          workspaceRoot: workspace,
        }),
        "READ_ONLY_MODE",
      );
    },
  );
}

const unavailableEnvironments: Array<[string, () => NodeJS.ProcessEnv]> = [
  ["missing override", () => absentEnv()],
  [
    "missing override with real PATH and no standard install",
    () => ({
      ...absentEnv(),
      PATH: process.env.PATH ?? "",
      DSH_SOFFICE_PATH: path.join(root, "never-there.mjs"),
    }),
  ],
  ["cmd shim", () => ({ ...absentEnv(), DSH_SOFFICE_PATH: cmdPath })],
  ["bat shim", () => ({ ...absentEnv(), DSH_SOFFICE_PATH: batPath })],
  [
    "directory instead of executable",
    () => ({ ...absentEnv(), DSH_SOFFICE_PATH: directoryPath }),
  ],
  [
    "empty environment",
    () => ({ PATH: "", PATHEXT: ".EXE", DSH_SOFFICE_PATH: "" }),
  ],
  [
    "PATH directory without soffice",
    () => ({
      PATH: path.join(root, "empty-path"),
      PATHEXT: ".EXE",
      DSH_SOFFICE_PATH: "",
      ProgramFiles: path.join(root, "missing-a"),
      "ProgramFiles(x86)": path.join(root, "missing-b"),
    }),
  ],
  [
    "lowercase path key without soffice",
    () => ({
      path: path.join(root, "empty-path-2"),
      PATHEXT: ".EXE",
      DSH_SOFFICE_PATH: "",
      ProgramFiles: path.join(root, "missing-c"),
      "ProgramFiles(x86)": path.join(root, "missing-d"),
    }),
  ],
  [
    "non-executable candidate",
    () => ({ ...absentEnv(), DSH_SOFFICE_PATH: nonexecPath }),
  ],
  [
    "unicode missing candidate",
    () => ({
      ...absentEnv(),
      DSH_SOFFICE_PATH: path.join(root, "no soffice é.exe"),
    }),
  ],
];

for (const [index, [label, environment]] of unavailableEnvironments.entries()) {
  addError(
    `unavailable engine (${label}) #${index} maps to ENGINE_UNAVAILABLE`,
    async () => {
      const { error } = await runFailingConversion({
        mode: "ok",
        code: "ENGINE_UNAVAILABLE",
        env: environment(),
      });
      const details = error.details as { detection?: LibreOfficeDetection };
      expect(details.detection?.available).toBe(false);
      expect(details.detection?.reason).toBeTruthy();
    },
  );
}

addError("non-executable executable detected before conversion", async () => {
  await runFailingConversion({
    mode: "ok",
    code: "ENGINE_UNAVAILABLE",
    env: { ...absentEnv(), DSH_SOFFICE_PATH: nonexecPath },
  });
});

for (const index of [0, 1]) {
  addError(`spawn failure #${index} maps to ENGINE_UNAVAILABLE`, async () => {
    const brokenPath = index === 0 ? nonexecPath : directoryPath;
    const { error } = await runFailingConversion({
      mode: "ok",
      code: "ENGINE_UNAVAILABLE",
      detection: { ...validDetection, path: brokenPath },
    });
    const details = error.details as {
      spawnError?: { code?: string };
    };
    expect(details.spawnError?.code).toBeTruthy();
  });
}

for (let repeat = 0; repeat < 5; repeat += 1) {
  addError(`repeated failure ${repeat} keeps a stable code`, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await runFailingConversion({
        mode: "exit1",
        code: "ENGINE_FAILED",
      });
      expect(error.code).toBe("ENGINE_FAILED");
    }
  });
}

for (let index = 0; index < 10; index += 1) {
  addError(`mixed failing calls do not crash #${index}`, async () => {
    const calls = [
      runFailingConversion({
        mode: "exit1",
        code: "ENGINE_FAILED",
      }),
      runFailingConversion({
        mode: "zero",
        code: "OUTPUT_MISSING",
      }),
      runFailingConversion({
        mode: "missing",
        code: "OUTPUT_MISSING",
      }),
    ];
    const results = await Promise.all(calls);
    expect(results).toHaveLength(3);
    for (const entry of results) {
      expect(entry.error).toBeInstanceOf(LibreOfficeError);
    }
  });
}

for (const [index, mode] of [
  "exit1",
  "zero",
  "missing",
  "partial-then-fail",
  "wrong-extension",
].entries()) {
  addError(
    `failure cleanup #${index} ${mode} removes the profile`,
    async () => {
      const { log } = await runFailingConversion({
        mode,
        code:
          mode === "exit1" || mode === "partial-then-fail"
            ? "ENGINE_FAILED"
            : "OUTPUT_MISSING",
      });
      const lines = await readLog(log);
      const conversion = lines.find((line) => line.kind === "convert");
      expect(conversion).toBeDefined();
      expect(existsSync(conversion.profile)).toBe(false);
    },
  );
}

for (const [index, timeoutMs] of [200, 250, 300].entries()) {
  addError(`timeout cleanup #${index} removes the profile`, async () => {
    const { log } = await runFailingConversion({
      mode: "sleep",
      code: "ENGINE_TIMEOUT",
      timeoutMs,
    });
    const lines = await readLog(log);
    const conversion = lines.find((line) => line.kind === "convert");
    expect(conversion).toBeDefined();
    expect(existsSync(conversion.profile)).toBe(false);
  });
}

for (const [index, mode] of ["exit1", "zero", "missing"].entries()) {
  addError(`failure details keep executable identity #${index}`, async () => {
    const { error } = await runFailingConversion({
      mode,
      code: mode === "exit1" ? "ENGINE_FAILED" : "OUTPUT_MISSING",
    });
    const details = error.details as { executable?: string };
    expect(details.executable).toBe(process.execPath);
  });
}

for (const [index, format] of ["pdf", "docx", "odt"].entries()) {
  addError(`failure with output path leaves no file #${index}`, async () => {
    const outputPath = path.join(workspace, `failed-${index}.${format}`);
    await runFailingConversion({
      mode: "exit1",
      code: "ENGINE_FAILED",
      format,
      outputPath,
    });
    expect(existsSync(outputPath)).toBe(false);
  });
}

describe("LibreOffice error mapping", () => {
  for (const testCase of errorCases) {
    it(testCase.name, testCase.run);
  }
  it("reports the error mapping case count", () => {
    expect(errorCases.length).toBeGreaterThanOrEqual(150);
    console.log(`error mapping cases: ${errorCases.length}`);
  });
});

/* ========================================================== differential */

describe("LibreOffice differential PDF helpers", () => {
  it("counts PDF pages from page objects", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Pages /Count 1 >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF\n",
      "latin1",
    );
    expect(countPdfPages(pdf)).toBe(2);
    expect(countPdfPages(Buffer.from("not a pdf"))).toBeUndefined();
  });

  it("renders a PDF through the fake engine and hashes it", async () => {
    const result = await renderPdfWithLibreOffice(inputs.docx, {
      env: fakeEnv(uniqueLog("render-pdf")),
      detection: validDetection,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toHaveLength(64);
    expect(result.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(result.path).toBeNull();
  });

  it("rejects non-DOCX input for the PDF differential hook", async () => {
    await expectCode(
      renderPdfWithLibreOffice(inputs.odt, {
        env: fakeEnv(uniqueLog("render-odt")),
        detection: validDetection,
      }),
      "FORMAT_UNSUPPORTED",
    );
  });

  it("reports both sides when internal and LibreOffice PDFs exist", async () => {
    const internal = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n",
      "latin1",
    );
    const libre = await renderPdfWithLibreOffice(inputs.docx, {
      env: fakeEnv(uniqueLog("compare")),
      detection: validDetection,
    });
    const comparison = await comparePdfEngines({
      docxPath: inputs.docx,
      internalPdf: internal,
      libreOfficeResult: libre,
    });
    expect(comparison.bothPresent).toBe(true);
    expect(comparison.internal.pageCount).toBe(1);
    expect(comparison.libreoffice.bytes).toBe(libre.bytes);
    expect(comparison.pixelComparison).toBe("not-performed");
  });

  it("reports missing sides honestly", async () => {
    const comparison = await comparePdfEngines({
      docxPath: inputs.docx,
      internalPdf: null,
      libreOfficePdf: null,
    });
    expect(comparison.bothPresent).toBe(false);
    expect(comparison.internal.present).toBe(false);
    expect(comparison.libreoffice.present).toBe(false);
    expect(comparison.notes.length).toBeGreaterThan(0);
  });

  it("resolves conversion filters without running a process", () => {
    const resolved = resolveConversionFormat("html:HTML (StarWriter)");
    expect(resolved.extension).toBe("html");
    expect(resolved.filter).toBe("HTML (StarWriter)");
    expect(resolved.convertTo).toBe("html:HTML (StarWriter)");
  });
});

/* ================================================= real binary integration */

/**
 * This machine has LibreOffice installed, but CI (for example a Linux runner)
 * may not. The guarded suite is collected either way and skips with the
 * detection reason when no binary answers `--version`.
 */
function realEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DSH_SOFFICE_PATH;
  delete env.DSH_FAKE_VERSION_MODE;
  delete env.DSH_FAKE_MODE;
  delete env.DSH_FAKE_LOG;
  return env;
}

const realDetection = await detectLibreOffice({
  env: realEnvironment(),
  refresh: true,
});
const realTest = realDetection.available ? it : it.skip;

if (!realDetection.available) {
  console.warn(
    `[libreoffice-real] skipping real-binary tests: ${realDetection.reason ?? "not found"}`,
  );
}

describe("LibreOffice real binary (guarded)", () => {
  realTest(
    "detects the synchronous console wrapper",
    () => {
      expect(realDetection.available, realDetection.reason).toBe(true);
      expect(realDetection.path).toBeTruthy();
      const executable = path.basename(realDetection.path ?? "").toLowerCase();
      if (process.platform === "win32") {
        expect(executable).toBe("soffice.com");
      } else {
        expect(executable).toMatch(/^soffice(\.bin)?$/);
      }
      expect(realDetection.version).toMatch(/^\d+\.\d+/);
      console.log(
        `real LibreOffice: ${realDetection.version} at ${realDetection.path}`,
      );
    },
    180_000,
  );

  realTest(
    "reports the real engine through DocumentService.engineStatus",
    async () => {
      const workspace = await mkdtemp(path.join(baseDir, "real-status-"));
      const service = new DocumentService({
        workspaceRoot: workspace,
        allowedReadRoots: [workspace],
        auditPath: path.join(workspace, "audit.log"),
      });
      await service.init();
      try {
        const status = await service.engineStatus({ refresh: true });
        const lo = status.engines.libreoffice as any;
        const pdf = status.capabilities.find((entry) => entry.format === "pdf");
        console.log(
          JSON.stringify(
            {
              realEngineStatus: {
                available: status.available,
                reason: status.reason,
                path: lo.path,
                version: lo.version,
                pdf: pdf?.libreoffice,
              },
            },
            null,
            2,
          ),
        );
        expect(status.available).toBe(true);
        expect(status.reason).toBeNull();
        expect(lo.available).toBe(true);
        expect(pdf?.libreoffice.export).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    120_000,
  );

  realTest(
    "converts the fixture DOCX to PDF with a real process",
    async () => {
      const fixture = path.resolve(
        process.cwd(),
        "fixtures/docx_docs_renderer_feature_test_cases.docx",
      );
      const workspace = await mkdtemp(path.join(baseDir, "real-pdf-"));
      const outputPath = path.join(workspace, "real-libreoffice.pdf");
      const started = Date.now();
      try {
        const result = await convertWithLibreOffice({
          inputPath: fixture,
          format: "pdf",
          outputPath,
          timeoutMs: 180_000,
          env: realEnvironment(),
          detection: realDetection,
          workspaceRoot: workspace,
        });
        const bytes = await readFile(outputPath);
        expect(result.bytes).toBeGreaterThan(1_000);
        expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        expect(result.command.executable.toLowerCase()).toContain("soffice");
        console.log(
          JSON.stringify(
            {
              realConversion: {
                input: path.basename(fixture),
                outputBytes: result.bytes,
                pageCount: countPdfPages(bytes) ?? null,
                durationMs: Date.now() - started,
                executable: result.executable,
                version: result.version,
              },
            },
            null,
            2,
          ),
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    300_000,
  );

  realTest(
    "reports internal vs LibreOffice PDF page counts and sizes honestly",
    async () => {
      const fixture = path.resolve(
        process.cwd(),
        "fixtures/docx_docs_renderer_feature_test_cases.docx",
      );
      const workspace = await mkdtemp(path.join(baseDir, "real-diff-"));
      const service = new DocumentService({
        workspaceRoot: workspace,
        allowedReadRoots: [workspace, path.dirname(fixture)],
        auditPath: path.join(workspace, "audit.log"),
      });
      await service.init();
      try {
        const opened = await service.openDocument(fixture);
        const internal = await service.exportPdf(opened.documentId);
        const internalPdf = Buffer.from(internal.dataBase64 ?? "", "base64");
        const libreOffice = await renderPdfWithLibreOffice(fixture, {
          env: realEnvironment(),
          detection: realDetection,
          timeoutMs: 180_000,
        });
        const comparison = await comparePdfEngines({
          docxPath: fixture,
          internalPdf,
          libreOfficeResult: libreOffice,
        });
        const summary = {
          differentialPdf: {
            internal: {
              bytes: internalPdf.byteLength,
              pages: comparison.internal.pageCount ?? null,
            },
            libreoffice: {
              bytes: libreOffice.bytes,
              pages: comparison.libreoffice.pageCount ?? null,
            },
            bothPresent: comparison.bothPresent,
            byteIdentical: comparison.byteIdentical,
            pixelComparison: comparison.pixelComparison,
            notes: comparison.notes,
          },
        };
        console.log(JSON.stringify(summary, null, 2));
        expect(comparison.bothPresent).toBe(true);
        expect(internalPdf.byteLength).toBeGreaterThan(1_000);
        expect(libreOffice.bytes).toBeGreaterThan(1_000);
        expect(internal.pageCount).toBeGreaterThan(0);
        expect(comparison.internal.pageCount).toBeGreaterThan(0);
        expect(comparison.libreoffice.pageCount).toBeGreaterThan(0);
        expect(comparison.pixelComparison).toBe("not-performed");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    300_000,
  );

  realTest(
    "compares DOCX to ODT to DOCX through LibreOffice with our ODT round trip",
    async () => {
      const fixture = path.resolve(
        process.cwd(),
        "fixtures/docx_docs_renderer_feature_test_cases.docx",
      );
      const workspace = await mkdtemp(path.join(baseDir, "real-odt-"));
      const service = new DocumentService({
        workspaceRoot: workspace,
        allowedReadRoots: [workspace, path.dirname(fixture)],
        auditPath: path.join(workspace, "audit.log"),
      });
      await service.init();
      try {
        // Our path: DOCX -> internal ODT exporter -> importer -> text.
        const opened = await service.openDocument(fixture);
        const ourOdtPath = path.join(workspace, "internal-roundtrip.odt");
        await service.exportDocument(opened.documentId, "odt", ourOdtPath);
        const ourImport = await service.openDocument(ourOdtPath);
        const ourText = service.getText(ourImport.documentId).text;

        // LibreOffice path: DOCX -> ODT -> DOCX -> our DOCX importer.
        const libreOdtPath = path.join(workspace, "libreoffice.odt");
        const libreDocxPath = path.join(
          workspace,
          "libreoffice-roundtrip.docx",
        );
        const toOdt = await convertWithLibreOffice({
          inputPath: fixture,
          format: "odt",
          outputPath: libreOdtPath,
          timeoutMs: 180_000,
          env: realEnvironment(),
          detection: realDetection,
          workspaceRoot: workspace,
        });
        const backToDocx = await convertWithLibreOffice({
          inputPath: libreOdtPath,
          format: "docx",
          outputPath: libreDocxPath,
          timeoutMs: 180_000,
          env: realEnvironment(),
          detection: realDetection,
          workspaceRoot: workspace,
        });
        const libreImport = await service.openDocument(libreDocxPath);
        const libreText = service.getText(libreImport.documentId).text;

        const normalize = (value: string) =>
          value.replace(/\s+/g, " ").trim().toLowerCase();
        const ourNormalized = normalize(ourText);
        const libreNormalized = normalize(libreText);
        const ourWords = ourNormalized.split(" ").filter(Boolean);
        const libreWords = libreNormalized.split(" ").filter(Boolean);
        const ourTokens = new Set(ourWords);
        const libreTokens = new Set(libreWords);
        let shared = 0;
        for (const token of ourTokens) {
          if (libreTokens.has(token)) shared += 1;
        }
        const union = new Set([...ourTokens, ...libreTokens]).size;
        const sameNormalizedText = ourNormalized === libreNormalized;
        const classification = sameNormalizedText
          ? "identical-normalized-text"
          : shared / Math.max(1, union) > 0.9
            ? "near-identical-text"
            : "different-text";
        const report = {
          odtRoundTrip: {
            internal: {
              bytes: (await stat(ourOdtPath)).size,
              words: ourWords.length,
            },
            libreoffice: {
              odtBytes: toOdt.bytes,
              docxBytes: backToDocx.bytes,
              words: libreWords.length,
            },
            wordDelta: libreWords.length - ourWords.length,
            tokenOverlap: Number((shared / Math.max(1, union)).toFixed(4)),
            sameNormalizedText,
            classification,
          },
        };
        console.log(JSON.stringify(report, null, 2));
        expect(ourText.trim().length).toBeGreaterThan(0);
        expect(libreText.trim().length).toBeGreaterThan(0);
        expect(toOdt.bytes).toBeGreaterThan(0);
        expect(backToDocx.bytes).toBeGreaterThan(0);
        expect(classification).toMatch(
          /^(identical-normalized-text|near-identical-text|different-text)$/,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
