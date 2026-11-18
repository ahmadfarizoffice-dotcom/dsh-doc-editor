/** SVG renderer: one self-contained SVG document per page. */
import type {
  LayoutBox,
  LayoutPage,
  LayoutResult,
  LayoutTextRun,
} from "../layout/types.js";
import { metricsFor } from "../layout/afm-metrics.js";
import { escapeHtml } from "./html.js";

export interface SvgRenderOptions {
  images?: Record<string, { contentType: string; data: string }>;
  /** Include page background (default true). */
  background?: boolean;
  title?: string;
}

function metricKey(run: LayoutTextRun): string {
  const base = run.font.metricFamily || "helvetica";
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
    run.font.bold && run.font.italic
      ? "boldItalic"
      : run.font.bold
        ? "bold"
        : run.font.italic
          ? "italic"
          : "regular";
  return entry[key];
}

function fontFamilyFor(run: LayoutTextRun): string {
  switch (run.font.metricFamily) {
    case "times":
      return "Times New Roman, Times, serif";
    case "courier":
      return "Courier New, Courier, monospace";
    default:
      return "Helvetica, Arial, sans-serif";
  }
}

function renderRun(run: LayoutTextRun): string {
  const metrics = metricsFor(metricKey(run));
  const ascent = metrics.ascender * run.font.size;
  const top = run.baseline - ascent;
  const weight = run.font.bold ? ' font-weight="700"' : "";
  const style = run.font.italic ? ' font-style="italic"' : "";
  const fill = run.color ?? "#000000";
  const decorations: string[] = [];
  if (run.decoration?.underline) {
    const thickness = Math.max(0.5, run.font.size / 18);
    decorations.push(
      `<line x1="${run.x.toFixed(2)}" y1="${(run.baseline + 1.2).toFixed(2)}" x2="${(run.x + run.width).toFixed(2)}" y2="${(run.baseline + 1.2).toFixed(2)}" stroke="${fill}" stroke-width="${thickness}"/>`,
    );
  }
  if (run.decoration?.strike) {
    decorations.push(
      `<line x1="${run.x.toFixed(2)}" y1="${(run.baseline - run.font.size * 0.28).toFixed(2)}" x2="${(run.x + run.width).toFixed(2)}" y2="${(run.baseline - run.font.size * 0.28).toFixed(2)}" stroke="${fill}" stroke-width="0.6"/>`,
    );
  }
  if (run.highlight || run.background) {
    decorations.unshift(
      `<rect x="${run.x.toFixed(2)}" y="${(top - 1).toFixed(2)}" width="${Math.max(run.width, 1).toFixed(2)}" height="${(run.font.size * 1.2).toFixed(2)}" fill="${run.highlight ?? run.background}"/>`,
    );
  }
  return `${decorations.join("")}<text x="${run.x.toFixed(2)}" y="${run.baseline.toFixed(2)}" font-family="${fontFamilyFor(run)}" font-size="${run.font.size.toFixed(2)}" fill="${fill}"${weight}${style} xml:space="preserve">${escapeHtml(run.text)}</text>`;
}

function renderBox(box: LayoutBox, images: SvgRenderOptions["images"]): string {
  switch (box.kind) {
    case "text":
      return box.runs.map((run) => renderRun(run)).join("");
    case "image": {
      const media = images?.[box.mediaId];
      if (!media) {
        return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="#cbd5e1" stroke-dasharray="3 3"/>`;
      }
      return `<image x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid meet" href="data:${media.contentType};base64,${media.data}"/>`;
    }
    case "rect": {
      const parts: string[] = [];
      const fill = box.fill ?? "none";
      parts.push(
        `<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${Math.max(box.width, 0.1).toFixed(2)}" height="${Math.max(box.height, 0.1).toFixed(2)}" fill="${fill}"/>`,
      );
      const border = box.border ?? {};
      const sides: Array<
        [
          string,
          { width: number; color?: string } | undefined,
          [number, number, number, number],
        ]
      > = [
        ["top", border.top, [box.x, box.y, box.x + box.width, box.y]],
        [
          "bottom",
          border.bottom,
          [box.x, box.y + box.height, box.x + box.width, box.y + box.height],
        ],
        ["left", border.left, [box.x, box.y, box.x, box.y + box.height]],
        [
          "right",
          border.right,
          [box.x + box.width, box.y, box.x + box.width, box.y + box.height],
        ],
      ];
      for (const [, side, coords] of sides) {
        if (!side) continue;
        parts.push(
          `<line x1="${coords[0].toFixed(2)}" y1="${coords[1].toFixed(2)}" x2="${coords[2].toFixed(2)}" y2="${coords[3].toFixed(2)}" stroke="${side.color ?? "#000"}" stroke-width="${Math.max(0.25, side.width).toFixed(2)}"/>`,
        );
      }
      return parts.join("");
    }
    case "line":
      return `<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.width.toFixed(2)}" height="${Math.max(0.5, box.thickness).toFixed(2)}" fill="${box.color}"/>`;
    case "math":
      return `<text x="${box.x.toFixed(2)}" y="${(box.y + box.height * 0.8).toFixed(2)}" font-family="Cambria Math, serif" font-size="${box.font.size.toFixed(2)}" fill="#000" xml:space="preserve">${escapeHtml(box.text)}</text>`;
    case "shape":
      return `<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.width.toFixed(2)}" height="${box.height.toFixed(2)}" fill="${box.fill ?? "none"}" stroke="${box.border?.color ?? "none"}"/>`;
    default:
      return "";
  }
}

/** Renders a single page as an SVG document. */
export function renderPageSvg(
  page: LayoutPage,
  options: SvgRenderOptions = {},
): string {
  const boxes = [...page.boxes].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const body: string[] = [];
  const background =
    options.background !== false && page.background
      ? `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="${page.background}"/>`
      : `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="#ffffff"/>`;
  body.push(background);
  if (page.header)
    body.push(
      ...page.header.boxes.map((box) => renderBox(box, options.images)),
    );
  body.push(...boxes.map((box) => renderBox(box, options.images)));
  if (page.footnoteRegion)
    body.push(
      ...page.footnoteRegion.boxes.map((box) => renderBox(box, options.images)),
    );
  if (page.footer)
    body.push(
      ...page.footer.boxes.map((box) => renderBox(box, options.images)),
    );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">`,
    `<title>${escapeHtml(options.title ?? `Page ${page.displayNumber}`)}</title>`,
    body.join(""),
    "</svg>",
  ].join("");
}

/** Renders every page as an array of SVG documents. */
export function renderSvg(
  layout: LayoutResult,
  options: SvgRenderOptions = {},
): string[] {
  return layout.pages.map((page) => renderPageSvg(page, options));
}

/** Renders the layout into a single HTML page with inline SVG pages. */
export function renderSvgHtml(
  layout: LayoutResult,
  options: SvgRenderOptions = {},
): string {
  const pages = layout.pages
    .map(
      (page) =>
        `<figure class="page" data-page="${page.displayNumber}">${renderPageSvg(page, options)}</figure>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(options.title ?? "Document")}</title><style>body{margin:0;background:#e5e7eb;padding:24px}.page{margin:0 auto 24px;width:max-content;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.18)}@media print{body{background:#fff;padding:0}.page{box-shadow:none;page-break-after:always}}</style></head><body>${pages}</body></html>`;
}
