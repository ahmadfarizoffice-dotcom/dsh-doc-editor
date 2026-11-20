/**
 * Differential suite, "SQL logic test" style.
 *
 * Each generated op script is executed twice on two fresh, identical documents:
 *   path A: direct DocumentService method calls (the engine API),
 *   path B: invokeTool(service, name, args) (the MCP tool layer).
 * Final text, top-level block count, documentStats() and the ordered paragraph
 * list must be identical.
 *
 * The same documents are then converted through DOCX -> ODT -> DOCX and
 * DOCX -> HTML -> DOCX and compared with a single DOCX pass. Format conversions
 * may legitimately lose constructs, but only when the adapter/compatibility
 * report lists that loss; everything else is an unexplained divergence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  documentStats,
  documentText,
  exportAny,
  importAny,
} from "../../src/dsh-entry.js";
import type { DocDocument } from "../../src/model/types.js";
import {
  FuzzReporter,
  Rng,
  applyOpDirect,
  applyOpViaTool,
  caseSeed,
  createTempWorkspace,
  describeError,
  firstParagraphDifference,
  firstTextDifference,
  formatOpScript,
  makeMutationOp,
  orderedParagraphTexts,
  readFuzzConfig,
  seedParagraphs,
  topLevelBlockCount,
  type FuzzOp,
  type TempWorkspace,
} from "./support.js";

const config = readFuzzConfig({ seed: 1337, cases: 150 });
const TEST_TIMEOUT = 900_000;

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

interface Comparison {
  textDifferent: boolean;
  blocksDifferent: boolean;
  sectionsDifferent: boolean;
  paragraphsDifferent: boolean;
  statsDifferent: boolean;
  detail: string;
}

function compareModels(before: DocDocument, after: DocDocument): Comparison {
  const beforeText = normalizeText(documentText(before));
  const afterText = normalizeText(documentText(after));
  const beforeParagraphs = orderedParagraphTexts(before);
  const afterParagraphs = orderedParagraphTexts(after);
  const beforeStats = documentStats(before);
  const afterStats = documentStats(after);
  const textDifference = firstTextDifference(beforeText, afterText);
  const paragraphDifference = firstParagraphDifference(
    beforeParagraphs,
    afterParagraphs,
  );
  const textDifferent = textDifference !== undefined;
  const blocksDifferent =
    topLevelBlockCount(before) !== topLevelBlockCount(after);
  const sectionsDifferent = before.sections.length !== after.sections.length;
  const paragraphsDifferent = paragraphDifference !== undefined;
  const statsDifferent =
    beforeStats.words !== afterStats.words ||
    beforeStats.characters !== afterStats.characters ||
    beforeStats.paragraphs !== afterStats.paragraphs;
  return {
    textDifferent,
    blocksDifferent,
    sectionsDifferent,
    paragraphsDifferent,
    statsDifferent,
    detail:
      `text=${textDifferent}` +
      (textDifference
        ? ` (offset ${textDifference.index} before=${JSON.stringify(
            textDifference.before,
          )} after=${JSON.stringify(textDifference.after)})`
        : "") +
      `, blocks=${topLevelBlockCount(before)}->${topLevelBlockCount(after)}` +
      `, sections=${before.sections.length}->${after.sections.length}` +
      `, paragraphs ${beforeParagraphs.length}->${afterParagraphs.length}` +
      (paragraphDifference
        ? `, firstDiff=${JSON.stringify(paragraphDifference)}`
        : "") +
      `, stats=${JSON.stringify(beforeStats)}->${JSON.stringify(afterStats)}`,
  };
}

function isDivergent(comparison: Comparison): boolean {
  return (
    comparison.textDifferent ||
    comparison.blocksDifferent ||
    comparison.sectionsDifferent ||
    comparison.paragraphsDifferent ||
    comparison.statsDifferent
  );
}

/** Maps a loss feature string to the op that would make it expected. */
const LOSS_FEATURE_OPS: Array<[RegExp, FuzzOp["name"][]]> = [
  [/toc|table of contents/i, ["document_insert_toc"]],
  [/hyperlink|link/i, ["document_insert_hyperlink"]],
  [
    /footnote|endnote|note/i,
    ["document_insert_footnote", "document_add_comment"],
  ],
  [/comment/i, ["document_add_comment"]],
  [/table|cell|row/i, ["document_insert_table", "document_edit_table"]],
  [/header/i, ["document_edit_header"]],
  [/footer/i, ["document_edit_footer"]],
  [
    /section|page/i,
    ["document_insert_section_break", "document_insert_page_break"],
  ],
  [/list|numbering|number/i, ["document_insert_list"]],
  [
    /style|format|run|paragraph|css/i,
    [
      "document_apply_style",
      "document_format_text",
      "document_format_paragraph",
    ],
  ],
  [/metadata/i, ["document_set_metadata"]],
];

