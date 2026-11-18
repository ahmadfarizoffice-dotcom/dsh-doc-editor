import type {
  DocDocument,
  Paragraph,
  ParagraphProps,
  RunProps,
  StyleDef,
} from "./types.js";

/** Looks up a style definition by id. */
export function getStyle(
  doc: DocDocument,
  id?: string | null,
): StyleDef | undefined {
  if (!id) return undefined;
  return doc.styles.styles[id];
}

/**
 * Returns the style chain from the root ancestor to the requested style.
 * Cycles are guarded so malformed documents cannot hang style resolution.
 */
export function styleChain(doc: DocDocument, id?: string | null): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let current = id ?? undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = doc.styles.styles[current];
    if (!style) break;
    chain.unshift(style);
    current = style.basedOn;
  }
  return chain;
}

/** Merges defined properties from `over` onto `base` (returns a new object). */
export function mergeRunProps(
  base: RunProps | undefined,
  over: RunProps | undefined,
): RunProps {
  if (!base) return over ? { ...over } : {};
  if (!over) return { ...base };
  const result: RunProps = { ...base };
  for (const [key, value] of Object.entries(over) as Array<
    [keyof RunProps, unknown]
  >) {
    if (value === undefined) continue;
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export function mergeParagraphProps(
  base: ParagraphProps | undefined,
  over: ParagraphProps | undefined,
): ParagraphProps {
  if (!base) return over ? { ...over } : {};
  if (!over) return { ...base };
  const result: ParagraphProps = { ...base };
  for (const [key, value] of Object.entries(over) as Array<
    [keyof ParagraphProps, unknown]
  >) {
    if (value === undefined) continue;
    if (key === "indent" && value && typeof value === "object") {
      result.indent = { ...(base.indent ?? {}), ...(value as object) };
      continue;
    }
    if (key === "borders" && value && typeof value === "object") {
      result.borders = { ...(base.borders ?? {}), ...(value as object) };
      continue;
    }
    if (key === "shading" && value && typeof value === "object") {
      result.shading = { ...(base.shading ?? {}), ...(value as object) };
      continue;
    }
    if (key === "numbering" && value && typeof value === "object") {
      result.numbering = {
        ...(base.numbering ?? { numId: "", level: 0 }),
        ...(value as object),
      };
      continue;
    }
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export interface ResolveRunOptions {
  /** Paragraph style providing base character formatting. */
  paragraphStyle?: string | null;
  /** Character style applied directly to the run. */
  characterStyle?: string | null;
  /** Direct run formatting. */
  direct?: RunProps;
}

/** Resolves effective character formatting: defaults → paragraph style → character style → direct. */
export function resolveRunProps(
  doc: DocDocument,
  options: ResolveRunOptions,
): RunProps {
  let props: RunProps = { ...(doc.styles.defaults.run ?? {}) };
  for (const style of styleChain(doc, options.paragraphStyle)) {
    if (style.run) props = mergeRunProps(props, style.run);
  }
  for (const style of styleChain(doc, options.characterStyle)) {
    if (style.run) props = mergeRunProps(props, style.run);
  }
  if (options.direct) props = mergeRunProps(props, options.direct);
  return props;
}

/** Resolves effective paragraph formatting, including numbering-level indentation. */
export function resolveParagraphProps(
  doc: DocDocument,
  paragraph: Paragraph,
): ParagraphProps {
  let props: ParagraphProps = { ...(doc.styles.defaults.paragraph ?? {}) };
  const chain = styleChain(doc, paragraph.style);
  for (const style of chain) {
    if (style.paragraph) props = mergeParagraphProps(props, style.paragraph);
  }
  const numbering = mergeParagraphProps(props, paragraph.props).numbering;
  if (numbering) {
    const level = getNumberingLevel(doc, numbering.numId, numbering.level);
    if (level?.paragraph) props = mergeParagraphProps(props, level.paragraph);
  }
  props = mergeParagraphProps(props, paragraph.props);
  if (!props.alignment) props.alignment = "left";
  return props;
}

/** Resolves the level definition for a numbering reference. */
export function getNumberingLevel(
  doc: DocDocument,
  numId: string,
  level: number,
): import("./types.js").ListLevel | undefined {
  const num = doc.numbering.nums[numId];
  if (!num) return undefined;
  const abstract = doc.numbering.abstract[num.abstractId];
  if (!abstract) return undefined;
  const override = num.levelOverrides?.[level];
  const base = abstract.levels.find((entry) => entry.level === level);
  if (!base) return undefined;
  if (!override) return base;
  return { ...base, ...override, level };
}

/** Effective paragraph style id, falling back to the default paragraph style. */
export function effectiveStyleId(
  doc: DocDocument,
  paragraph: Paragraph,
): string | undefined {
  if (paragraph.style && doc.styles.styles[paragraph.style])
    return paragraph.style;
  for (const style of Object.values(doc.styles.styles)) {
    if (style.type === "paragraph" && style.isDefault) return style.id;
  }
  return "Normal";
}

/** All paragraph styles offered in the editor's style gallery. */
export function listParagraphStyles(doc: DocDocument): StyleDef[] {
  return Object.values(doc.styles.styles)
    .filter((style) => style.type === "paragraph")
    .sort((a, b) => {
      const pa = a.uiPriority ?? 1000;
      const pb = b.uiPriority ?? 1000;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name);
    });
}

/** Style ids that represent document headings, ordered by level. */
export function headingLevelOfStyle(
  doc: DocDocument,
  styleId?: string | null,
): number | undefined {
  const style = getStyle(doc, styleId);
  if (!style) return undefined;
  if (
    style.paragraph?.outlineLevel !== undefined &&
    style.paragraph.outlineLevel < 9
  ) {
    return style.paragraph.outlineLevel + 1;
  }
  const match =
    /^heading\s*(\d)$/i.exec(style.id) ?? /^heading\s*(\d)$/i.exec(style.name);
  if (match) return Number(match[1]);
  if (/^title$/i.test(style.id)) return 0;
  return undefined;
}
