/** Deterministic review checks that work without a language model. */
import { listParagraphs } from "../model/access.js";
import { paragraphText } from "../model/text.js";
import type { DocDocument } from "../model/types.js";
import type { AiFinding } from "./types.js";

export const COMMON_MISSPELLINGS: Record<string, string> = {
  teh: "the",
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  seperated: "separated",
  occured: "occurred",
  occurence: "occurrence",
  definately: "definitely",
  accomodate: "accommodate",
  adress: "address",
  alot: "a lot",
  becuase: "because",
  wich: "which",
  thier: "their",
  untill: "until",
  publically: "publicly",
  refered: "referred",
  succesful: "successful",
  tommorow: "tomorrow",
  neccessary: "necessary",
  comming: "coming",
  enviroment: "environment",
  goverment: "government",
  independant: "independent",
  maintainance: "maintenance",
  occassion: "occasion",
  posession: "possession",
  questionaire: "questionnaire",
  wierd: "weird",
};

const DATE_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "iso", regex: /\b\d{4}-\d{2}-\d{2}\b/g },
  { id: "slash", regex: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { id: "dot", regex: /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g },
  {
    id: "long",
    regex:
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g,
  },
  {
    id: "dayFirstLong",
    regex:
      /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/g,
  },
];

export type ReviewCheck =
  | "spelling"
  | "grammar"
  | "consistency"
  | "dates"
  | "readability"
  | "missingSpaces";

const DEFAULT_CHECKS: ReviewCheck[] = [
  "spelling",
  "grammar",
  "consistency",
  "dates",
  "readability",
  "missingSpaces",
];

export interface ReviewResult {
  findings: AiFinding[];
  counts: Record<string, number>;
  checkedParagraphs: number;
}

/** Runs mechanical document checks; every finding points at a block and offset. */
export function reviewDocument(
  doc: DocDocument,
  options: { checks?: string[]; blockIds?: string[] } = {},
): ReviewResult {
  const enabled = new Set<ReviewCheck>(
    (options.checks && options.checks.length > 0
      ? options.checks
      : DEFAULT_CHECKS) as ReviewCheck[],
  );
  const findings: AiFinding[] = [];
  const counts: Record<string, number> = {};
  const filter = options.blockIds ? new Set(options.blockIds) : undefined;
  let checked = 0;
  const dateStyles = new Map<
    string,
    Array<{ blockId: string; sample: string }>
  >();

  for (const { paragraph } of listParagraphs(doc)) {
    if (filter && !filter.has(paragraph.id)) continue;
    const text = paragraphText(paragraph, "final");
    if (!text.trim()) continue;
    checked += 1;
    const push = (finding: AiFinding) => {
      findings.push(finding);
      counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    };

    if (enabled.has("spelling")) {
      for (const [wrong, right] of Object.entries(COMMON_MISSPELLINGS)) {
        const regex = new RegExp(`\\b${wrong}\\b`, "gi");
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          push({
            code: "spelling.commonMisspelling",
            severity: "warning",
            message: `Possible misspelling "${match[0]}"`,
            blockId: paragraph.id,
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
            suggestion: right,
          });
        }
      }
    }

    if (enabled.has("grammar")) {
      const repeated = /\b([\p{L}]+)\s+\1\b/giu;
      let match: RegExpExecArray | null;
      while ((match = repeated.exec(text)) !== null) {
        push({
          code: "grammar.repeatedWord",
          severity: "warning",
          message: `Repeated word "${match[1]}"`,
          blockId: paragraph.id,
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
      const doubles = / {2,}/g;
      while ((match = doubles.exec(text)) !== null) {
        push({
          code: "formatting.doubleSpace",
          severity: "info",
          message: "Multiple consecutive spaces",
          blockId: paragraph.id,
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
    }

    if (enabled.has("missingSpaces")) {
      const missing = /[.,;:!?][A-Za-z]/g;
      let match: RegExpExecArray | null;
      while ((match = missing.exec(text)) !== null) {
        push({
          code: "grammar.missingSpace",
          severity: "warning",
          message: `Missing space after punctuation: "${match[0]}"`,
          blockId: paragraph.id,
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
    }

    if (enabled.has("readability")) {
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        const words = sentence.split(/\s+/).filter(Boolean).length;
        if (words > 40) {
          const start = text.indexOf(sentence);
          push({
            code: "readability.longSentence",
            severity: "info",
            message: `Sentence has ${words} words; consider splitting it`,
            blockId: paragraph.id,
            start: start >= 0 ? start : undefined,
            end: start >= 0 ? start + sentence.length : undefined,
            text: sentence.slice(0, 160),
          });
        }
      }
    }

    if (enabled.has("dates") || enabled.has("consistency")) {
      for (const pattern of DATE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(text)) !== null) {
          const list = dateStyles.get(pattern.id) ?? [];
          list.push({ blockId: paragraph.id, sample: match[0] });
          dateStyles.set(pattern.id, list);
          if (match[0].length === 0) pattern.regex.lastIndex += 1;
        }
      }
    }

    if (enabled.has("consistency")) {
      const placeholders = /\b(TODO|TBD|FIXME|XXX|lorem ipsum)\b/gi;
      let match: RegExpExecArray | null;
      while ((match = placeholders.exec(text)) !== null) {
        push({
          code: "content.placeholder",
          severity: "warning",
          message: `Placeholder text "${match[0]}" found`,
          blockId: paragraph.id,
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
      const doubledWord = /\b(\p{L}+)\s+\1\b/giu;
      void doubledWord;
    }
  }

  if (
    (enabled.has("dates") || enabled.has("consistency")) &&
    dateStyles.size > 1
  ) {
    const styles = [...dateStyles.entries()].map(([styleId, entries]) => ({
      styleId,
      count: entries.length,
      sample: entries[0]?.sample,
      blockId: entries[0]?.blockId,
    }));
    findings.push({
      code: "consistency.mixedDateFormats",
      severity: "warning",
      message: `Mixed date formats detected (${styles.map((entry) => `${entry.styleId}: ${entry.sample}`).join("; ")}). Standardise on one format.`,
      blockId: styles[0]?.blockId,
    });
    counts["consistency.mixedDateFormats"] = 1;
  }

  return { findings, counts, checkedParagraphs: checked };
}
