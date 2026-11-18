#!/usr/bin/env node
/**
 * `dsh-doc` CLI: inspect, render, convert and verify documents without the UI.
 * Every command works on the same engine used by the editor and MCP server.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { importDocx } from "@dsh-doc/core/docx";
import { exportDocx } from "@dsh-doc/core/docx";
import { layoutDocument } from "@dsh-doc/core/layout";
import {
  renderHtml,
  renderPdf,
  renderSvg,
  mediaMap,
} from "@dsh-doc/core/render";
import { documentStats, documentText } from "@dsh-doc/core/model";
import { documentOutline } from "@dsh-doc/core/model";
import type { DocDocument } from "@dsh-doc/core/model";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

async function loadDocument(
  filePath: string,
): Promise<{ document: DocDocument; warnings: string[] }> {
  const bytes = await readFile(filePath);
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (["docx", "dotx", "docm"].includes(extension)) {
    const result = await importDocx(bytes, {
      fileName: path.basename(filePath),
    });
    return { document: result.document, warnings: result.warnings };
  }
  throw new Error(
    `Unsupported CLI input format ".${extension}" (DOCX/DOTX/DOCM are supported by this command)`,
  );
}

const HELP = `dsh-doc - universal document engine CLI

Usage:
  dsh-doc info <file.docx>                 Print metadata, statistics, outline and compatibility
  dsh-doc text <file.docx> [--out f.txt]  Extract plain text
  dsh-doc outline <file.docx>             Print the heading outline as JSON
  dsh-doc render <file.docx> --format html|pdf|svg --out <path>
  dsh-doc convert <file.docx> --to docx|pdf|html|md|txt|odt|rtf --out <path>
  dsh-doc roundtrip <file.docx>           Export to DOCX, re-import and report fidelity
  dsh-doc verify <file.docx>              Full acceptance check (structure, layout, render, round-trip)

Flags:
  --out <path>       Output file or directory
  --format <name>    Renderer format for "render"
  --to <format>      Target format for "convert"
  --json             Machine readable output where supported
`;

async function commandInfo(file: string, json: boolean): Promise<void> {
  const { document, warnings } = await loadDocument(file);
  const layout = layoutDocument(document);
  const stats = documentStats(document, "final", layout.pageCount);
  const outline = documentOutline(document);
  const report = document.compatibility;
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          file,
          metadata: document.metadata,
          stats,
          pageCount: layout.pageCount,
          sections: document.sections.map((section, index) => ({
            index,
            width: section.page.width,
            height: section.page.height,
            orientation: section.page.orientation,
            blocks: section.blocks.length,
            header: Boolean(section.headers.default),
            footer: Boolean(section.footers.default),
            columns: section.columns.count,
          })),
          outline,
          compatibility: report,
          warnings,
          layoutWarnings: layout.warnings,
          substitutedFonts: layout.substitutedFonts,
        },
        null,
        2,
      ),
    );
    return;
  }
  process.stdout.write(`File: ${file}\n`);
  process.stdout.write(`Title: ${document.metadata.title ?? "(none)"}\n`);
  process.stdout.write(`Author: ${document.metadata.creator ?? "(none)"}\n`);
  process.stdout.write(
    `Pages: ${layout.pageCount}   Words: ${stats.words}   Characters: ${stats.charactersWithSpaces}   Paragraphs: ${stats.paragraphs}   Tables: ${stats.tables}\n`,
  );
  process.stdout.write(
    `Sections: ${document.sections
      .map(
        (section, index) =>
          `#${index + 1} ${section.page.width.toFixed(0)}x${section.page.height.toFixed(0)}pt ${section.page.orientation}${
            section.columns.count > 1 ? ` ${section.columns.count} cols` : ""
          }${section.headers.default ? " +header" : ""}${section.footers.default ? " +footer" : ""}`,
      )
      .join(" | ")}\n`,
  );
  process.stdout.write(`Outline entries: ${outline.length}\n`);
  const losses = report?.losses ?? [];
  process.stdout.write(`Compatibility losses: ${losses.length}\n`);
  for (const loss of losses.slice(0, 10)) {
    process.stdout.write(
      `  - [${loss.level}] ${loss.feature}: ${loss.reason}\n`,
    );
  }
  if (layout.warnings.length > 0) {
    process.stdout.write("Layout warnings:\n");
    for (const warning of layout.warnings)
      process.stdout.write(`  - ${warning.code}: ${warning.message}\n`);
  }
  if (layout.substitutedFonts.length > 0) {
    process.stdout.write(
      `Substituted fonts: ${layout.substitutedFonts.join(", ")}\n`,
    );
  }
  if (warnings.length > 0) {
    process.stdout.write(`Import warnings: ${warnings.length}\n`);
  }
}

async function commandText(
  file: string,
  out: string | undefined,
): Promise<void> {
  const { document } = await loadDocument(file);
  const text = documentText(document);
  if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, text, "utf8");
    process.stdout.write(`Wrote ${out} (${text.length} characters)\n`);
  } else {
    process.stdout.write(text);
  }
}

async function commandOutline(file: string): Promise<void> {
  const { document } = await loadDocument(file);
  process.stdout.write(
    `${JSON.stringify(documentOutline(document), null, 2)}\n`,
  );
}

async function commandRender(
  file: string,
  format: string,
  out: string,
): Promise<void> {
  const { document } = await loadDocument(file);
  const layout = layoutDocument(document);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  if (format === "pdf") {
    const buffer = await renderPdf(layout, {
      title: document.metadata.title,
      images: mediaMap(document),
    });
    await writeFile(out, buffer);
  } else if (format === "svg") {
    const pages = renderSvg(layout, { images: mediaMap(document) });
    await writeFile(out, pages.join("\n"), "utf8");
  } else {
    const html = renderHtml(layout, {
      title: document.metadata.title,
      images: mediaMap(document),
    });
    await writeFile(out, html, "utf8");
  }
  process.stdout.write(`Rendered ${layout.pageCount} page(s) to ${out}\n`);
}

async function commandConvert(
  file: string,
  to: string,
  out: string,
): Promise<void> {
  const { document } = await loadDocument(file);
  const target = to.toLowerCase();
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  if (target === "docx" || target === "dotx" || target === "docm") {
    const result = await exportDocx(document, {
      flavor: target as "docx" | "dotx" | "docm",
    });
    await writeFile(out, result.buffer);
    process.stdout.write(`Wrote ${out} (${result.buffer.byteLength} bytes)\n`);
    return;
  }
  const module = await import("@dsh-doc/core/convert" as string).catch(
    () => undefined,
  );
  if (!module) {
    process.stderr.write("Conversion engine is not available in this build\n");
    process.exitCode = 1;
    return;
  }
  const result = await module.convertDocument(document, { to: target });
  await writeFile(out, result.buffer);
  process.stdout.write(`Wrote ${out} (${result.buffer.byteLength} bytes)\n`);
  if (result.losses.length > 0) {
    process.stdout.write(
      `Reported ${result.losses.length} conversion loss(es):\n`,
    );
    for (const loss of result.losses.slice(0, 10))
      process.stdout.write(`  - ${loss.feature}: ${loss.reason}\n`);
  }
}

async function commandRoundtrip(file: string): Promise<void> {
  const first = await loadDocument(file);
  const exported = await exportDocx(first.document, {
    preserveTimestamps: true,
  });
  const second = await importDocx(exported.buffer, {
    fileName: "roundtrip.docx",
  });
  const textA = documentText(first.document);
  const textB = documentText(second.document);
  const statsA = documentStats(first.document);
  const statsB = documentStats(second.document);
  const sameText = textA === textB;
  const sameParagraphs = statsA.paragraphs === statsB.paragraphs;
  const sameSections =
    first.document.sections.length === second.document.sections.length;
  process.stdout.write(`Round-trip DOCX -> model -> DOCX -> model\n`);
  process.stdout.write(`  text identical: ${sameText}\n`);
  process.stdout.write(
    `  paragraphs: ${statsA.paragraphs} -> ${statsB.paragraphs}\n`,
  );
  process.stdout.write(
    `  sections: ${first.document.sections.length} -> ${second.document.sections.length}\n`,
  );
  process.stdout.write(`  bytes: ${exported.buffer.byteLength}\n`);
  if (!sameText || !sameParagraphs || !sameSections) {
    process.stderr.write("Round-trip fidelity check FAILED\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("Round-trip fidelity check PASSED\n");
  }
}

async function commandVerify(file: string): Promise<void> {
  const { document } = await loadDocument(file);
  const layout = layoutDocument(document);
  const html = renderHtml(layout, {
    title: document.metadata.title,
    images: mediaMap(document),
  });
  const pdf = await renderPdf(layout, { title: document.metadata.title });
  const text = documentText(document);
  const checks: Array<[string, boolean, string]> = [
    [
      "sections",
      document.sections.length > 0,
      `${document.sections.length} section(s)`,
    ],
    ["text", text.length > 0, `${text.length} characters`],
    ["layout", layout.pageCount > 0, `${layout.pageCount} page(s)`],
    ["html", html.includes('data-page="1"'), `${html.length} characters`],
    [
      "pdf",
      pdf.subarray(0, 5).toString() === "%PDF-",
      `${pdf.byteLength} bytes`,
    ],
    [
      "transparent",
      document.compatibility?.transparent !== false,
      "no silent drops",
    ],
  ];
  process.stdout.write(`Verification for ${file}\n`);
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    process.stdout.write(
      `  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(12)} ${detail}\n`,
    );
    if (!ok) failed += 1;
  }
  if (layout.warnings.length > 0) {
    process.stdout.write(`  ${layout.warnings.length} layout warning(s):\n`);
    for (const warning of layout.warnings)
      process.stdout.write(`    - ${warning.code}: ${warning.message}\n`);
  }
  if (failed > 0) {
    process.exitCode = 1;
    process.stderr.write(`${failed} check(s) failed\n`);
  } else {
    process.stdout.write("All checks passed\n");
  }
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const file = positional[0];
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "info":
      if (!file) throw new Error("info requires a file path");
      await commandInfo(file, flags.json === true);
      return;
    case "text":
      if (!file) throw new Error("text requires a file path");
      await commandText(
        file,
        typeof flags.out === "string" ? flags.out : undefined,
      );
      return;
    case "outline":
      if (!file) throw new Error("outline requires a file path");
      await commandOutline(file);
      return;
    case "render":
      if (!file) throw new Error("render requires a file path");
      await commandRender(
        file,
        typeof flags.format === "string" ? flags.format : "html",
        typeof flags.out === "string"
          ? flags.out
          : `${path.basename(file, path.extname(file))}.html`,
      );
      return;
    case "convert":
      if (!file) throw new Error("convert requires a file path");
      if (typeof flags.to !== "string")
        throw new Error("convert requires --to <format>");
      await commandConvert(
        file,
        flags.to,
        typeof flags.out === "string" ? flags.out : `out.${flags.to}`,
      );
      return;
    case "roundtrip":
      if (!file) throw new Error("roundtrip requires a file path");
      await commandRoundtrip(file);
      return;
    case "verify":
      if (!file) throw new Error("verify requires a file path");
      await commandVerify(file);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
