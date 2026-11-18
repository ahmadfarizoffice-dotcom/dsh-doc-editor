/**
 * Renderer public surface. All renderers consume the layout engine output, so
 * pagination, print preview and PDF agree with each other.
 */
export { renderHtml, renderPagesHtml, renderPageHtml } from "./html.js";
export type { HtmlRenderOptions } from "./html.js";
export { renderSvg, renderPageSvg, renderSvgHtml } from "./svg.js";
export type { SvgRenderOptions } from "./svg.js";
export { renderPdf } from "./pdf.js";
export type { PdfRenderOptions } from "./pdf.js";

import type { DocDocument } from "../model/types.js";
import {
  layoutDocument,
  type LayoutOptions,
  type LayoutResult,
} from "../layout/index.js";
import { renderHtml, type HtmlRenderOptions } from "./html.js";
import { renderPdf, type PdfRenderOptions } from "./pdf.js";

/** Builds the image lookup passed to renderers from a document's media parts. */
export function mediaMap(
  doc: DocDocument,
): Record<string, { contentType: string; data: string }> {
  const map: Record<string, { contentType: string; data: string }> = {};
  for (const asset of doc.media) {
    map[asset.id] = { contentType: asset.contentType, data: asset.data };
  }
  return map;
}

export interface RenderDocumentOptions
  extends HtmlRenderOptions, PdfRenderOptions {
  layout?: LayoutOptions;
  /** Reuse a layout result when the caller already computed one. */
  precomputedLayout?: LayoutResult;
}

/** Convenience: document → layout → HTML preview. */
export function renderDocumentHtml(
  doc: DocDocument,
  options: RenderDocumentOptions = {},
): {
  html: string;
  layout: LayoutResult;
} {
  const layout =
    options.precomputedLayout ?? layoutDocument(doc, options.layout);
  const html = renderHtml(layout, {
    ...options,
    images: options.images ?? mediaMap(doc),
  });
  return { html, layout };
}

/** Convenience: document → layout → PDF. */
export async function renderDocumentPdf(
  doc: DocDocument,
  options: RenderDocumentOptions = {},
): Promise<{ buffer: Buffer; layout: LayoutResult }> {
  const layout =
    options.precomputedLayout ?? layoutDocument(doc, options.layout);
  const buffer = await renderPdf(layout, {
    ...options,
    title: options.title ?? doc.metadata.title,
    author: options.author ?? doc.metadata.creator,
    subject: options.subject ?? doc.metadata.subject,
    keywords: options.keywords ?? doc.metadata.keywords,
    images: options.images ?? mediaMap(doc),
  });
  return { buffer, layout };
}