const FEATURE_TO_PROBE: Array<[RegExp, string[]]> = [
  [/toc|table of contents/i, ["toc"]],
  [/hyperlink|link/i, ["hyperlink"]],
  [/footnote|endnote|note/i, ["note"]],
  [/comment/i, ["comment"]],
  [/table|cell|row/i, ["table"]],
  [/header/i, ["header"]],
  [/footer/i, ["footer"]],
  [/section|page/i, ["section", "pagebreak"]],
  [/list|numbering|number/i, ["list"]],
  [/tab/i, ["tab"]],
  [/style|format|run|paragraph|css/i, ["format", "tab", "break", "whitespace"]],
  [/metadata/i, ["metadata"]],
];

interface ParagraphRecord {
  text: string;
  inlineTypes: string[];
  inTable: boolean;
  inNote: boolean;
}

/** Paragraphs in the same order as orderedParagraphTexts, with structural flags. */
function paragraphRecords(doc: DocDocument): ParagraphRecord[] {
  const out: ParagraphRecord[] = [];
  const record = (
    block: DocDocument["sections"][number]["blocks"][number],
    inTable: boolean,
    inNote: boolean,
  ): void => {
    if (block.type === "paragraph") {
      out.push({
        text: orderedParagraphTextsOfBlock(block),
        inlineTypes: block.inlines.map((inline) => inline.type),
        inTable,
        inNote,
      });
    }
  };
  const walk = (
    blocks: DocDocument["sections"][number]["blocks"],
    inTable: boolean,
  ): void => {
    for (const block of blocks) {
      if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) walk(cell.blocks, true);
        }
      } else {
        record(block, inTable, false);
      }
    }
  };
  for (const section of doc.sections) walk(section.blocks, false);
  for (const shape of doc.shapes) {
    if (shape.kind === "textbox") walk(shape.blocks, false);
  }
  for (const note of [...doc.footnotes, ...doc.endnotes])
    walk(note.blocks, false);
  return out;
}

function orderedParagraphTextsOfBlock(
  block: DocDocument["sections"][number]["blocks"][number],
): string {
  if (block.type !== "paragraph") return "";
  return block.inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
          return inline.text;
        case "tab":
          return "\t";
        case "break":
          return inline.kind === "page" ? "\f" : "\n";
        case "image":
          return "\uFFFC";
        case "field":
          return inline.result
            ? inline.result
                .map((child) => (child.type === "text" ? child.text : "\uFFFC"))
                .join("")
            : "";
        case "math":
          return inline.linear;
        case "unknown":
          return inline.text ?? "";
        default:
          return "";
      }
    })
    .join("");
}

