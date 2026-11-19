/**
 * Formatting state shared by every skin's toolbar, ribbon and inspector.
 *
 * The controls are pure projections of the model: `readFormattingState` is
 * tested without React, and `useFormattingState` simply memoises it and
 * subscribes to the selection bus. No skin keeps its own formatting state.
 */
import { useMemo } from "react";
import {
  getNumberingLevel,
  listParagraphStyles,
  mergeRunProps,
} from "@dsh-doc/core/model";
import type {
  DocDocument,
  ListLevel,
  ParagraphProps,
  RunProps,
  StyleDef,
} from "@dsh-doc/core/model";
import type { AppSnapshot, AppStore } from "../app/state";
import { useSelectionVersion } from "../app/state";
import { readActiveFormatting } from "../model/ops";
import type { EditorSelection } from "../model/selection";

export interface FormattingState {
  run: RunProps;
  paragraph: ParagraphProps;
  /** Style of the first selected paragraph, when there is one. */
  styleId: string;
  hasRange: boolean;
  inBulletList: boolean;
  inNumberList: boolean;
  inList: boolean;
  listLevel: ListLevel | undefined;
  styles: StyleDef[];
}

export function readFormattingState(
  document: DocDocument,
  selection: EditorSelection,
  pendingFormat?: RunProps,
): FormattingState {
  const active = readActiveFormatting(document, selection);
  const run =
    !active.hasRange && pendingFormat
      ? mergeRunProps(active.run, pendingFormat)
      : active.run;
  const paragraph = active.paragraph;
  const numbering = paragraph.numbering;
  const listLevel = numbering
    ? getNumberingLevel(document, numbering.numId, numbering.level)
    : undefined;
  const inList = Boolean(numbering);
  return {
    run,
    paragraph,
    styleId: active.style ?? "Normal",
    hasRange: active.hasRange,
    inBulletList: inList && listLevel?.numFmt === "bullet",
    inNumberList: inList && listLevel?.numFmt !== "bullet",
    inList,
    listLevel,
    styles: listParagraphStyles(document),
  };
}

export function useFormattingState(
  store: AppStore,
  snapshot: AppSnapshot,
): FormattingState {
  // Re-render the chrome when the selection moves; the app snapshot alone is
  // not enough because selection changes do not version the document.
  useSelectionVersion(store);
  const selection = store.selection;
  const pending = store.session.pendingFormat;
  return useMemo(
    () => readFormattingState(snapshot.document, selection, pending),
    // The document is mutated in place; documentVersion is the real signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.document, snapshot.documentVersion, selection, pending],
  );
}

export const FONT_FAMILIES: readonly string[] = [
  "Calibri",
  "Calibri Light",
  "Arial",
  "Cambria",
  "Candara",
  "Consolas",
  "Courier New",
  "Georgia",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

export const FONT_SIZES: readonly number[] = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72,
];

export const LINE_SPACING: readonly { value: number; label: string }[] = [
  { value: 1, label: "1.0" },
  { value: 1.15, label: "1.15" },
  { value: 1.5, label: "1.5" },
  { value: 2, label: "2.0" },
  { value: 2.5, label: "2.5" },
  { value: 3, label: "3.0" },
];

export const ZOOM_LEVELS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
