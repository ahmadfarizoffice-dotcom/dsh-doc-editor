import { listParagraphs } from "./access.js";
import { paragraphText } from "./text.js";
import type { DocDocument } from "./types.js";

export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface ParagraphChange {
  kind: ChangeKind;
  /** Left-hand paragraph id (undefined when added). */
  leftBlockId?: string;
  /** Right-hand paragraph id (undefined when removed). */
  rightBlockId?: string;
  leftText?: string;
  rightText?: string;
  leftStyle?: string;
  rightStyle?: string;
  /** Word level diff for changed paragraphs. */
  wordDiff?: WordDiffPart[];
}

export interface WordDiffPart {
  kind: "equal" | "insert" | "delete";
  text: string;
}

export interface DocumentComparison {
  left: { paragraphs: number; words: number };
  right: { paragraphs: number; words: number };
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    similarity: number;
  };
  changes: ParagraphChange[];
  metadataChanges: Array<{ field: string; left?: string; right?: string }>;
  styleChanges: Array<{ style: string; leftCount: number; rightCount: number }>;
}

interface Row {
  blockId: string;
  text: string;
  style?: string;
}

function rowsOf(doc: DocDocument): Row[] {
  return listParagraphs(doc).map(({ paragraph }) => ({
    blockId: paragraph.id,
    text: paragraphText(paragraph, "final"),
    style: paragraph.style,
  }));
}

/** Word level diff using longest-common-subsequence over tokens. */
export function diffWords(left: string, right: string): WordDiffPart[] {
  const tokenize = (value: string) =>
    value.split(/(\s+)/).filter((part) => part.length > 0);
  const a = tokenize(left);
  const b = tokenize(right);
  const n = a.length;
  const m = b.length;

  if (n * m > 4_000_000) {
    // Guard against pathological inputs: fall back to whole-string replacement.
    return [
      ...(left ? [{ kind: "delete" as const, text: left }] : []),
      ...(right ? [{ kind: "insert" as const, text: right }] : []),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: WordDiffPart[] = [];
  const push = (kind: WordDiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", a[i]);
      i += 1;
    } else {
      push("insert", b[j]);
      j += 1;
    }
  }
  while (i < n) {
    push("delete", a[i]);
    i += 1;
  }
  while (j < m) {
    push("insert", b[j]);
    j += 1;
  }
  return parts;
}

/** Paragraph level LCS diff between two documents. */
export function compareDocuments(
  left: DocDocument,
  right: DocDocument,
): DocumentComparison {
  const leftRows = rowsOf(left);
  const rightRows = rowsOf(right);
  const n = leftRows.length;
  const m = rightRows.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        leftRows[i].text === rightRows[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const changes: ParagraphChange[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  while (i < n && j < m) {
    if (
      leftRows[i].text === rightRows[j].text &&
      leftRows[i].style === rightRows[j].style
    ) {
      changes.push({
        kind: "unchanged",
        leftBlockId: leftRows[i].blockId,
        rightBlockId: rightRows[j].blockId,
        leftText: leftRows[i].text,
        rightText: rightRows[j].text,
        leftStyle: leftRows[i].style,
        rightStyle: rightRows[j].style,
      });
      unchanged += 1;
      i += 1;
      j += 1;
      continue;
    }
    // Prefer pairing as "changed" when both sides exist and the next LCS step
    // does not improve; this keeps the report readable for edited paragraphs.
    const skipLeft = dp[i + 1][j];
    const skipRight = dp[i][j + 1];
    if (skipLeft > skipRight) {
      changes.push({
        kind: "removed",
        leftBlockId: leftRows[i].blockId,
        leftText: leftRows[i].text,
        leftStyle: leftRows[i].style,
      });
      removed += 1;
      i += 1;
    } else if (skipRight > skipLeft) {
      changes.push({
        kind: "added",
        rightBlockId: rightRows[j].blockId,
        rightText: rightRows[j].text,
        rightStyle: rightRows[j].style,
      });
      added += 1;
      j += 1;
    } else {
      changes.push({
        kind: "changed",
        leftBlockId: leftRows[i].blockId,
        rightBlockId: rightRows[j].blockId,
        leftText: leftRows[i].text,
        rightText: rightRows[j].text,
        leftStyle: leftRows[i].style,
        rightStyle: rightRows[j].style,
        wordDiff: diffWords(leftRows[i].text, rightRows[j].text),
      });
      changed += 1;
      i += 1;
      j += 1;
    }
  }
  while (i < n) {
    changes.push({
      kind: "removed",
      leftBlockId: leftRows[i].blockId,
      leftText: leftRows[i].text,
      leftStyle: leftRows[i].style,
    });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    changes.push({
      kind: "added",
      rightBlockId: rightRows[j].blockId,
      rightText: rightRows[j].text,
      rightStyle: rightRows[j].style,
    });
    added += 1;
    j += 1;
  }

  const total = Math.max(1, n + m);
  const similarity = unchanged / Math.max(1, Math.min(n, m) || 1);

  const metadataChanges: DocumentComparison["metadataChanges"] = [];
  const metadataFields: Array<keyof DocDocument["metadata"]> = [
    "title",
    "subject",
    "creator",
    "lastModifiedBy",
    "description",
    "category",
  ];
  for (const field of metadataFields) {
    const leftValue = left.metadata[field];
    const rightValue = right.metadata[field];
    if ((leftValue ?? "") !== (rightValue ?? "")) {
      metadataChanges.push({
        field: String(field),
        left: leftValue === undefined ? undefined : String(leftValue),
        right: rightValue === undefined ? undefined : String(rightValue),
      });
    }
  }

  const styleCounts = new Map<
    string,
    { leftCount: number; rightCount: number }
  >();
  for (const row of leftRows) {
    const key = row.style ?? "Normal";
    const entry = styleCounts.get(key) ?? { leftCount: 0, rightCount: 0 };
    entry.leftCount += 1;
    styleCounts.set(key, entry);
  }
  for (const row of rightRows) {
    const key = row.style ?? "Normal";
    const entry = styleCounts.get(key) ?? { leftCount: 0, rightCount: 0 };
    entry.rightCount += 1;
    styleCounts.set(key, entry);
  }
  const styleChanges = [...styleCounts.entries()]
    .filter(([, entry]) => entry.leftCount !== entry.rightCount)
    .map(([style, entry]) => ({ style, ...entry }));

  return {
    left: {
      paragraphs: n,
      words: countWords(leftRows.map((row) => row.text).join(" ")),
    },
    right: {
      paragraphs: m,
      words: countWords(rightRows.map((row) => row.text).join(" ")),
    },
    summary: {
      added,
      removed,
      changed,
      unchanged,
      similarity: Number(((unchanged * 2) / total).toFixed(4)),
    },
    changes,
    metadataChanges,
    styleChanges,
  };
}

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}\p{M}]+/gu);
  return matches ? matches.length : 0;
}