/** Structural tokens that actually describe where the two models diverge. */
function divergenceProbes(
  single: DocDocument,
  chained: DocDocument,
): Set<string> {
  const probes = new Set<string>();
  const before = paragraphRecords(single);
  const after = paragraphRecords(chained);
  const beforeTexts = before.map((record) => record.text);
  const afterTexts = after.map((record) => record.text);
  const paragraphDifference = firstParagraphDifference(beforeTexts, afterTexts);
  if (paragraphDifference) {
    const beforeRecord = before[paragraphDifference.index];
    const afterRecord = after[paragraphDifference.index];
    const types = new Set([
      ...(beforeRecord?.inlineTypes ?? []),
      ...(afterRecord?.inlineTypes ?? []),
    ]);
    if (types.has("tab")) probes.add("tab");
    if (types.has("break")) probes.add("break");
    if (types.has("noteRef")) probes.add("note");
    if (types.has("hyperlink")) probes.add("hyperlink");
    if (types.has("field")) probes.add("field");
    if (types.has("math")) probes.add("math");
    if (types.has("image")) probes.add("image");
    if (beforeRecord?.inTable || afterRecord?.inTable) probes.add("table");
    if (beforeRecord?.inNote || afterRecord?.inNote) probes.add("note");
    if (
      (beforeRecord?.text ?? "") === "" ||
      (afterRecord?.text ?? "") === "" ||
      paragraphDifference.kind !== "changed"
    ) {
      probes.add("structure");
    }
    if (paragraphDifference.kind === "changed" && !types.size) {
      probes.add("whitespace");
    }
  }

  const typeSequence = (doc: DocDocument): string[] => {
    const out: string[] = [];
    const walk = (blocks: DocDocument["sections"][number]["blocks"]): void => {
      for (const block of blocks) {
        out.push(block.type);
        if (block.type === "table") {
          out.push("cell");
          for (const row of block.rows) {
            for (const cell of row.cells) walk(cell.blocks);
          }
        }
      }
    };
    for (const section of doc.sections) walk(section.blocks);
    return out;
  };
  const beforeTypes = typeSequence(single);
  const afterTypes = typeSequence(chained);
  const limit = Math.min(beforeTypes.length, afterTypes.length);
  for (let index = 0; index < limit; index += 1) {
    if (beforeTypes[index] === afterTypes[index]) continue;
    for (const type of [beforeTypes[index], afterTypes[index]]) {
      if (type === "toc") probes.add("toc");
      if (type === "table" || type === "cell") probes.add("table");
    }
    break;
  }
  if (beforeTypes.includes("toc") || afterTypes.includes("toc"))
    probes.add("toc");
  if (single.sections.length !== chained.sections.length) probes.add("section");
  if (
    single.footnotes.length + single.endnotes.length !==
    chained.footnotes.length + chained.endnotes.length
  ) {
    probes.add("note");
  }
  if (single.comments.length !== chained.comments.length) probes.add("comment");
  if (single.shapes.length !== chained.shapes.length) probes.add("shape");
  return probes;
}

function explainLosses(
  losses: Array<{ feature: string; level: string; preserved?: boolean }>,
  usedOps: Set<FuzzOp["name"]>,
  probes: Set<string>,
): { documented: boolean; explanation: string } {
  const lossy = losses.filter(
    (loss) => loss.level !== "full" || loss.preserved === false,
  );
  if (lossy.length === 0) {
    return { documented: false, explanation: "no lossy entries were reported" };
  }
  if (probes.size === 0) {
    return {
      documented: false,
      explanation: "the divergence has no structural probe",
    };
  }
  const unmatchedProbes = new Set(probes);
  const matched: Array<{ feature: string; level: string; token: string }> = [];
  for (const loss of lossy) {
    for (const [pattern, tokens] of FEATURE_TO_PROBE) {
      if (!pattern.test(loss.feature)) continue;
      for (const token of tokens) {
        if (!probes.has(token) || !unmatchedProbes.has(token)) continue;
        matched.push({ feature: loss.feature, level: loss.level, token });
        unmatchedProbes.delete(token);
      }
    }
  }
  const matchedCausedByUsedOp = matched.some((entry) =>
    LOSS_FEATURE_OPS.some(
      ([pattern, ops]) =>
        pattern.test(entry.feature) && ops.some((op) => usedOps.has(op)),
    ),
  );
  if (
    unmatchedProbes.size === 0 &&
    matched.length > 0 &&
    matchedCausedByUsedOp
  ) {
    return {
      documented: true,
      explanation:
        `every divergence probe [${[...probes].join(", ")}] is explained by a reported loss ` +
        `[${matched.map((entry) => `${entry.feature}:${entry.level}~${entry.token}`).join(", ")}]`,
    };
  }
  return {
    documented: false,
    explanation:
      `reported losses [${lossy.map((loss) => `${loss.feature}:${loss.level}`).join(", ")}] ` +
      `leave divergence probes [${[...unmatchedProbes].join(", ") || "none"}] unexplained`,
  };
}

