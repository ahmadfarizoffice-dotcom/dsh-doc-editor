/**
 * Font resolution and text measurement for the layout engine.
 *
 * Document fonts are mapped onto metrically compatible standard families so
 * pagination is deterministic without shipping font binaries. Substitutions are
 * reported by the engine so the UI can warn about visual differences.
 */
import type { FontSpec } from "./types.js";
import { AFM_METRICS, metricsFor, type AfmMetrics } from "./afm-metrics.js";
import type { RunProps as ModelRunProps } from "../model/types.js";

export type { FontSpec };

/** Metric family names exposed by the engine. */
export const METRIC_FAMILIES = [
  "helvetica",
  "helveticaBold",
  "helveticaOblique",
  "helveticaBoldOblique",
  "times",
  "timesBold",
  "timesItalic",
  "timesBoldItalic",
  "courier",
  "courierBold",
  "courierOblique",
  "courierBoldOblique",
] as const;

const FAMILY_SUBSTITUTIONS: Record<string, "helvetica" | "times" | "courier"> =
  {
    // Sans-serif
    arial: "helvetica",
    helvetica: "helvetica",
    "helvetica neue": "helvetica",
    calibri: "helvetica",
    "calibri light": "helvetica",
    candara: "helvetica",
    segoe: "helvetica",
    "segoe ui": "helvetica",
    verdana: "helvetica",
    tahoma: "helvetica",
    "trebuchet ms": "helvetica",
    "franklin gothic book": "helvetica",
    lato: "helvetica",
    roboto: "helvetica",
    "open sans": "helvetica",
    inter: "helvetica",
    liberation: "helvetica",
    "liberation sans": "helvetica",
    // Serif
    times: "times",
    "times new roman": "times",
    "times new roman ps mt": "times",
    georgia: "times",
    cambria: "times",
    garamond: "times",
    "book antiqua": "times",
    palatino: "times",
    "palatino linotype": "times",
    "century schoolbook": "times",
    "liberation serif": "times",
    serif: "times",
    // Monospace
    "courier new": "courier",
    courier: "courier",
    consolas: "courier",
    monaco: "courier",
    "lucida console": "courier",
    "source code pro": "courier",
    menlo: "courier",
    monospace: "courier",
  };

const DEFAULT_FAMILY = "helvetica";

const METRIC_KEYS: Record<
  string,
  Record<"regular" | "bold" | "italic" | "boldItalic", string>
> = {
  helvetica: {
    regular: "helvetica",
    bold: "helveticaBold",
    italic: "helveticaOblique",
    boldItalic: "helveticaBoldOblique",
  },
  times: {
    regular: "times",
    bold: "timesBold",
    italic: "timesItalic",
    boldItalic: "timesBoldItalic",
  },
  courier: {
    regular: "courier",
    bold: "courierBold",
    italic: "courierOblique",
    boldItalic: "courierBoldOblique",
  },
};

/** Characters that occupy a full em in CJK typography. */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export interface FontResolverOptions {
  substitutions?: Record<string, string>;
}

export class FontResolver {
  private readonly substitutions: Record<string, string>;
  /** Families seen that are not metrically identical to their substitute. */
  readonly substituted = new Set<string>();

  constructor(options: FontResolverOptions = {}) {
    this.substitutions = options.substitutions ?? {};
  }

  /** Maps a document family to a metric family (`helvetica`|`times`|`courier`). */
  metricFamily(family: string | undefined): "helvetica" | "times" | "courier" {
    if (!family) return DEFAULT_FAMILY;
    const key = family.trim().toLowerCase();
    const explicit = this.substitutions[key] ?? this.substitutions[family];
    if (explicit) {
      const normalized = explicit.toLowerCase();
      if (normalized.includes("times")) return "times";
      if (normalized.includes("courier")) return "courier";
      return "helvetica";
    }
    const mapped = FAMILY_SUBSTITUTIONS[key];
    if (mapped) {
      // Families whose glyph widths differ from the metric substitute are
      // reported so the UI can warn about visual differences.
      const metricIdentical = new Set([
        "helvetica",
        "helvetica neue",
        "arial",
        "times",
        "times new roman",
        "times new roman ps mt",
        "courier",
        "courier new",
      ]);
      if (!metricIdentical.has(key)) this.substituted.add(family);
      return mapped;
    }
    // Unknown family: pick sans and report the substitution.
    if (key !== "helvetica" && key !== "arial") this.substituted.add(family);
    return DEFAULT_FAMILY;
  }

  metricKey(
    family: string | undefined,
    bold: boolean,
    italic: boolean,
  ): string {
    const base = this.metricFamily(family);
    const entry = METRIC_KEYS[base];
    if (bold && italic) return entry.boldItalic;
    if (bold) return entry.bold;
    if (italic) return entry.italic;
    return entry.regular;
  }

  resolve(run: ModelRunProps | undefined, fallbackSize = 11): FontSpec {
    const family = run?.fontFamily ?? "Calibri";
    const bold = run?.bold === true;
    const italic = run?.italic === true;
    return {
      family,
      metricFamily: this.metricFamily(family),
      size: run?.fontSize ?? fallbackSize,
      bold,
      italic,
    };
  }

  metricsFor(font: FontSpec): AfmMetrics {
    return metricsFor(this.metricKey(font.family, font.bold, font.italic));
  }

  metricsKeyFor(font: FontSpec): string {
    return this.metricKey(font.family, font.bold, font.italic);
  }
}

/** Width of a single codepoint in points. */
export function charWidth(
  cp: number,
  font: FontSpec,
  metrics: AfmMetrics,
): number {
  const unit = (font.size || 11) / 1000;
  if (cp >= 32 && cp <= 255) {
    return (metrics.widths[cp - 32] ?? metrics.defaultWidth) * unit;
  }
  if (isWideCodePoint(cp)) return 1000 * unit;
  if (cp === 0xa0) return metrics.space * unit;
  return metrics.defaultWidth * unit;
}

/** Width of a string in points (kerning and ligatures are not applied). */
export function measureText(
  text: string,
  font: FontSpec,
  metrics: AfmMetrics,
): number {
  let width = 0;
  for (const char of text) {
    width += charWidth(char.codePointAt(0) ?? 32, font, metrics);
  }
  return width;
}

/** Line height for a font: (ascender - descender) * size. */
export function naturalLineHeight(font: FontSpec, metrics: AfmMetrics): number {
  return (metrics.ascender - metrics.descender) * (font.size || 11);
}

/** Distance from the line top to the baseline. */
export function ascentFor(font: FontSpec, metrics: AfmMetrics): number {
  return metrics.ascender * (font.size || 11);
}

export function descentFor(font: FontSpec, metrics: AfmMetrics): number {
  return -metrics.descender * (font.size || 11);
}

/** Detects right-to-left script content for bidi treatment. */
const RTL_PATTERN =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export function isRtlText(text: string): boolean {
  return RTL_PATTERN.test(text);
}

export { AFM_METRICS };
