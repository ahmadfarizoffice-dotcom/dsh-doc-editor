/**
 * PDF renderer using PDFKit. Text is drawn with the PDF standard-14 fonts whose
 * metrics the layout engine uses, so pagination matches the on-screen preview.
 */
import PDFDocument from "pdfkit";
import type {
  LayoutBox,
  LayoutResult,
  LayoutTextRun,
} from "../layout/types.js";
import { metricsFor } from "../layout/afm-metrics.js";

export interface PdfRenderOptions {
  images?: Record<string, { contentType: string; data: string }>;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  /** Metadata for the PDF document. */
  creationDate?: Date;
}

function pdfFontName(run: LayoutTextRun): string {
  const base = run.font.metricFamily || "helvetica";
  if (base === "times") {
    if (run.font.bold && run.font.italic) return "Times-BoldItalic";
    if (run.font.bold) return "Times-Bold";
    if (run.font.italic) return "Times-Italic";
    return "Times-Roman";
  }
  if (base === "courier") {
    if (run.font.bold && run.font.italic) return "Courier-BoldOblique";
    if (run.font.bold) return "Courier-Bold";
    if (run.font.italic) return "Courier-Oblique";
    return "Courier";
  }
  if (run.font.bold && run.font.italic) return "Helvetica-BoldOblique";
  if (run.font.bold) return "Helvetica-Bold";
  if (run.font.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function metricKeyFor(run: LayoutTextRun): string {
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
  const base = run.font.metricFamily || "helvetica";
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

function drawRun(doc: PDFKit.PDFDocument, run: LayoutTextRun): void {
  const metrics = metricsFor(metricKeyFor(run));
  const ascent = metrics.ascender * run.font.size;
  const top = run.baseline - ascent;
  const color = run.color ?? "#000000";
  doc.save();
  if (run.highlight || run.background) {
    doc
      .rect(run.x, top - 1, Math.max(run.width, 1), run.font.size * 1.2)
      .fill(run.highlight ?? run.background ?? "#ffff00");
  }
  doc
    .font(pdfFontName(run))
    .fontSize(run.font.size)
    .fillColor(color)
    .text(run.text, run.x, top, { lineBreak: false, baseline: "top" });
  if (run.decoration?.underline) {
    doc
      .moveTo(run.x, run.baseline + 1.2)
      .lineTo(run.x + run.width, run.baseline + 1.2)
      .lineWidth(Math.max(0.4, run.font.size / 18))
      .strokeColor(color)
      .stroke();
  }
  if (run.decoration?.strike) {
    doc
      .moveTo(run.x, run.baseline - run.font.size * 0.28)
      .lineTo(run.x + run.width, run.baseline - run.font.size * 0.28)
      .lineWidth(0.6)
      .strokeColor(color)
      .stroke();
  }
  doc.restore();
}

function drawBox(
  doc: PDFKit.PDFDocument,
  box: LayoutBox,
  images: PdfRenderOptions["images"],
): void {
  switch (box.kind) {
    case "text":
      for (const run of box.runs) drawRun(doc, run);
      return;
    case "image": {
      const media = images?.[box.mediaId];
      if (!media) {
        doc
          .save()
          .rect(box.x, box.y, box.width, box.height)
          .dash(3, { space: 3 })
          .strokeColor("#94a3b8")
          .stroke()
          .restore();
        return;
      }
      try {
        doc.image(Buffer.from(media.data, "base64"), box.x, box.y, {
          width: box.width,
          height: box.height,
        });
      } catch {
        doc
          .save()
          .rect(box.x, box.y, box.width, box.height)
          .strokeColor("#94a3b8")
          .stroke()
          .restore();
      }
      return;
    }
    case "rect": {
      doc.save();
      if (box.fill) {
        doc.rect(box.x, box.y, box.width, box.height).fill(box.fill);
      }
      const border = box.border ?? {};
      const drawSide = (
        from: [number, number],
        to: [number, number],
        side: { width: number; color?: string } | undefined,
      ) => {
        if (!side) return;
        doc
          .moveTo(from[0], from[1])
          .lineTo(to[0], to[1])
          .lineWidth(Math.max(0.25, side.width))
          .strokeColor(side.color ?? "#000000")
          .stroke();
      };
      drawSide([box.x, box.y], [box.x + box.width, box.y], border.top);
      drawSide(
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height],
        border.bottom,
      );
      drawSide([box.x, box.y], [box.x, box.y + box.height], border.left);
      drawSide(
        [box.x + box.width, box.y],
        [box.x + box.width, box.y + box.height],
        border.right,
      );
      doc.restore();
      return;
    }
    case "line":
      doc
        .save()
        .rect(box.x, box.y, box.width, Math.max(0.5, box.thickness))
        .fill(box.color)
        .restore();
      return;
    case "math":
      doc
        .save()
        .font("Times-Roman")
        .fontSize(box.font.size)
        .fillColor("#000000")
        .text(box.text, box.x, box.y + box.height * 0.2, { lineBreak: false })
        .restore();
      return;
    case "shape":
      doc.save();
      if (box.fill)
        doc.rect(box.x, box.y, box.width, box.height).fill(box.fill);
      if (box.border) {
        doc
          .rect(box.x, box.y, box.width, box.height)
          .lineWidth(box.border.width)
          .strokeColor(box.border.color ?? "#000000")
          .stroke();
      }
      doc.restore();
      return;
    default:
      return;
  }
}

/** Renders the whole document to a PDF buffer. */
export async function renderPdf(
  layout: LayoutResult,
  options: PdfRenderOptions = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const first = layout.pages[0];
      const doc = new PDFDocument({
        size: [first?.width ?? 595.28, first?.height ?? 841.89],
        margin: 0,
        autoFirstPage: false,
        info: {
          Title: options.title ?? "Document",
          Author: options.author ?? "",
          Subject: options.subject ?? "",
          Keywords: (options.keywords ?? []).join(", "),
          CreationDate: options.creationDate ?? new Date(),
        },
      });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      layout.pages.forEach((page, index) => {
        doc.addPage({ size: [page.width, page.height], margin: 0 });
        if (page.background) {
          doc.rect(0, 0, page.width, page.height).fill(page.background);
        }
        const boxes = [...page.boxes].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
        if (page.header)
          for (const box of page.header.boxes)
            drawBox(doc, box, options.images);
        for (const box of boxes) drawBox(doc, box, options.images);
        if (page.footnoteRegion)
          for (const box of page.footnoteRegion.boxes)
            drawBox(doc, box, options.images);
        if (page.footer)
          for (const box of page.footer.boxes)
            drawBox(doc, box, options.images);

        const borders = page.pageBorders;
        if (borders) {
          const inset = 18;
          doc
            .save()
            .lineWidth(1)
            .strokeColor(borders.top?.color ?? "#000000");
          if (borders.top)
            doc
              .rect(
                inset,
                inset,
                page.width - inset * 2,
                page.height - inset * 2,
              )
              .stroke();
          doc.restore();
        }
        void index;
      });

      if (layout.pages.length === 0)
        doc.addPage({ size: [595.28, 841.89], margin: 0 });
      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}
