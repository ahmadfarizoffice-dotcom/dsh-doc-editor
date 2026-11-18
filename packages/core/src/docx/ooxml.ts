/**
 * OOXML mapping tables and unit conversions shared by the importer and exporter.
 */
import type {
  Alignment,
  Border,
  BorderSet,
  BorderStyle,
  UnderlineStyle,
  VerticalAlign,
} from "../model/types.js";
import { cmToPt, twipsToPt } from "../model/types.js";

export const W_ATTRS = {
  val: "w:val",
} as const;

/* ------------------------------------------------------------------- units */

export const twips = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : twipsToPt(value);

export const halfPoints = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : value / 2;

export const eighths = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : value / 8;

export function parseFloatOrUndefined(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseIntOrUndefined(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ------------------------------------------------------------------ colour */

export function normalizeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "auto") return undefined;
  const hex = value.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  none: "",
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGray: "#808080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  green: "#00ff00",
  lightGray: "#c0c0c0",
  magenta: "#ff00ff",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00",
};

export function highlightToColor(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const mapped = HIGHLIGHT_COLORS[value];
  if (mapped !== undefined) return mapped === "" ? undefined : mapped;
  return normalizeColor(value);
}

export function colorToHighlight(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const entry = Object.entries(HIGHLIGHT_COLORS).find(
    ([, hex]) => hex.toLowerCase() === value.toLowerCase(),
  );
  return entry?.[0];
}

/* ----------------------------------------------------------------- borders */

const BORDER_STYLES: Record<string, BorderStyle> = {
  nil: "none",
  none: "none",
  single: "single",
  thick: "thick",
  double: "double",
  dotted: "dotted",
  dashed: "dashed",
  dotDash: "dotDash",
  dotDotDash: "dotDotDash",
  triple: "triple",
  wave: "wave",
  doubleWave: "doubleWave",
  dashSmallGap: "dashSmallGap",
  dashDotStroked: "dashDotStroked",
  threeDEmboss: "threeDEmboss",
  threeDEngrave: "threeDEngrave",
  outset: "outset",
  inset: "inset",
};

export function borderStyleFromOoxml(value: string | undefined): BorderStyle {
  if (!value) return "single";
  return BORDER_STYLES[value] ?? "single";
}

export function borderStyleToOoxml(style: BorderStyle): string {
  switch (style) {
    case "none":
      return "nil";
    case "dashSmallGap":
      return "dashSmallGap";
    case "dashDotStroked":
      return "dashDotStroked";
    case "threeDEmboss":
      return "threeDEmboss";
    case "threeDEngrave":
      return "threeDEngrave";
    case "dotDash":
      return "dotDash";
    case "dotDotDash":
      return "dotDotDash";
    case "doubleWave":
      return "doubleWave";
    default:
      return style;
  }
}

export const UNDERLINE_STYLES: Record<string, UnderlineStyle | false> = {
  single: "single",
  double: "double",
  dotted: "dotted",
  dash: "dash",
  wave: "wave",
  thick: "thick",
  none: false,
};

export function underlineFromOoxml(
  value: string | undefined,
): UnderlineStyle | false | undefined {
  if (value === undefined) return undefined;
  return UNDERLINE_STYLES[value] ?? "single";
}

export function underlineToOoxml(
  value: UnderlineStyle | false | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value === false) return "none";
  return value;
}

export function vertAlignFromOoxml(
  value: string | undefined,
): VerticalAlign | undefined {
  if (value === "superscript") return "superscript";
  if (value === "subscript") return "subscript";
  if (value === "baseline") return "baseline";
  return undefined;
}

export function vertAlignToOoxml(
  value: VerticalAlign | undefined,
): string | undefined {
  if (value === "superscript" || value === "subscript") return value;
  return undefined;
}

/* -------------------------------------------------------------- alignment */

export function alignmentFromOoxml(
  value: string | undefined,
): Alignment | undefined {
  switch (value) {
    case "left":
    case "start":
      return "left";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "both":
      return "justify";
    case "distribute":
      return "distribute";
    default:
      return undefined;
  }
}

