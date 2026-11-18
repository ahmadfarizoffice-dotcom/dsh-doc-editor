# Supported formats

The engine has a modular adapter registry (`packages/core/src/formats`). Every
adapter declares a capability profile; the conversion engine
(`packages/core/src/convert`) computes fidelity from those profiles and a
round-trip text comparison, and returns a loss report for every conversion.

`document_list_formats` (MCP), `GET /api/formats` and
`formats.availableFormats()` report the same matrix at runtime.

## Import / export matrix

| Format                      | Extensions               | Import              | Export                 | Fidelity notes                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------ | ------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOCX** (WordprocessingML) | docx, dotx, docm         | ✅ full             | ✅ full                | Styles, numbering, tables, sections, headers/footers, fields, footnotes/endnotes, comments, tracked changes, images, text boxes, equations, TOC. Round-trip tested against the golden fixture. DOCM macros are preserved verbatim and never executed. |
| **ODT** (OpenDocument Text) | odt, ott                 | ✅                  | ✅                     | Headings, paragraphs, character formatting, lists, tables (spans), images, hyperlinks, styles, metadata. Headers/footers, tracked changes and math are not mapped (reported).                                                                         |
| **RTF**                     | rtf                      | ✅                  | ✅                     | Font/colour tables, bold/italic/underline/strike, super/subscript, alignment, indents, spacing, page breaks, basic tables. Images, headers/footers, comments and revisions are lost (reported).                                                       |
| **HTML / XHTML**            | html, htm, xhtml         | ✅                  | ✅                     | Headings, paragraphs, inline formatting, CSS colours/sizes, lists, tables (colspan/rowspan), links, data-URI images, comments/tracked-change markers, footnotes. Page layout is approximate.                                                          |
| **Markdown**                | md, markdown, mdown, mkd | ✅                  | ✅                     | CommonMark + GFM: headings, emphasis, lists, blockquotes, fenced code, GFM tables, links, images (remote URLs preserved as links, not fetched). Page layout and comments are not representable.                                                       |
| **Plain text**              | txt, text, log           | ✅                  | ✅                     | Text order only; paragraph breaks preserved, page breaks as form feeds.                                                                                                                                                                               |
| **Legacy Word**             | doc, dot                 | ✅ import only      | ✖                      | Real CFB (Compound File) reader + WordDocument FIB/piece-table text extraction. **Text only**; formatting, tables, images and layout are reported as lost.                                                                                            |
| **Excel**                   | xlsx, xlsm, xltx, xltm   | ✅ preview only     | ✖                      | One heading + table per sheet, cached values (formulas show their cached result). Charts/images are not rendered; a preview marker and a compatibility report are attached. Editing a spreadsheet is explicitly out of scope.                         |
| **PowerPoint**              | pptx, pptm, potx, potm   | ✅ preview only     | ✖                      | Each slide becomes a section with a heading; text frames and tables are extracted. Shapes/charts/animations are not rendered.                                                                                                                         |
| **PDF**                     | pdf                      | ✖ **not supported** | ✅ (via layout engine) | PDF export renders real pages from the layout engine. PDF import is intentionally not implemented: reliable PDF text/layout recovery is a different problem and would risk silently mangling documents.                                               |

`XLS` and `PPT` (legacy binary Office formats) are **not** supported for
import; the CFB reader is currently used only for legacy `.doc`. They are
listed as unavailable in the capability matrix rather than silently rejected.

## Conversion pairs

The engine supports every pair where both sides have an adapter, and refuses
others with a typed `CONVERSION_UNSUPPORTED` error. Fidelity is declared per
pair and refined by the measured round trip.

### Required pairs from the brief

| Conversion      | Fidelity   | What is preserved                                                      |
| --------------- | ---------- | ---------------------------------------------------------------------- |
| DOCX → HTML     | high       | Text, styles→CSS, tables, links, images, comments/revision markers     |
| DOCX → PDF      | high       | Pagination, headers/footers, tables, images, notes, TOC (via renderer) |
| DOCX → ODT      | high       | Text, styles, lists, tables, images, metadata                          |
| ODT → DOCX      | high       | Text, styles, lists, tables, images, metadata                          |
| RTF → DOCX      | low–medium | Text, character formatting, alignment, basic tables                    |
| HTML → DOCX     | medium     | Structure, inline formatting, tables, links, data-URI images           |
| Markdown → DOCX | medium     | Headings, lists, GFM tables, emphasis, links                           |
| DOC → DOCX      | low        | Extracted text only (explicit losses)                                  |
| DOCX → Markdown | medium     | Structure, lists, GFM tables, links, emphasis                          |
| DOCX → TXT      | low        | Text order only                                                        |

Additional supported pairs include ODT→HTML/PDF/Markdown/RTF/TXT,
HTML→Markdown/ODT/PDF/RTF/TXT, Markdown→HTML/ODT/PDF/RTF/TXT,
preview formats → DOCX/HTML/PDF/Markdown/ODT/RTF/TXT, and same-format
round-trips.

### Loss reporting

`ConversionResult` contains:

- `losses`: per-feature level (`full`/`partial`/`fallback`/`unsupported`),
  reason and location, always including constructs the target cannot represent;
- `report`: content preservation (measured by re-importing the produced bytes
  and comparing normalized text when the target can be imported, otherwise a
  documented loss penalty), structural preservation, unsupported element list,
  method used, duration;
- `warnings`: adapter-level notes.

Nothing is silently dropped: text that cannot be represented is either mapped
to a simpler construct or reported.

## Google Docs interoperability

- **DOCX import/export is the supported path.** Google Docs accepts and
  produces DOCX, and our DOCX adapter is the highest-fidelity one.
- **HTML interoperability** is supported through the HTML adapter.
- **Native Google Docs API integration is not implemented.** There is no OAuth
  client, Drive API call or Docs API document editing in this repository, and
  the product does not claim native Google Docs editing. Adding it requires
  credentials and the official `googleapis` client; the adapter contract in
  `packages/core/src/formats/types.ts` is the extension point.