/** Markdown rendering of a comparison report (used by docs and MCP resources). */
export function comparisonToMarkdown(report: DocumentComparison): string {
  const lines: string[] = ["# Document comparison", ""];
  lines.push(
    `- Paragraphs: ${report.left.paragraphs} → ${report.right.paragraphs}`,
  );
  lines.push(`- Words: ${report.left.words} → ${report.right.words}`);
  lines.push(
    `- Added ${report.summary.added}, removed ${report.summary.removed}, changed ${report.summary.changed}, unchanged ${report.summary.unchanged}`,
  );
  lines.push(
    `- Similarity ${(report.summary.similarity * 100).toFixed(1)}%`,
    "",
  );
  for (const change of report.changes) {
    if (change.kind === "unchanged") continue;
    if (change.kind === "added") lines.push(`+ ${change.rightText ?? ""}`);
    else if (change.kind === "removed")
      lines.push(`- ${change.leftText ?? ""}`);
    else {
      const diff = (change.wordDiff ?? [])
        .map((part) =>
          part.kind === "equal"
            ? part.text
            : part.kind === "insert"
              ? `**${part.text}**`
              : `~~${part.text}~~`,
        )
        .join("");
      lines.push(`~ ${diff}`);
    }
  }
  if (report.metadataChanges.length > 0) {
    lines.push("", "## Metadata changes");
    for (const change of report.metadataChanges) {
      lines.push(
        `- ${change.field}: ${change.left ?? "(none)"} → ${change.right ?? "(none)"}`,
      );
    }
  }
  return lines.join("\n");
}