export function alignmentToOoxml(
  value: Alignment | undefined,
): string | undefined {
  switch (value) {
    case "left":
      return "left";
    case "center":
      return "center";
    case "right":
      return "right";
    case "justify":
      return "both";
    case "distribute":
      return "distribute";
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------- borders */

export function parseBorder(
  node: import("@xmldom/xmldom").Element | undefined,
  attr: (name: string) => string | undefined,
): Border | undefined {
  if (!node) return undefined;
  const style = borderStyleFromOoxml(attr("val"));
  const size = parseIntOrUndefined(attr("sz"));
  const width = size === undefined ? 0.5 : size / 8;
  const color = normalizeColor(attr("color")) ?? "#000000";
  const space = twips(parseIntOrUndefined(attr("space")));
  const shadow = attr("shadow") === "1" || attr("shadow") === "true";
  if (style === "none") {
    return { style: "none", width: 0, color, none: true };
  }
  return { style, width, color, space, shadow: shadow || undefined };
}

export interface BorderSide {
  node: import("@xmldom/xmldom").Element | undefined;
  attr: (name: string) => string | undefined;
}

export function parseBorderSet(
  parent: import("@xmldom/xmldom").Element | null | undefined,
  resolver: (
    parent: import("@xmldom/xmldom").Element,
    name: string,
  ) => BorderSide,
  names: Record<string, keyof BorderSet>,
): BorderSet | undefined {
  if (!parent) return undefined;
  const result: BorderSet = {};
  let found = false;
  for (const [ooxmlName, key] of Object.entries(names)) {
    const side = resolver(parent, ooxmlName);
    if (!side.node) continue;
    const border = parseBorder(side.node, side.attr);
    if (border) {
      result[key] = border;
      found = true;
    }
  }
  return found ? result : undefined;
}

/* ------------------------------------------------------------ page sizes */

export function pageSizeFromTwips(width: number, height: number) {
  return { width: twipsToPt(width), height: twipsToPt(height) };
}

export const PAGE_SIZE_TO_TWIPS: Record<string, { w: number; h: number }> = {
  A3: { w: 16838, h: 23811 },
  A4: { w: 11906, h: 16838 },
  A5: { w: 8391, h: 11906 },
  B5: { w: 9979, h: 14175 },
  Letter: { w: 12240, h: 15840 },
  Legal: { w: 12240, h: 20160 },
  Tabloid: { w: 15840, h: 24480 },
  Executive: { w: 10440, h: 15120 },
};

/** Matches a page size (points) to a known preset within 2pt. */
export function matchPagePreset(
  width: number,
  height: number,
): string | undefined {
  const presets: Record<string, { w: number; h: number }> = {
    A3: { w: 841.9, h: 1190.6 },
    A4: { w: 595.3, h: 841.9 },
    A5: { w: 419.5, h: 595.3 },
    B5: { w: 498.9, h: 708.7 },
    Letter: { w: 612, h: 792 },
    Legal: { w: 612, h: 1008 },
    Tabloid: { w: 792, h: 1224 },
    Executive: { w: 522, h: 756 },
  };
  for (const [name, preset] of Object.entries(presets)) {
    const portrait =
      Math.abs(width - preset.w) < 2 && Math.abs(height - preset.h) < 2;
    const rotated =
      Math.abs(width - preset.h) < 2 && Math.abs(height - preset.w) < 2;
    if (portrait || rotated) return name;
  }
  return undefined;
}

/* ------------------------------------------------------------------- misc */

export function cm(value: number): number {
  return cmToPt(value);
}

export function boolAttr(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "1" || value === "true" || value === "on";
}

export function boolToOoxml(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? "1" : "0";
}

export function numFmtFromOoxml(value: string | undefined): string {
  return value ?? "decimal";
}

/** Converts a `w:hex` colour (e.g. `auto`) into a CSS colour. */
export function colorOrUndefined(
  value: string | undefined,
): string | undefined {
  return normalizeColor(value);
}

/** EMU to points. */
export function emu(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 12700;
}
