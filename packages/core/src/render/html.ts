/** HTML renderer over the layout model: page-accurate, absolutely positioned. */
import type {
  LayoutBox,
  LayoutPage,
  LayoutResult,
  LayoutTextRun,
  TextLineBox,
} from "../layout/types.js";
import { AFM_METRICS, metricsFor } from "../layout/afm-metrics.js";

export interface HtmlRenderOptions {
  /** Include the print stylesheet (default true). */
  printCss?: boolean;
  /** Zoom scale applied with CSS transform (default 1). */
  zoom?: number;
  /** Include page shadows and grey background (default true). */
  screenChrome?: boolean;
  /** Include data-* attributes used by the editor (default true). */
  interactive?: boolean;
  /** Document title for the HTML head. */
  title?: string;
  /** Media payloads by media id, as base64 data (contentType + data). */
  images?: Record<string, { contentType: string; data: string }>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br/>");
}

function cssColor(color: string | undefined, fallback = "inherit"): string {
  return color ?? fallback;
}

function metricKey(
  font: {
    family: string;
    bold: boolean;
    italic: boolean;
    metricFamily: string;
  },
  resolverFamily: string,
): string {
  const base = font.metricFamily || "helvetica";
  const map: Record<string, Record<string, string>> = {
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
  const entry = map[base] ?? map.helvetica;
  const key =
    font.bold && font.italic
      ? "boldItalic"
      : font.bold
        ? "bold"
        : font.italic
          ? "italic"
          : "regular";
  void resolverFamily;
  return entry[key];
}

function runCss(run: LayoutTextRun, box: { x: number; y: number }): string {
  const key = metricKey(run.font, run.font.family);
  const metrics = metricsFor(key);
  const ascent = metrics.ascender * run.font.size;
  const style: string[] = [
    `left:${(run.x - box.x).toFixed(2)}pt`,
    `top:${(run.baseline - ascent - box.y).toFixed(2)}pt`,
    `font-family:"${run.font.family}",${cssFontFallback(run.font.family)}`,
    `font-size:${run.font.size.toFixed(2)}pt`,
    `line-height:${(metrics.ascender - metrics.descender).toFixed(3)}em`,
    "white-space:pre",
    "position:absolute",
    `color:${cssColor(run.color, "#000000")}`,
  ];
  if (run.font.bold) style.push("font-weight:700");
  if (run.font.italic) style.push("font-style:italic");
  const decorations: string[] = [];
  if (run.decoration?.underline) decorations.push("underline");
  if (run.decoration?.strike) decorations.push("line-through");
  if (decorations.length > 0)
    style.push(`text-decoration:${decorations.join(" ")}`);
  if (run.highlight) style.push(`background:${run.highlight}`);
  else if (run.background) style.push(`background:${run.background}`);
  if (run.revision?.kind === "insert")
    style.push("color:#1a6b1a;text-decoration:underline");
  if (run.revision?.kind === "delete")
    style.push("color:#a30000;text-decoration:line-through");
  return style.join(";");
}

function cssFontFallback(family: string): string {
  const lower = family.toLowerCase();
  if (
    lower.includes("courier") ||
    lower.includes("mono") ||
    lower.includes("consol")
  ) {
    return "ui-monospace,SFMono-Regular,Menlo,monospace";
  }
  if (
    lower.includes("times") ||
    lower.includes("serif") ||
    lower.includes("georgia") ||
    lower.includes("cambria")
  ) {
    return 'Georgia,"Times New Roman",serif';
  }
  return 'system-ui,-apple-system,"Segoe UI",Arial,sans-serif';
}

function borderCss(
  border: { width: number; color?: string; style: string } | undefined,
): string {
  if (!border) return "none";
  if (border.style === "double")
    return `${Math.max(1, border.width)}pt double ${border.color ?? "#000"}`;
  if (
    border.style === "dashed" ||
    border.style === "dotDash" ||
    border.style === "dotDotDash"
  ) {
    return `${Math.max(0.5, border.width)}pt dashed ${border.color ?? "#000"}`;
  }
  if (border.style === "dotted")
    return `${Math.max(0.5, border.width)}pt dotted ${border.color ?? "#000"}`;
  return `${Math.max(0.25, border.width)}pt solid ${border.color ?? "#000"}`;
}

function renderTextLine(box: TextLineBox, interactive: boolean): string {
  const attrs: string[] = [
    `class="line"`,
    `style="position:absolute;left:${box.x.toFixed(2)}pt;top:${box.y.toFixed(2)}pt;width:${Math.max(box.width, 1).toFixed(2)}pt;height:${box.height.toFixed(2)}pt"`,
  ];
  if (interactive) {
    attrs.push(`data-block="${escapeHtml(box.blockId ?? "")}"`);
    if (box.direction) attrs.push(`dir="${box.direction}"`);
  }
  const runs = box.runs
    .map((run) => {
      const interactiveAttrs = interactive
        ? ` data-block="${escapeHtml(box.blockId ?? "")}"`
        : "";
      if (run.hyperlink?.href) {
        return `<a${interactiveAttrs} href="${escapeHtml(run.hyperlink.href)}" style="${runCss(run, box)};text-decoration:underline">${escapeHtml(run.text)}</a>`;
      }
      return `<span${interactiveAttrs} style="${runCss(run, box)}">${escapeHtml(run.text)}</span>`;
    })
    .join("");
  return `<div ${attrs.join(" ")}>${runs}</div>`;
}

type ImageMap =
  Record<string, { contentType: string; data: string }> | undefined;

function renderBox(
  box: LayoutBox,
  interactive: boolean,
  images: ImageMap,
): string {
  switch (box.kind) {
    case "text":
      return renderTextLine(box, interactive);
    case "image": {
      const media = images?.[box.mediaId];
      const border = box.border
        ? `${Math.max(0.5, box.border.width)}pt solid ${box.border.color ?? "#000"}`
        : "none";
      if (!media) {
        return `<div class="image image-missing" style="position:absolute;left:${box.x.toFixed(2)}pt;top:${box.y.toFixed(2)}pt;width:${box.width.toFixed(2)}pt;height:${box.height.toFixed(2)}pt;border:1pt dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font:9pt system-ui;color:#64748b">${escapeHtml(box.alt ?? "image")}</div>`;
      }
      return `<img class="image" alt="${escapeHtml(box.alt ?? "")}" src="data:${media.contentType};base64,${media.data}" style="position:absolute;left:${box.x.toFixed(2)}pt;top:${box.y.toFixed(2)}pt;width:${box.width.toFixed(2)}pt;height:${box.height.toFixed(2)}pt;border:${border};object-fit:contain"/>`;
    }
    case "rect": {
      const border = box.border ?? {};
      const style = [
        "position:absolute",
        `left:${box.x.toFixed(2)}pt`,
        `top:${box.y.toFixed(2)}pt`,
        `width:${box.width.toFixed(2)}pt`,
        `height:${box.height.toFixed(2)}pt`,
        `background:${box.fill ?? "transparent"}`,
        `border-top:${borderCss(border.top)}`,
        `border-bottom:${borderCss(border.bottom)}`,
        `border-left:${borderCss(border.left)}`,
        `border-right:${borderCss(border.right)}`,
        "box-sizing:border-box",
      ];
      return `<div class="rect" style="${style.join(";")}"></div>`;
    }
    case "line":
      return `<div class="line-rule" style="position:absolute;left:${box.x.toFixed(2)}pt;top:${box.y.toFixed(2)}pt;width:${box.width.toFixed(2)}pt;height:${Math.max(0.5, box.thickness).toFixed(2)}pt;background:${box.color}"></div>`;
    case "math":
      return `<div class="math" style="position:absolute;left:${box.x.toFixed(2)}pt;top:${box.y.toFixed(2)}pt;width:${Math.max(box.width, 1).toFixed(2)}pt;height:${box.height.toFixed(2)}pt;font-family:'Cambria Math',serif;font-size:${box.font.size.toFixed(2)}pt;white-space:pre">${escapeHtml(box.text)}</div>`;
    case "shape":
      return `<div class="shape" style="position:absolute;left:${box.x.toFixed(2)}pt;top:${box.y.toFixed(2)}pt;width:${box.width.toFixed(2)}pt;height:${box.height.toFixed(2)}pt;background:${box.fill ?? "transparent"};border:${box.border ? `${box.border.width}pt solid ${box.border.color}` : "none"}"></div>`;
    default:
      return "";
  }
}

function regionHtml(
  region:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
        boxes: LayoutBox[];
      }
    | undefined,
  interactive: boolean,
  images: ImageMap,
): string {
  if (!region) return "";
  const children = region.boxes
    .map((box) => renderBox(box, interactive, images))
    .join("");
  return `<div class="region" style="position:absolute;left:${region.x.toFixed(2)}pt;top:${region.y.toFixed(2)}pt;width:${region.width.toFixed(2)}pt;height:${region.height.toFixed(2)}pt">${children}</div>`;
}

