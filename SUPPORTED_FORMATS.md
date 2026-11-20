# Supported formats

The engine has a modular adapter registry (`packages/core/src/formats`). Every
adapter declares a capability profile; the conversion engine
(`packages/core/src/convert`) computes fidelity from those profiles and a
round-trip text comparison, and returns a loss report for every conversion.

`document_list_formats` (MCP), `GET /api/formats` and
`formats.availableFormats()` report the same matrix at runtime.

## Import / export matrix

| Format                      | Extensions               | Import              | Export                 | Fidelity notes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------ | ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOCX** (WordprocessingML) | docx, dotx, docm         | ✅ full             | ✅ full                | Styles, numbering, tables, sections, headers/footers, fields, footnotes/endnotes, comments, tracked changes, images, text boxes, equations, TOC. Round-trip tested against the golden fixture. DOCM macros are preserved verbatim and never executed.                                                                                                                                                                                                      |
| **ODT** (OpenDocument Text) | odt, ott                 | ✅                  | ✅                     | Headings, paragraphs, character formatting, lists, tables (spans), images, hyperlinks, styles, metadata. Headers/footers, tracked changes and math are not mapped (reported).                                                                                                                                                                                                                                                                              |
| **RTF**                     | rtf                      | ✅                  | ✅                     | Font/colour tables, bold/italic/underline/strike, super/subscript, alignment, indents, spacing, page breaks, basic tables. Images, headers/footers, comments and revisions are lost (reported).                                                                                                                                                                                                                                                            |
| **HTML / XHTML**            | html, htm, xhtml         | ✅                  | ✅                     | Headings, paragraphs, inline formatting, CSS colours/sizes, lists, tables (colspan/rowspan), links, data-URI images, comments/tracked-change markers, footnotes. Page layout is approximate.                                                                                                                                                                                                                                                               |
| **Markdown**                | md, markdown, mdown, mkd | ✅                  | ✅                     | CommonMark + GFM: headings, emphasis, lists, blockquotes, fenced code, GFM tables, links, images (remote URLs preserved as links, not fetched). Page layout and comments are not representable.                                                                                                                                                                                                                                                            |
| **Plain text**              | txt, text, log           | ✅                  | ✅                     | Text order only; paragraph breaks preserved, page breaks as form feeds.                                                                                                                                                                                                                                                                                                                                                                                    |
| **Legacy Word**             | doc, dot                 | ✅ import only      | ✖                      | Real CFB (Compound File) reader + WordDocument FIB/piece-table text extraction. **Text only**; formatting, tables, images and layout are reported as lost.                                                                                                                                                                                                                                                                                                 |
| **Excel**                   | xlsx, xlsm, xltx, xltm   | ✅ preview only     | ✖                      | One heading + table per sheet, cached values (formulas show their cached result). Charts/images are not rendered; a preview marker and a compatibility report are attached. Editing a spreadsheet is explicitly out of scope.                                                                                                                                                                                                                              |
| **PowerPoint**              | pptx, pptm, potx, potm   | ✅ preview only     | ✖                      | Each slide becomes a section with a heading; text frames and tables are extracted. Shapes/charts/animations are not rendered.                                                                                                                                                                                                                                                                                                                              |
| **Apple Pages**             | pages                    | ✅ import only      | ✖                      | Pages '09 (`index.xml`): paragraph text, empty paragraphs, span/line-break text and headings only when a style name or outline level says so; unknown elements are reported as losses. Modern Pages (2013+, `Index/*.iwa`): **text-recovery preview only** — raw Snappy frames are decoded and protobuf strings scanned generically; structure, styles, tables, images and layout are **not** recovered (`metadata.custom.DSHPreview="true"` plus losses). |
| **Google Docs pointer**     | gdoc                     | ✖ no document body  | ✖                      | A `.gdoc` file is a tiny JSON pointer into Google Drive (`doc_id`, `resource_id`, `email`), not a document. Import performs **no network access** and fails with `FORMAT_EXTERNAL_REQUIRED`; open the file in Google Docs, download it as `.docx` and import that.                                                                                                                                                                                         |
| **PDF**                     | pdf                      | ✖ **not supported** | ✅ (via layout engine) | PDF export renders real pages from the layout engine. PDF import is intentionally not implemented: reliable PDF text/layout recovery is a different problem and would risk silently mangling documents.                                                                                                                                                                                                                                                    |