interface ChainResult {
  single: DocDocument;
  chained: DocDocument;
  losses: Array<{ feature: string; level: string; preserved?: boolean }>;
}

async function runChain(
  document: DocDocument,
  middleFormat: "odt" | "html",
): Promise<ChainResult> {
  const losses: Array<{ feature: string; level: string; preserved?: boolean }> =
    [];
  const docx = await exportAny(document, "docx");
  losses.push(...docx.losses);
  const imported = await importAny(docx.buffer, "single-pass.docx");
  losses.push(...imported.losses);
  const single = imported.document;
  losses.push(...(single.compatibility?.losses ?? []));

  const middle = await exportAny(single, middleFormat);
  losses.push(...middle.losses);
  const middleImported = await importAny(
    middle.buffer,
    `middle.${middleFormat}`,
  );
  losses.push(...middleImported.losses);
  losses.push(...(middleImported.document.compatibility?.losses ?? []));

  const docxAgain = await exportAny(middleImported.document, "docx");
  losses.push(...docxAgain.losses);
  const final = await importAny(docxAgain.buffer, "chained.docx");
  losses.push(...final.losses);
  losses.push(...(final.document.compatibility?.losses ?? []));

  return { single, chained: final.document, losses };
}

async function runCase(
  pathA: TempWorkspace,
  pathB: TempWorkspace,
  index: number,
): Promise<{ failures: string[]; documented: string[]; ops: FuzzOp[] }> {
  const failures: string[] = [];
  const documented: string[] = [];
  const seed = caseSeed(config.seed, index);
  const rng = new Rng(seed);
  const paragraphs = seedParagraphs(rng, index);

  const createdA = await pathA.service.createDocument({
    title: `differential-${index}`,
    paragraphs,
  });
  const createdB = await pathB.service.createDocument({
    title: `differential-${index}`,
    paragraphs,
  });
  const idA = createdA.documentId;
  const idB = createdB.documentId;

  const scriptLength = rng.int(1, 30);
  const ops: FuzzOp[] = [];
  const usedOps = new Set<FuzzOp["name"]>();
  for (let step = 0; step < scriptLength; step += 1) {
    const docA = pathA.service.session(idA).document;
    const op = makeMutationOp(rng, docA, { toolBackedOnly: true });
    if (!op) break;
    try {
      applyOpDirect(pathA.service, idA, op);
    } catch (error) {
      failures.push(
        `path A op ${step + 1} ${op.name} ${JSON.stringify(op.args)} threw ${describeError(error)}`,
      );
      break;
    }
    const toolResult = await applyOpViaTool(pathB.service, idB, op);
    if (!toolResult.ok) {
      failures.push(
        `path B op ${step + 1} ${op.name} ${JSON.stringify(op.args)} failed: ${JSON.stringify(
          toolResult.error,
        )}`,
      );
      break;
    }
    ops.push(op);
    usedOps.add(op.name);
    const comparison = compareModels(
      pathA.service.session(idA).document,
      pathB.service.session(idB).document,
    );
    if (isDivergent(comparison)) {
      failures.push(
        `direct service and invokeTool diverge at op ${step + 1} ${op.name} ` +
          `${JSON.stringify(op.args)}: ${comparison.detail}`,
      );
      break;
    }
  }

  const finalA = pathA.service.session(idA).document;
  const finalB = pathB.service.session(idB).document;
  const finalComparison = compareModels(finalA, finalB);
  if (isDivergent(finalComparison)) {
    failures.push(
      `final documents diverge between the direct service and the tool layer: ` +
        `${finalComparison.detail}`,
    );
  }

  const script = formatOpScript(ops);

  /* ------------------------------------------------- conversion chain checks */

  for (const middle of ["odt", "html"] as const) {
    try {
      const chain = await runChain(finalA, middle);
      const comparison = compareModels(chain.single, chain.chained);
      if (!isDivergent(comparison)) continue;
      const probes = divergenceProbes(chain.single, chain.chained);
      const explanation = explainLosses(chain.losses, usedOps, probes);
      if (explanation.documented) {
        documented.push(
          `DOCX->${middle.toUpperCase()}->DOCX divergence accepted as documented loss: ` +
            `${comparison.detail}; ${explanation.explanation}`,
        );
        console.log(
          `FUZZ_DOCUMENTED seed=${seed} case=#${index} chain=${middle} ` +
            `${explanation.explanation} detail=${comparison.detail}`,
        );
      } else {
        failures.push(
          `DOCX->${middle.toUpperCase()}->DOCX divergence is unexplained: ` +
            `${comparison.detail}; probes=[${[...probes].join(", ")}]; ` +
            `${explanation.explanation}\nop script:\n${script}`,
        );
      }
    } catch (error) {
      failures.push(
        `DOCX->${middle.toUpperCase()}->DOCX chain threw ${describeError(error)}\nop script:\n${script}`,
      );
    }
  }

  await pathA.service.closeDocument(idA, { discardUnsaved: true });
  await pathB.service.closeDocument(idB, { discardUnsaved: true });

  return { failures, documented, ops };
}