/** Renders one page as a self-contained HTML fragment. */
export function renderPageHtml(
  page: LayoutPage,
  options: HtmlRenderOptions = {},
): string {
  const interactive = options.interactive !== false;
  const images = options.images;
  const sorted = [...page.boxes].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const borders = page.pageBorders;
  const borderStyle = [
    "position:absolute",
    "left:0",
    "top:0",
    "right:0",
    "bottom:0",
    `border-top:${borderCss(borders?.top)}`,
    `border-bottom:${borderCss(borders?.bottom)}`,
    `border-left:${borderCss(borders?.left)}`,
    `border-right:${borderCss(borders?.right)}`,
    `background:${page.background ?? "transparent"}`,
    "box-sizing:border-box",
  ].join(";");
  return [
    `<section class="page" data-page="${page.displayNumber}" data-page-index="${page.index}" data-section="${page.sectionIndex}" style="width:${page.width.toFixed(2)}pt;height:${page.height.toFixed(2)}pt">`,
    `<div class="page-surface" style="${borderStyle}"></div>`,
    regionHtml(page.header, interactive, images),
    sorted.map((box) => renderBox(box, interactive, images)).join(""),
    regionHtml(page.footnoteRegion, interactive, images),
    regionHtml(page.footer, interactive, images),
    "</section>",
  ].join("");
}

