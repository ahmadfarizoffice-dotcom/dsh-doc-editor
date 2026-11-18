import { listParagraphs } from "./access.js";
import { getNumberingLevel, resolveParagraphProps } from "./styles.js";
import type {
  DocDocument,
  ListLevel,
  NumberingRef,
  Paragraph,
} from "./types.js";

export interface ListLabel {
  paragraphId: string;
  numId: string;
  level: number;
  label: string;
  /** Suffix separator between label and text. */
  suffix: "tab" | "space" | "nothing";
  /** Left indentation and hanging indent resolved for the level. */
  indent: { left: number; hanging: number };
  /** True when the label was formatted as a bullet. */
  bullet: boolean;
}

function toRoman(value: number, upper: boolean): string {
  if (value <= 0 || value > 3999) return String(value);
  const table: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let remaining = value;
  let out = "";
  for (const [amount, glyph] of table) {
    while (remaining >= amount) {
      out += glyph;
      remaining -= amount;
    }
  }
  return upper ? out.toUpperCase() : out;
}

function toLetters(value: number, upper: boolean): string {
  if (value <= 0) return String(value);
  let n = value;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

/** Formats a counter value using an OOXML number format. */
export function formatNumber(value: number, numFmt: string): string {
  switch (numFmt) {
    case "decimal":
      return String(value);
    case "decimalZero":
      return value < 10 ? `0${value}` : String(value);
    case "upperRoman":
      return toRoman(value, true);
    case "lowerRoman":
      return toRoman(value, false);
    case "upperLetter":
      return toLetters(value, true);
    case "lowerLetter":
      return toLetters(value, false);
    case "ordinal":
      return ordinal(value);
    case "cardinalText":
    case "ordinalText":
      return String(value);
    case "none":
      return "";
    case "bullet":
      return "";
    default:
      return String(value);
  }
}

function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** Renders a level template such as `%1.%2.` against the current counters. */
export function formatListLabel(
  level: ListLevel,
  abstractLevels: ListLevel[],
  counters: number[],
): string {
  if (level.numFmt === "bullet") return level.lvlText || "\u2022";
  if (level.numFmt === "none") return "";
  return level.lvlText.replace(/%([1-9])/g, (_match, group: string) => {
    const index = Number(group) - 1;
    const target = abstractLevels.find((entry) => entry.level === index);
    const raw = counters[index] ?? target?.start ?? 1;
    return formatNumber(raw, target?.numFmt ?? "decimal");
  });
}

export interface NumberingState {
  labels: Map<string, ListLabel>;
  /** Resolved numbering for each paragraph id (undefined when not a list item). */
  refs: Map<string, NumberingRef>;
}

/**
 * Computes list labels for every numbered paragraph in document order.
 * Counters are doc scoped (per numId), reset deeper levels on increment and
 * honour `startOverride` restarts.
 */
export function computeNumbering(doc: DocDocument): NumberingState {
  const labels = new Map<string, ListLabel>();
  const refs = new Map<string, NumberingRef>();
  const counters = new Map<string, number[]>();
  const started = new Set<string>();

  for (const { paragraph } of listParagraphs(doc)) {
    const props = resolveParagraphProps(doc, paragraph);
    const ref = props.numbering;
    if (!ref || !ref.numId) continue;
    const num = doc.numbering.nums[ref.numId];
    if (!num) continue;
    const abstract = doc.numbering.abstract[num.abstractId];
    if (!abstract) continue;
    const level = Math.max(0, Math.min(8, ref.level ?? 0));
    const levelDef = getNumberingLevel(doc, ref.numId, level);
    if (!levelDef) continue;

    const arr = counters.get(ref.numId) ?? new Array(9).fill(0);
    const startKey = `${ref.numId}:${level}`;
    if (ref.startOverride !== undefined && !started.has(startKey)) {
      arr[level] = ref.startOverride - 1;
      started.add(startKey);
    }
    // First appearance of a level uses its declared start value.
    if (arr[level] === 0 && !started.has(startKey)) {
      arr[level] = (levelDef.start || 1) - 1;
      started.add(startKey);
    }
    arr[level] += 1;
    for (let deeper = level + 1; deeper < 9; deeper += 1) arr[deeper] = 0;
    counters.set(ref.numId, arr);

    const label = formatListLabel(levelDef, abstract.levels, arr);
    const indentLeft = levelDef.paragraph?.indent?.left ?? 36 + level * 36;
    const indentHanging = levelDef.paragraph?.indent?.hanging ?? 18;
    labels.set(paragraph.id, {
      paragraphId: paragraph.id,
      numId: ref.numId,
      level,
      label,
      suffix: levelDef.suff ?? "tab",
      indent: { left: indentLeft, hanging: indentHanging },
      bullet: levelDef.numFmt === "bullet",
    });
    refs.set(paragraph.id, ref);
  }

  return { labels, refs };
}

/** Whether a paragraph participates in a list. */
export function isListParagraph(
  doc: DocDocument,
  paragraph: Paragraph,
): boolean {
  return Boolean(resolveParagraphProps(doc, paragraph).numbering?.numId);
}

/** Label text for a paragraph, or undefined when it is not a list item. */
export function listLabel(
  doc: DocDocument,
  paragraph: Paragraph,
): string | undefined {
  return computeNumbering(doc).labels.get(paragraph.id)?.label;
}
