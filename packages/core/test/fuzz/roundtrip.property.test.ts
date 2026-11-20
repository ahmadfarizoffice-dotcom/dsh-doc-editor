/**
 * Deterministic round-trip fuzzing.
 *
 * For every generated document this suite checks four invariants:
 *  1. model -> DOCX -> model preserves normalised text, top-level block count and
 *     paragraph multiplicity (nothing duplicated, never silently lost),
 *  2. save -> JSON snapshot -> reopen yields an identical model hash,
 *  3. an op script of 1..30 mutations can be undone back to the starting hash and
 *     redone to the final hash,
 *  4. block/table/row/cell ids are unique and documentText() equals the block
 *     projection the engine promises.
 *
 * Divergences are only accepted when the importer reports the loss in its
 * compatibility report; anything else fails with the seed, the op script and the
 * first differing block.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentStats, documentText, importAny } from "../../src/dsh-entry.js";
import type { DocDocument } from "../../src/model/types.js";
import {
  FuzzReporter,
  Rng,
  applyContentPlan,
  applyOpDirect,
  buildContentPlan,
  caseSeed,
  collectedLosses,
  collectStructuralIds,
  createTempWorkspace,
  describeError,
  duplicateIds,
  duplicatedParagraphs,
  firstParagraphDifference,
  firstTextDifference,
  formatOpScript,
  isLossy,
  lostParagraphs,
  makeMutationOp,
  mergeLastTable,
  modelHash,
  orderedParagraphTexts,
  readFuzzConfig,
  reconstructedText,
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

interface CaseResult {
  failures: string[];
  documented: string[];
  ops: FuzzOp[];
}

function checkIdUniqueness(
  doc: DocDocument,
  label: string,
  failures: string[],
): void {
  const duplicates = duplicateIds(collectStructuralIds(doc));
  if (duplicates.length > 0) {
    failures.push(
      `${label}: duplicate structural ids: ${duplicates
        .map((entry) => `${entry.id}x${entry.count}`)
        .join(", ")}`,
    );
  }
}

async function runCase(
  workspace: TempWorkspace,
  index: number,
): Promise<CaseResult> {
  const failures: string[] = [];
  const documented: string[] = [];
  const seed = caseSeed(config.seed, index);
  const rng = new Rng(seed);
  const created = await workspace.service.createDocument({
    title: `fuzz-${index}`,
    paragraphs: seedParagraphs(rng, index),
  });
  const documentId = created.documentId;

  const content = applyContentPlan(
    workspace.service,
    documentId,
    rng,
    buildContentPlan(rng),
  );
  const ops: FuzzOp[] = [...content.ops];
  failures.push(...content.failures);
  if (rng.chance(0.7)) {
    const mergeOp = mergeLastTable(workspace.service, documentId, rng);
    if (mergeOp) {
      try {
        applyOpDirect(workspace.service, documentId, mergeOp);
        ops.push(mergeOp);
      } catch (error) {
        failures.push(`content merge op threw ${describeError(error)}`);
      }
    }
  }

  const beforeDoc = workspace.service.session(documentId).document;

  /* ------------------------------------------------------- model invariants */

  checkIdUniqueness(beforeDoc, "generated model", failures);
  const engineText = normalizeText(documentText(beforeDoc));
  const projectedText = normalizeText(reconstructedText(beforeDoc));
  if (engineText !== projectedText) {
    const difference = firstTextDifference(engineText, projectedText);
    failures.push(
      `documentText() does not equal the block projection at offset ${difference?.index}: ` +
        `engine=${JSON.stringify(difference?.before)} projection=${JSON.stringify(difference?.after)}`,
    );
  }
  const beforeParagraphs = orderedParagraphTexts(beforeDoc);
  const beforeStats = documentStats(beforeDoc);
  const beforeBlocks = topLevelBlockCount(beforeDoc);

  /* ----------------------------------------------------------- DOCX reimport */

  await workspace.service.saveDocument(documentId);
  const docx = await workspace.service.workspace.loadDocx(documentId);
  if (!docx) {
    failures.push("saved workspace is missing document.docx");
  } else {
    try {
      const imported = await importAny(docx, `${documentId}.docx`);
      const afterDoc = imported.document;
      const afterText = normalizeText(documentText(afterDoc));
      const afterParagraphs = orderedParagraphTexts(afterDoc);
      const afterBlocks = topLevelBlockCount(afterDoc);
      const losses = collectedLosses(imported, afterDoc);
      const reportedLoss = isLossy(losses);
      const lossDetail = losses
        .map((loss) => `${loss.feature}:${loss.level}`)
        .join(", ");

      const textDiffers = afterText !== engineText;
      const blocksDiffer = afterBlocks !== beforeBlocks;
      const duplicated = duplicatedParagraphs(
        beforeParagraphs,
        afterParagraphs,
      );
      const lost = lostParagraphs(beforeParagraphs, afterParagraphs);
      const paragraphDiff = firstParagraphDifference(
        beforeParagraphs,
        afterParagraphs,
      );

      if (duplicated.length > 0) {
        failures.push(
          `DOCX round-trip duplicated ${duplicated.length} paragraph text(s) ` +
            `(first: ${JSON.stringify(duplicated[0])}); reported losses: ${lossDetail || "none"}`,
        );
      }
      const divergent = textDiffers || blocksDiffer || lost.length > 0;
      if (divergent && !reportedLoss) {
        const textDifference = firstTextDifference(engineText, afterText);
        const blockDetail = paragraphDiff
          ? `first differing paragraph[${paragraphDiff.index}] ${paragraphDiff.kind}: ` +
            `before=${JSON.stringify(paragraphDiff.before)} after=${JSON.stringify(paragraphDiff.after)}`
          : "no paragraph-level difference";
        failures.push(
          `DOCX round-trip divergence without a reported loss: text=${textDiffers} ` +
            `(offset ${textDifference?.index ?? "n/a"} before=${JSON.stringify(
              textDifference?.before,
            )} after=${JSON.stringify(textDifference?.after)}), ` +
            `blocks ${beforeBlocks}->${afterBlocks}, lost=${lost.length}, ` +
            `paragraphs ${beforeParagraphs.length}->${afterParagraphs.length}; ${blockDetail}`,
        );
      } else if (divergent && reportedLoss) {
        const difference = firstParagraphDifference(
          beforeParagraphs,
          afterParagraphs,
        );
        documented.push(
          `DOCX round-trip divergence accepted as documented loss (${lossDetail}): ` +
            `text=${textDiffers}, blocks ${beforeBlocks}->${afterBlocks}, ` +
            `lost=${lost.length}, firstDiff=${JSON.stringify(difference)}`,
        );
        console.log(
          `FUZZ_DOCUMENTED seed=${seed} case=#${index} losses=${lossDetail} ` +
            `firstDiff=${JSON.stringify(difference)}`,
        );
      }

      const afterStats = documentStats(afterDoc);
      if (!reportedLoss && afterStats.words !== beforeStats.words) {
        failures.push(
          `DOCX round-trip changed word stats without a reported loss: ` +
            `${beforeStats.words}->${afterStats.words}`,
        );
      }

      checkIdUniqueness(afterDoc, "reimported model", failures);
    } catch (error) {
      failures.push(`DOCX reimport threw ${describeError(error)}`);
    }
  }

  /* ------------------------------------------------------- JSON snapshot hash */

  const hashBeforeSave = modelHash(beforeDoc);
  await workspace.service.closeDocument(documentId, { discardUnsaved: true });
  const reopened = await workspace.service.reopenDocument(documentId);
  const hashReopened = modelHash(reopened.document);
  if (hashBeforeSave !== hashReopened) {
    const difference = firstTextDifference(
      engineText,
      normalizeText(documentText(reopened.document)),
    );
    const paragraphDiff = firstParagraphDifference(
      beforeParagraphs,
      orderedParagraphTexts(reopened.document),
    );
    failures.push(
      `JSON snapshot round-trip changed the model hash: ${hashBeforeSave} -> ${hashReopened}; ` +
        `text offset ${difference?.index ?? "n/a"}; paragraph=${JSON.stringify(paragraphDiff)}`,
    );
  }

  /* --------------------------------------------------------------- undo/redo */

  const undoBaseHash = modelHash(
    workspace.service.session(documentId).document,
  );
  const scriptLength = rng.int(1, 30);
  const applied: FuzzOp[] = [];
  for (let step = 0; step < scriptLength; step += 1) {
    const current = workspace.service.session(documentId).document;
    const op = makeMutationOp(rng, current);
    if (!op) break;
    try {
      applyOpDirect(workspace.service, documentId, op);
      applied.push(op);
    } catch (error) {
      failures.push(
        `op ${applied.length + 1} ${op.name} ${JSON.stringify(op.args)} threw ${describeError(error)}`,
      );
    }
  }
  const finalDoc = workspace.service.session(documentId).document;
  const afterOpsHash = modelHash(finalDoc);

  let undoCount = 0;
  for (; undoCount < applied.length; undoCount += 1) {
    try {
      workspace.service.undo(documentId);
    } catch (error) {
      failures.push(
        `undo ${undoCount + 1}/${applied.length} threw ${describeError(error)}`,
      );
      break;
    }
  }
  const undoneDoc = workspace.service.session(documentId).document;
  if (modelHash(undoneDoc) !== undoBaseHash) {
    failures.push(
      `undo did not restore the initial model hash after ${undoCount} undos: ` +
        `${undoBaseHash} -> ${modelHash(undoneDoc)}; first diff=` +
        `${JSON.stringify(
          firstParagraphDifference(
            orderedParagraphTexts(undoneDoc),
            beforeParagraphs,
          ),
        )}`,
    );
  }

  let redoCount = 0;
  for (; redoCount < applied.length; redoCount += 1) {
    try {
      workspace.service.redo(documentId);
    } catch (error) {
      failures.push(
        `redo ${redoCount + 1}/${applied.length} threw ${describeError(error)}`,
      );
      break;
    }
  }
  const redoneDoc = workspace.service.session(documentId).document;
  if (modelHash(redoneDoc) !== afterOpsHash) {
    failures.push(
      `redo did not restore the final model hash after ${redoCount} redos: ` +
        `${afterOpsHash} -> ${modelHash(redoneDoc)}; first diff=` +
        `${JSON.stringify(
          firstParagraphDifference(
            orderedParagraphTexts(redoneDoc),
            orderedParagraphTexts(finalDoc),
          ),
        )}`,
    );
  }

  await workspace.service.closeDocument(documentId, { discardUnsaved: true });
  if (ops.length === 0) failures.push("content plan generated no operations");

  return { failures, documented, ops };
}

describe(`round-trip property fuzz (seed ${config.seed}, ${config.cases} documents)`, () => {
  let workspace: TempWorkspace;

  beforeAll(async () => {
    workspace = await createTempWorkspace("dsh-fuzz-roundtrip-");
  });

  afterAll(async () => {
    await workspace.dispose();
  });

  it(
    "preserves text/structure, JSON snapshots, undo/redo and id uniqueness",
    async () => {
      const reporter = new FuzzReporter("roundtrip");
      const failures: string[] = [];
      let documentedCount = 0;

      for (let index = 0; index < config.cases; index += 1) {
        const seed = caseSeed(config.seed, index);
        try {
          const result = await runCase(workspace, index);
          documentedCount += result.documented.length;
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
          `round-trip property failures (seed ${config.seed}):\n\n${failures
            .slice(0, 10)
            .join(
              "\n\n---\n\n",
            )}\n\n... ${Math.max(0, failures.length - 10)} more failure(s)`,
        );
      }
      expect(summary.failed).toBe(0);
      expect(documentedCount).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT,
  );
});