const BASE_CSS = `
.doc-pages { display:flex; flex-direction:column; align-items:center; gap:24px; padding:24px; }
.doc-pages .page { position:relative; background:#fff; box-shadow:0 2px 10px rgba(15,23,42,.18); overflow:hidden; }
.doc-pages.fit .page { box-shadow:none; }
.doc-pages .region { overflow:hidden; }
.doc-pages .line { overflow:visible; }
.doc-pages a { color:inherit; }
.doc-toolbar { display:flex; gap:8px; align-items:center; padding:8px 16px; font:13px system-ui; }
.doc-warning { margin:8px 16px; padding:8px 12px; border-left:3px solid #f59e0b; background:#fffbeb; font:13px system-ui; }
`;

const PRINT_CSS = `
@media print {
  body { margin:0; background:#fff; }
  .doc-pages { padding:0; gap:0; }
  .doc-pages .page { box-shadow:none; page-break-after:always; break-after:page; }
  .doc-pages .page:last-child { page-break-after:auto; break-after:auto; }
  .doc-toolbar, .doc-warning { display:none; }
}
@page { margin:0; }
`;

/** Renders the full document preview (toolbar + zoom + pages). */
export function renderHtml(
  layout: LayoutResult,
  options: HtmlRenderOptions = {},
): string {
  const zoom = options.zoom ?? 1;
  const pages = layout.pages
    .map((page) => renderPageHtml(page, options))
    .join("");
  const warnings = layout.warnings
    .map(
      (warning) =>
        `<div class="doc-warning">${escapeHtml(warning.message)}${warning.blockId ? ` <code>${escapeHtml(warning.blockId)}</code>` : ""}</div>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(options.title ?? "Document preview")}</title>
<style>
${BASE_CSS}
${options.printCss === false ? "" : PRINT_CSS}
</style>
</head>
<body>
<div class="doc-toolbar"><strong>${layout.pageCount}</strong> page${layout.pageCount === 1 ? "" : "s"}</div>
${warnings}
<div class="doc-pages" style="--doc-zoom:${zoom}">${pages}</div>
</body>
</html>`;
}

/** Renders the pages only (embedding into an existing UI). */
export function renderPagesHtml(
  layout: LayoutResult,
  options: HtmlRenderOptions = {},
): string {
  return layout.pages.map((page) => renderPageHtml(page, options)).join("");
}

export { escapeHtml, cssFontFallback };