`XLS` and `PPT` (legacy binary Office formats) are **not** supported for
import; the CFB reader is currently used only for legacy `.doc`. They are
listed as unavailable in the capability matrix rather than silently rejected.

`.pages` and `.gdoc` are **import-only sources**: there is no Pages exporter,
and the Google Docs pointer never yields document content offline. `exportAny`
rejects both with `FORMAT_EXPORT_UNSUPPORTED` instead of producing a DOCX.

## Optional LibreOffice engine

**LibreOffice is the default conversion and PDF engine when it is installed.**
Editing stays model-first (the IR, layout and DOCX exporter are ours); only
conversion and PDF rendering route through LibreOffice. The service preference
is `engine: "auto"` by default, which means _LibreOffice-first with automatic
fallback_, so an installation without LibreOffice keeps working exactly as
before. `DSH_DOC_ENGINE=internal` forces the built-in paths, and the
`document_set_engine` tool changes the preference at runtime.

Routing is measured per call, not assumed:

| Target                            | Engine      | Why                                                        |
| --------------------------------- | ----------- | ---------------------------------------------------------- |
| PDF                               | LibreOffice | real Word pagination; internal renderer as fallback        |
| DOCX                              | LibreOffice | round-trips the model DOCX with equal text                 |
| ODT                               | LibreOffice | equal text, richer structure                               |
| RTF / HTML                        | internal    | LibreOffice lost text on the fixture (`text-loss`)         |
| TXT                               | internal    | LibreOffice's text filter is no better (`internal-format`) |
| Markdown / DOTX / DOCM / previews | internal    | not in LibreOffice's writer filter table                   |

Every result reports the engine used, the preference, and a typed
`fallbackReason`, so nothing pretends. On this machine (LibreOffice 26.8.3.1)
DOCX→PDF through the default path is a real 9-page PDF; a fresh profile costs
~4 s and the reusable profile makes later conversions ~1.8 s. When LibreOffice
is absent every path fails over to the internal engine with
`engine-unavailable` — the `document_engine_status` tool shows the detection
evidence (candidate paths, version, preference, last route).

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
round-trips. Pages is an import-only source, so `.pages` input is projected
into the model and can then be exported to any writable format (with the text
losses above). A `.gdoc` pointer has **no** conversion path: it fails with
`FORMAT_EXTERNAL_REQUIRED` before anything is written.

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
- **`.gdoc` pointer files are recognised, not imported.** A `.gdoc` file is a
  JSON pointer into Google Drive; the adapter validates its shape and fails
  with the typed `FORMAT_EXTERNAL_REQUIRED` error explaining that the user must
  open the document in Google Docs and download it as `.docx`. Nothing is
  fetched, and no bytes are guessed or treated as text.
- **Native Google Docs API integration is not implemented.** There is no OAuth
  client, Drive API call or Docs API document editing in this repository, and
  the product does not claim native Google Docs editing. Adding it requires
  credentials and the official `googleapis` client; the adapter contract in
  `packages/core/src/formats/types.ts` is the extension point.

## Apple Pages limitations

- **Read-only.** Pages packages are never written back; there is no exporter.
- **Pages '09 (`index.xml`)** is parsed as XML (no external entity resolution).
  Paragraphs come from `<sf:p>` in document order, span text is concatenated,
  `<sf:br>`/`<sf:lnbr>` become line breaks and `<sf:tab>` becomes a tab.
  Headings are mapped only from a discoverable style name or outline level;
  every unrecognised element is reported as a loss and recorded on the document
  (`unknown[]`) rather than dropped.
- **Modern Pages (2013+, IWA)** is a **text-recovery preview**, not a document
  conversion. The adapter decodes 4-byte IWA frames (control byte `0x00` =
  Snappy block, `0x01` = uncompressed), decompresses Snappy with 1/2/4-byte
  copy offsets, and scans the protobuf wire format generically (bounded depth)
  for length-delimited strings that look like prose. It filters iWork
  metadata/font/type identifiers and control-byte payloads, preserves
  first-seen order across `Index/*.iwa` files (sorted by path, frames in file
  order) and skips consecutive duplicates. **Structure, styles, tables,
  images, page layout, headers/footers and text frames are not recovered**;
  they are listed as losses, `compatibility.transparent` is `false`, and
  `metadata.custom.DSHPreview` is `"true"` so callers can see the result is a
  preview.
- **Nothing is guessed from layout.** Text that happens to look like a heading
  is not promoted without a style name or outline level behind it.
