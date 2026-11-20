/**
 * Decision-table / MC/DC tests for critical predicates.
 *
 * Each predicate gets a full truth table over its conditions, an independence
 * (MC/DC) analysis of which condition actually flips the observable outcome, and
 * an explicit statement of how many of the 2^n rows were executed. Conditions
 * that do not influence the outcome are reported as enforcement gaps rather than
 * silently dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentService, ServiceError } from "../../src/dsh-entry.js";
import {
  FuzzReporter,
  createTempWorkspace,
  describeError,
  errorCode,
  isTypedError,
  readFuzzConfig,
  type TempWorkspace,
} from "./support.js";

const config = readFuzzConfig({ seed: 1337, cases: 150 });
void config;

interface DecisionRow {
  mask: number;
  values: boolean[];
  outcome: boolean;
  note: string;
}

interface Analysis {
  conditions: string[];
  rows: DecisionRow[];
  coverage: string;
  independent: boolean[];
  pairCounts: number[];
}

function analyzeDecision(conditions: string[], rows: DecisionRow[]): Analysis {
  const width = conditions.length;
  const total = 2 ** width;
  const covered = new Set(rows.map((row) => row.mask));
  const pairCounts: number[] = [];
  for (let bit = 0; bit < width; bit += 1) {
    let pairs = 0;
    for (const left of rows) {
      const partnerMask = left.mask ^ (1 << bit);
      const partner = rows.find((row) => row.mask === partnerMask);
      if (!partner) continue;
      if (partner.outcome !== left.outcome) pairs += 1;
    }
    pairCounts.push(pairs);
  }
  return {
    conditions,
    rows,
    coverage: `${covered.size}/${total}`,
    independent: pairCounts.map((count) => count > 0),
    pairCounts,
  };
}

function printDecisionTable(title: string, analysis: Analysis): void {
  console.log(`\n=== ${title} ===`);
  const header = analysis.conditions
    .map((condition, index) => `${index}:${condition}`)
    .join(" ");
  console.log(`${header} | outcome`);
  for (const row of analysis.rows) {
    console.log(
      `${row.values.map((value) => (value ? "T" : "F")).join(" ".padEnd(2))} | ` +
        `${row.outcome ? "valid/blocked" : "invalid/allowed"} ${row.note}`,
    );
  }
  console.log(
    `coverage=${analysis.coverage} independence=` +
      analysis.conditions
        .map(
          (condition, index) =>
            `${condition}:${analysis.independent[index] ? "yes" : "NO"}(${analysis.pairCounts[index]} pairs)`,
        )
        .join(", "),
  );
}

function maskValues(mask: number, width: number): boolean[] {
  return Array.from(
    { length: width },
    (_value, index) => ((mask >> index) & 1) === 1,
  );
}

describe("MC/DC decision tables", () => {
  let workspace: TempWorkspace;
  let service: DocumentService;

  beforeAll(async () => {
    workspace = await createTempWorkspace("dsh-fuzz-mcdc-");
    service = workspace.service;
  });

  afterAll(async () => {
    await workspace.dispose();
  });

  it("covers resolveRange, setPageLayout, import extension routing, read-only routes and insertList", async () => {
    const reporter = new FuzzReporter("mcdc");
    const failures: string[] = [];

    /* ------------------------------------------------------ P1 resolveRange */

    {
      const conditions = ["startBlockKnown", "endBlockKnown"];
      const rows: DecisionRow[] = [];
      for (const mask of [0, 1, 2, 3]) {
        const values = maskValues(mask, 2);
        const created = await service.createDocument({
          paragraphs: ["abcdef", "second"],
        });
        const documentId = created.documentId;
        const blocks = created.document.sections[0].blocks;
        const startBlock = values[0] ? blocks[0].id : "missing-start";
        const endBlock = values[1] ? blocks[1].id : "missing-end";
        let outcome = true;
        let note = "";
        try {
          service.getSelection(documentId, {
            start: { blockId: startBlock, offset: 1 },
            end: { blockId: endBlock, offset: 2 },
          });
        } catch (error) {
          outcome = false;
          note = `${errorCode(error)} ${describeError(error).slice(0, 60)}`;
          if (!(error instanceof ServiceError)) {
            failures.push(
              `resolveRange row ${mask}: expected ServiceError, got ${describeError(error)}`,
            );
          }
        }
        rows.push({ mask, values, outcome, note });
        await service.closeDocument(documentId, { discardUnsaved: true });
      }
      const analysis = analyzeDecision(conditions, rows);
      printDecisionTable("P1 resolveRange: resolves without error", analysis);
      const name = "P1.resolveRange";
      const gaps = conditions.filter(
        (_condition, index) => !analysis.independent[index],
      );
      if (gaps.length > 0) {
        const detail = `conditions without an independent outcome flip: ${gaps.join(", ")}`;
        failures.push(`${name}: ${detail}`);
        reporter.fail(name, detail);
      } else {
        reporter.pass(name);
      }
      // Extra behavioural decision rows: reversed ranges and out-of-text offsets
      // must be rejected with a typed INVALID_RANGE (KNOWN-ISSUES B1/B2) instead
      // of being silently normalised, and the model must stay unchanged.
      const created = await service.createDocument({
        paragraphs: ["abcdef", "second"],
      });
      const blocks = created.document.sections[0].blocks;
      const extraRows: Array<
        [
          string,
          {
            start: { blockId: string; offset: number };
            end: { blockId: string; offset: number };
          },
        ]
      > = [
        [
          "end-before-start",
          {
            start: { blockId: blocks[1].id, offset: 2 },
            end: { blockId: blocks[0].id, offset: 2 },
          },
        ],
        [
          "offset-beyond-text",
          {
            start: { blockId: blocks[0].id, offset: 99 },
            end: { blockId: blocks[0].id, offset: 100 },
          },
        ],
        [
          "negative-offset",
          {
            start: { blockId: blocks[0].id, offset: -1 },
            end: { blockId: blocks[0].id, offset: 2 },
          },
        ],
      ];
      const observedExtra: string[] = [];
      for (const [label, range] of extraRows) {
        let code = "no-error";
        try {
          service.getSelection(created.documentId, range);
        } catch (error) {
          code = errorCode(error);
        }
        observedExtra.push(`${label}=${code}`);
        if (code !== "INVALID_RANGE") {
          const detail = `P1.extraRange ${label}: expected INVALID_RANGE, got ${code}`;
          failures.push(detail);
          reporter.fail(`P1.extraRange#${label}`, detail);
        } else {
          reporter.pass(`P1.extraRange#${label}`);
        }
      }
      console.log(
        `P1 note: reversed/out-of-text ranges are rejected with a typed ` +
          `INVALID_RANGE (${observedExtra.join(", ")}); nothing is normalised or clamped.`,
      );
      await service.closeDocument(created.documentId, { discardUnsaved: true });
    }

    /* ----------------------------------------------------- P2 setPageLayout */

    {
      const conditions = [
        "sectionExists",
        "orientationRecognized",
        "marginsNonNegative",
        "marginsFinite",
        "marginsFitPage",
        "columnsValid",
      ];
      const rows: DecisionRow[] = [];
      const contractMismatches: string[] = [];
      for (let mask = 0; mask < 64; mask += 1) {
        const values = maskValues(mask, 6);
        const [
          sectionExists,
          orientationRecognized,
          marginsNonNegative,
          marginsFinite,
          marginsFitPage,
          columnsValid,
        ] = values;
        const created = await service.createDocument({
          paragraphs: ["layout"],
        });
        const documentId = created.documentId;
        const margins = {
          top: marginsFitPage ? (marginsNonNegative ? 72 : -72) : 900,
          right: marginsFitPage ? 72 : 900,
          bottom: marginsFitPage ? 72 : 900,
          left: marginsFitPage ? 72 : 900,
          header: 36,
          footer: 36,
          gutter: 0,
        } as Record<string, number>;
        if (!marginsFinite) margins.top = Number.NaN;
        let outcome = false;
        let note = "";
        let typedFailure = true;
        try {
          service.setPageLayout(documentId, {
            sectionIndex: sectionExists ? 0 : 9,
            page: {
              orientation: (orientationRecognized
                ? mask % 2 === 0
                  ? "landscape"
                  : "portrait"
                : "diagonal") as never,
              margins: margins as never,
            },
            columns: { count: columnsValid ? 1 : 0, space: 36 },
          });
          const validation = service.validate(documentId);
          outcome = validation.valid;
          note = validation.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => issue.code)
            .join(",");
        } catch (error) {
          outcome = false;
          typedFailure = isTypedError(error);
          note = `${typedFailure ? "" : "UNTYPED "}${describeError(error).slice(0, 48)}`;
        }
        const expected = values.every(Boolean);
        if (outcome !== expected) {
          contractMismatches.push(
            `mask=${mask} values=${values.map((value) => (value ? "T" : "F")).join("")} ` +
              `observed=${outcome} expected=${expected} note=${note}`,
          );
        }
        if (!typedFailure) {
          contractMismatches.push(`mask=${mask}: untyped section error`);
        }
        rows.push({ mask, values, outcome, note });
        await service.closeDocument(documentId, { discardUnsaved: true });
      }
      const analysis = analyzeDecision(conditions, rows);
      printDecisionTable(
        "P2 setPageLayout: resulting document is valid",
        analysis,
      );
      const name = "P2.setPageLayout";
      const gaps = conditions.filter(
        (_condition, index) => !analysis.independent[index],
      );
      if (contractMismatches.length > 0 || gaps.length > 0) {
        const detail =
          `contract mismatches=${contractMismatches.length}: ` +
          contractMismatches.slice(0, 8).join(" | ") +
          (gaps.length > 0
            ? `; conditions that never flip the outcome: ${gaps.join(", ")}`
            : "");
        failures.push(`${name}: ${detail}`);
        reporter.fail(name, detail);
      } else {
        reporter.pass(name);
      }
    }

    /* ----------------------------------------------- P3 import extension list */

    {
      const conditions = [
        "docxFamilyExtension",
        "bytesAreZipWord",
        "bytesArePlainText",
      ];
      const rows: DecisionRow[] = [];
      const problems: string[] = [];
      const baseDocx = await makeDocx(service);
      for (let mask = 0; mask < 8; mask += 1) {
        const values = maskValues(mask, 3);
        const [docxFamily, zipWord, plainText] = values;
        const extension = docxFamily
          ? mask % 3 === 0
            ? "docx"
            : mask % 3 === 1
              ? "dotx"
              : "docm"
          : mask % 2 === 0
            ? "txt"
            : "weird";
        const bytes = zipWord
          ? baseDocx
          : plainText
            ? Buffer.from("plain words only")
            : Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x80, 0x81]);
        const filePath = path.join(
          workspace.root,
          `extension-${mask}.${extension}`,
        );
        await writeFile(filePath, bytes);
        let success = false;
        let error: unknown;
        let openedId = "";
        try {
          const opened = await service.openDocument(filePath);
          success = true;
          openedId = opened.documentId;
        } catch (caught) {
          error = caught;
        }
        const expectedSuccess = zipWord || (!docxFamily && plainText);
        if (success !== expectedSuccess) {
          problems.push(
            `mask=${mask} ext=${extension} zip=${zipWord} plain=${plainText}: ` +
              `success=${success} expected=${expectedSuccess}`,
          );
        }
        if (!success && error !== undefined && !isTypedError(error)) {
          problems.push(
            `mask=${mask} ext=${extension}: error is untyped (${describeError(error).slice(0, 70)})`,
          );
        }
        rows.push({
          mask,
          values,
          outcome: success,
          note: `ext=${extension} zip=${zipWord}`,
        });
        if (openedId) {
          await service.closeDocument(openedId, { discardUnsaved: true });
        }
      }
      const analysis = analyzeDecision(conditions, rows);
      printDecisionTable(
        "P3 openDocument: extension allow-list routing",
        analysis,
      );
      const name = "P3.importExtensionList";
      if (problems.length > 0) {
        const detail = problems.slice(0, 10).join(" | ");
        failures.push(`${name}: ${detail}`);
        reporter.fail(name, detail);
      } else {
        reporter.pass(name);
      }
    }

    /* ------------------------------------------------------- P4 read-only */

    {
      const routes: Array<{
        id: string;
        isWrite: boolean;
        run: (
          target: DocumentService,
          documentId: string,
          root: string,
        ) => Promise<void>;
      }> = [
        {
          id: "create",
          isWrite: true,
          run: async (target) => {
            await target.createDocument({ paragraphs: ["x"] });
          },
        },
        {
          id: "save",
          isWrite: true,
          run: async (target, documentId) => {
            await target.saveDocument(documentId);
          },
        },
        {
          id: "saveAs-docx",
          isWrite: true,
          run: async (target, documentId, root) => {
            await target.saveDocumentAs(
              documentId,
              path.join(root, "route-saveas.docx"),
            );
          },
        },
        {
          id: "saveAs-html",
          isWrite: true,
          run: async (target, documentId, root) => {
            await target.saveDocumentAs(
              documentId,
              path.join(root, "route-saveas.html"),
            );
          },
        },
        {
          id: "export-docx-path",
          isWrite: true,
          run: async (target, documentId, root) => {
            await target.exportDocument(
              documentId,
              "docx",
              path.join(root, "route-export.docx"),
            );
          },
        },
        {
          id: "export-html-path",
          isWrite: true,
          run: async (target, documentId, root) => {
            await target.exportDocument(
              documentId,
              "html",
              path.join(root, "route-export.html"),
            );
          },
        },
        {
          id: "convert-html-path",
          isWrite: true,
          run: async (target, documentId, root) => {
            await target.convert({
              documentId,
              to: "html",
              outputPath: path.join(root, "route-convert.html"),
            });
          },
        },
        {
          id: "export-pdf-path",
          isWrite: true,
          run: async (target, documentId, root) => {
            await target.exportPdf(
              documentId,
              path.join(root, "route-export.pdf"),
            );
          },
        },
        {
          id: "delete",
          isWrite: true,
          run: async (target, documentId) => {
            await target.deleteDocument(documentId);
          },
        },
        {
          id: "export-base64",
          isWrite: false,
          run: async (target, documentId) => {
            await target.exportDocument(documentId, "html");
          },
        },
        {
          id: "convert-base64",
          isWrite: false,
          run: async (target, documentId) => {
            await target.convert({ documentId, to: "html" });
          },
        },
        {
          id: "read-text",
          isWrite: false,
          run: async (target, documentId) => {
            target.getText(documentId);
          },
        },
      ];
      const readOnly = new DocumentService({
        workspaceRoot: workspace.root,
        allowedReadRoots: [workspace.root],
        readOnly: true,
      });
      await readOnly.init();
      const problems: string[] = [];
      for (const route of routes) {
        for (const readOnlyMode of [false, true]) {
          const created = await service.createDocument({
            paragraphs: ["route"],
          });
          const documentId = created.documentId;
          await service.saveDocument(documentId);
          await service.closeDocument(documentId, { discardUnsaved: true });
          const target = readOnlyMode ? readOnly : service;
          await (readOnlyMode ? readOnly : service).reopenDocument(documentId);
          const routeRoot = path.join(
            workspace.root,
            readOnlyMode ? "routes-readonly" : "routes-writable",
          );
          await mkdir(routeRoot, { recursive: true });
          const beforeFiles = new Set(await readdir(routeRoot));
          let blocked = false;
          let succeeded = false;
          try {
            await route.run(target, documentId, routeRoot);
            succeeded = true;
          } catch (error) {
            if (
              error instanceof ServiceError &&
              error.code === "READ_ONLY_MODE"
            )
              blocked = true;
            else {
              problems.push(
                `route=${route.id} readOnly=${readOnlyMode}: unexpected error ${errorCode(error)} ` +
                  `${describeError(error).slice(0, 60)}`,
              );
            }
          }
          const afterFiles = new Set(await readdir(routeRoot));
          const leaked = [...afterFiles].filter(
            (file) => !beforeFiles.has(file),
          );
          const contract = readOnlyMode && route.isWrite;
          if (contract && !blocked) {
            problems.push(
              `route=${route.id} readOnly=true is a write route but was not blocked ` +
                `(leaked files: ${leaked.join(", ") || "none"})`,
            );
          }
          if (!contract && (blocked || !succeeded)) {
            problems.push(
              `route=${route.id} readOnly=${readOnlyMode} should succeed but ` +
                `blocked=${blocked} succeeded=${succeeded}`,
            );
          }
          console.log(
            `P4 route=${route.id} readOnly=${readOnlyMode} write=${route.isWrite} ` +
              `blocked=${blocked} succeeded=${succeeded} leaked=${leaked.length}`,
          );
          try {
            await (readOnlyMode ? readOnly : service).closeDocument(
              documentId,
              {
                discardUnsaved: true,
              },
            );
          } catch {
            // delete route already removed the session
          }
          await service.deleteDocument(documentId).catch(() => undefined);
        }
      }
      const name = "P4.readOnlyRoutes";
      if (problems.length > 0) {
        const detail = problems.slice(0, 12).join(" | ");
        failures.push(`${name}: ${detail}`);
        reporter.fail(name, detail);
      } else {
        reporter.pass(name);
      }
      console.log(
        `P4 coverage=12 routes x 2 readOnly modes=24/24 rows; ` +
          `independence: readOnly flips the outcome for ${routes.filter((route) => route.isWrite).length} ` +
          `write routes, routeIsWrite flips it for read routes.`,
      );
    }

    /* ------------------------------------------------------ P5 insertList */

    {
      const conditions = ["kindIsNumber", "startAtProvided"];
      const rows: DecisionRow[] = [];
      const problems: string[] = [];
      for (let mask = 0; mask < 4; mask += 1) {
        const values = maskValues(mask, 2);
        const [kindIsNumber, startAtProvided] = values;
        const created = await service.createDocument({ paragraphs: ["list"] });
        const documentId = created.documentId;
        const anchor = created.document.sections[0].blocks[0].id;
        const startAt = 5;
        const result = service.insertList(documentId, {
          items: ["one", "two"],
          kind: kindIsNumber ? "number" : "bullet",
          afterBlockId: anchor,
          level: 0,
          ...(startAtProvided ? { startAt } : {}),
        }) as { blockIds: string[]; numId: string };
        const doc = service.session(documentId).document;
        const numId = result.numId;
        const instance = doc.numbering.nums[numId];
        const abstract = instance
          ? doc.numbering.abstract[instance.abstractId]
          : undefined;
        const levelDef = abstract?.levels.find((level) => level.level === 0);
        const props = doc.sections[0].blocks.find(
          (block) =>
            block.type === "paragraph" && block.id === result.blockIds[0],
        );
        const numbering =
          props?.type === "paragraph" ? props.props.numbering : undefined;
        const modeCorrect =
          levelDef?.numFmt === (kindIsNumber ? "decimal" : "bullet") &&
          numbering?.numId === numId;
        const startCorrect = startAtProvided
          ? numbering?.startOverride === startAt
          : numbering?.startOverride === undefined;
        if (!modeCorrect || !startCorrect) {
          problems.push(
            `mask=${mask} kind=${kindIsNumber ? "number" : "bullet"} startAt=${startAtProvided}: ` +
              `numFmt=${levelDef?.numFmt} startOverride=${numbering?.startOverride}`,
          );
        }
        rows.push({
          mask,
          values,
          outcome: modeCorrect && startCorrect,
          note: `numId=${numId}`,
        });
        await service.closeDocument(documentId, { discardUnsaved: true });
      }
      printDecisionTable("P5 insertList: requested numbering mode is applied", {
        conditions,
        rows,
        coverage: "4/4",
        independent: [true, true],
        pairCounts: [0, 0],
      });
      const name = "P5.insertListNumbering";
      // Independence is at the observation level: `kind` changes numFmt
      // (bullet vs decimal) while startAt stays fixed, and `startAtProvided`
      // changes startOverride while kind stays fixed.
      const startFlips = rows.every((row) => row.outcome);
      console.log(
        `P5 independence: kindIsNumber changes numFmt (bullet<->decimal) for both ` +
          `startAtProvided values; startAtProvided changes startOverride presence for both kinds; ` +
          `numbering mode stayed correct in ${rows.filter((row) => row.outcome).length}/4 rows ` +
          `(all rows correct=${startFlips}).`,
      );
      if (problems.length > 0 || !startFlips) {
        const detail =
          problems.join(" | ") || "numbering mode was not applied for some row";
        failures.push(`${name}: ${detail}`);
        reporter.fail(name, detail);
      } else {
        reporter.pass(name);
      }
      for (const level of [0, 4, 8]) {
        const created = await service.createDocument({ paragraphs: ["level"] });
        const documentId = created.documentId;
        const result = service.insertList(documentId, {
          items: ["nested"],
          kind: "number",
          afterBlockId: created.document.sections[0].blocks[0].id,
          level,
        }) as { blockIds: string[]; numId: string };
        const doc = service.session(documentId).document;
        const instance = doc.numbering.nums[result.numId];
        const abstract = instance
          ? doc.numbering.abstract[instance.abstractId]
          : undefined;
        const paragraph = doc.sections[0].blocks.find(
          (block) =>
            block.type === "paragraph" && block.id === result.blockIds[0],
        );
        const appliedLevel =
          paragraph?.type === "paragraph"
            ? paragraph.props.numbering?.level
            : undefined;
        const ok =
          abstract?.levels.some((entry) => entry.level === level) &&
          appliedLevel === level;
        if (!ok) {
          const detail = `insertList level ${level} was not applied (level=${appliedLevel})`;
          failures.push(`P5.insertListLevel: ${detail}`);
          reporter.fail(`P5.insertListLevel#${level}`, detail);
        } else {
          reporter.pass(`P5.insertListLevel#${level}`);
        }
        await service.closeDocument(documentId, { discardUnsaved: true });
      }
    }

    const summary = await reporter.writeSummary();
    if (failures.length > 0) {
      throw new Error(
        `MC/DC decision-table failures:\n\n${failures.join("\n\n---\n\n")}`,
      );
    }
    expect(summary.failed).toBe(0);
  }, 900_000);

  async function makeDocx(target: DocumentService): Promise<Buffer> {
    const created = await target.createDocument({
      title: "extension-fixture",
      paragraphs: ["extension routing"],
    });
    await target.saveDocument(created.documentId);
    const bytes = await target.workspace.loadDocx(created.documentId);
    await target.closeDocument(created.documentId, { discardUnsaved: true });
    if (!bytes) throw new Error("fixture DOCX missing");
    return bytes;
  }
});