describe(`differential fuzz (seed ${config.seed}, ${config.cases} op scripts)`, () => {
  let pathA: TempWorkspace;
  let pathB: TempWorkspace;

  beforeAll(async () => {
    pathA = await createTempWorkspace("dsh-fuzz-diff-a-");
    pathB = await createTempWorkspace("dsh-fuzz-diff-b-");
  });

  afterAll(async () => {
    await pathA.dispose();
    await pathB.dispose();
  });

  it(
    "service methods and the tool layer agree; conversions only lose what they report",
    async () => {
      const reporter = new FuzzReporter("differential");
      const failures: string[] = [];
      let documentedCount = 0;

      for (let index = 0; index < config.cases; index += 1) {
        const seed = caseSeed(config.seed, index);
        try {
          const result = await runCase(pathA, pathB, index);
          documentedCount += result.documented.length;
          // Ensure the services keep no open session across cases (leak guard).
          if (
            pathA.service.sessions_().length !== 0 ||
            pathB.service.sessions_().length !== 0
          ) {
            result.failures.push(
              `session leak after case: A=${pathA.service.sessions_().length} ` +
                `B=${pathB.service.sessions_().length}`,
            );
          }
          if (result.failures.length === 0) {
            if (result.documented.length > 0) {
              reporter.document(`case#${index}`, result.documented.join("\n"));
            } else {
              reporter.pass(`case#${index}`);
            }
            continue;
          }
          const detail =
            `seed=${seed} case=#${index}\nop script:\n${formatOpScript(result.ops)}\n` +
            result.failures.join("\n");
          failures.push(detail);
          reporter.fail(`case#${index}`, detail);
        } catch (error) {
          const detail = `seed=${seed} case=#${index}\n${describeError(error)}\n${
            (error as Error).stack ?? ""
          }`;
          failures.push(detail);
          reporter.fail(`case#${index}`, detail);
        }
      }

      const summary = await reporter.writeSummary();
      expect(summary.cases).toBe(config.cases);
      if (failures.length > 0) {
        throw new Error(
          `differential failures (seed ${config.seed}):\n\n${failures
            .slice(0, 8)
            .join(
              "\n\n---\n\n",
            )}\n\n... ${Math.max(0, failures.length - 8)} more failure(s)`,
        );
      }
      expect(summary.failed).toBe(0);
      expect(documentedCount).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT,
  );
});
