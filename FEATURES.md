# Feature inventory

Status legend: **✅ implemented** (model + engine + UI/API wired and tested),
**◐ partial** (implemented with documented fidelity limits), **✖ not
implemented** (explicitly reported, with a workaround where one exists).

Every "✅" below means the operation exists in the shared model and is reachable
through the service (and therefore the editor, CLI and MCP). Toolbar-only or
mock functionality is not listed as implemented.

## 4.1 Basic editing

| Feature                            | Status | Notes / entry point                                                              |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Create document                    | ✅     | `document_create`, editor "New"                                                  |
| Open document                      | ✅     | `document_open`; DOCX/DOTX/DOCM built in, other formats via adapters             |
| Save / Save As                     | ✅     | `document_save`, `document_save_as`; writes DOCX + lossless model snapshot       |
| Rename / duplicate / delete        | ✅     | workspace API (`PUT /api/documents/:id`, `deleteDocument`), editor document list |
| Undo / redo                        | ✅     | snapshot history in the session; `document_undo`, `document_redo`                |
| Cut / copy / paste                 | ✅     | editor clipboard handling routed through model operations                        |
| Select all                         | ✅     | editor `Ctrl+A`                                                                  |
| Find and replace                   | ✅     | `document_search` + editor dialog (replace / replace all)                        |
| Word / character / paragraph count | ✅     | `documentStats`, status bar, `document_get_metadata`                             |
| Autosave                           | ✅     | editor idle autosave to localStorage + server save                               |
| Dirty-state detection              | ✅     | session flag, editor badge, unsaved-change guard on close                        |
| Document recovery                  | ✅     | localStorage snapshot restored on load                                           |
| Keyboard shortcuts                 | ✅     | save, undo/redo, bold/italic/underline, find, print preview                      |
| Multi-page editing                 | ✅     | editable surface + paginated preview from the layout engine                      |

## 4.2 Text formatting

Font family, size, bold, italic, underline, strikethrough, superscript,
subscript, colour, highlight, background, clear formatting, character spacing,
caps/small caps, text-case transforms — **✅** (`document_format_text`, toolbar).
Char scale (`w:w`) and kerning are imported/exported but not visually applied
(◐; reported as metrics-only).

## 4.3 Paragraph formatting

Left/center/right/justify, line spacing (auto/exact/atLeast), space
before/after, first-line and hanging indents, left/right indents, tab stops,
paragraph borders, paragraph background, keep-with-next, keep-lines,
widow/orphan control — **✅** (`document_format_paragraph`).
Custom tab stops support left/center/right/decimal/bar with leaders; absolute
position tabs collapse to a tab stop (◐).

## 4.4 Styles and structure

Normal, Title, Subtitle, Heading 1–9, custom styles, style inheritance, modify
styles, apply styles, navigation pane, document outline, automatic TOC, section
management — **✅**. Styles are imported as a full sheet with `basedOn` chains
and exported unchanged; the editor offers the style gallery plus "modify style"
through the service. The TOC is a generated block recomputed by layout and
exported as a real Word TOC field. Sections support page size/orientation,
margins, page borders, background, columns and break types.

## 4.5 Lists

Bulleted, numbered, multilevel, nested, custom numbering definitions, restart
(`startAt`), continue (`setListNumbering(...,"continue")`), list indentation,
custom bullet glyphs — **✅** (`numbering.ts`, `document_insert_list`).
Picture bullets are preserved (`lvlPicBulletId`) but rendered as text bullets
(◐).

## 4.6 Tables

Insert/delete tables, add/remove rows and columns, merge cells, split cells,
cell alignment, cell background, borders, table dimensions, column widths, row
heights, table positioning (floating tables parsed and preserved), header rows,
repeat header rows, table pagination, nested tables, text wrapping in cells —
**✅** (`document_insert_table`, `document_edit_table`, layout engine).
Vertical merges are laid out as a spanning cell per row with empty continuation
cells (◐; vertical text centring across the merged height is approximated).

## 4.7 Images and media

Insert, resize (aspect-ratio preserving), crop (`a:srcRect` preserved), aspect
ratio, image alignment, text wrap (square), inline images, floating images,
positioning (anchor offsets/alignments), image borders, alternative text,
replacement (`replaceImage` in the model) — **✅** with these limits:
tight/through wrapping behaves as square (◐); VML images are converted with
CSS-derived geometry (◐); SVG/EMF/WMF render only where the browser/PDF can
decode them (fallback box + alt text).

## 4.8 Page layout

Page size (A3–Legal presets + custom), portrait/landscape, margins, page
borders, page colour, page breaks, section breaks, multiple columns, column
breaks, headers, footers, page numbering (PAGE/NUMPAGES), different first page,
different odd/even headers, section-specific page numbering — **✅**.
Notes: `PAGE` renders; `pgNumType` formats (roman/letters) are preserved and
exported but the preview shows decimal display numbers (◐). Continuous section
breaks are laid out as page breaks with an explicit warning (◐).

## 4.9 References and advanced elements

Footnotes, endnotes, hyperlinks (external + bookmark anchors), bookmarks,
cross-references (`REF`/`PAGEREF` fields resolved by layout), captions,
figure/table numbering (`SEQ` field counters), automatic TOC, equations
(OMML subset: fractions, scripts, radicals, delimiters, n-ary, bars, accents,
matrices, functions), mathematical symbols, Unicode and special characters,
text boxes, shapes (preserved + rendered as text boxes/rectangles) — **✅**
(equations ◐ for unsupported OMML constructs, which fall back to linear text).
Citations/bibliography and charts/SmartArt have no native rendering: charts and
SmartArt are preserved and rendered as labelled placeholders (✖ native render,
reported in the compatibility report). Embedded OLE objects are preserved and
placeholdered; macros are preserved in DOCM and never executed.

## 4.10 Review and collaboration

Comments (threaded replies, resolve, delete, jump-to-anchor), tracked changes
(insert/delete/format marks, accept/reject one or all, author/date), revision
history, document compare (paragraph LCS + word diffs + metadata/style changes)
— **✅**. Author attribution is stored per revision and comment.
Version history is session-scoped (snapshot list; restore by id) — durable
history between sessions is not persisted (◐). Document protection and read-only
mode: read-only is enforced by the workspace/service (✅); password-based
protection is not implemented (✖). Real-time collaborative editing is not
implemented; the service is single-writer with explicit save (✖, documented).

## 4.11 Document metadata

Title, subject, author, keywords, created/modified, revision, custom properties
— **✅** (`document_get_metadata`, `docProps/custom.xml` on export).
`lastModifiedBy` is updated on save; timestamps can be preserved on export.

## 5. Renderer

Accurate page dimensions and pagination, font substitution with reporting,
paragraph layout, table layout, image positioning, text wrapping, headers and
footers, section-specific layouts, page numbering, footnotes/endnotes,
hyperlinks, Unicode, RTL detection and per-paragraph direction, mixed-language
documents, print preview, page navigation, zoom, continuous and paginated views
— **✅** (HTML/SVG/PDF; editor preview with zoom, page navigation and print).
Limits: RTL is applied as paragraph/run direction without full bidi reordering
(◐); hyphenation is not applied automatically (✖, flag reserved); font
substitution uses standard-14 metrics for all families (◐, reported).

## 6. Conversion engine

Independent of the UI, with a capability matrix and loss reporting; all required
pairs are wired where an adapter exists. See
[SUPPORTED_FORMATS.md](SUPPORTED_FORMATS.md) for the exact matrix and fidelity.

## 7. Ask AI

Ask / Suggest / Edit modes, document context, selection context, structured
operations with before/after previews, operation summary, undo, and the safety
rules from the brief — **✅**. Capabilities that need a language model
(rewrite, translate, generate content, suggest edits) return
`AI_PROVIDER_REQUIRED` when no provider is configured; summarisation
(extractive) and mechanical review work offline. The assistant never applies
changes itself and never replaces HTML.

## 8. MCP server

50 tools, 8 resources, 8 prompts, typed zod schemas, JSON Schema manifest,
workspace confinement, read-only mode, audit logging, destructive-operation
annotations — **✅** (see [MCP.md](MCP.md)).

## 9. Agent tools and skills

JSON-Schema tool definitions derived from the same registry, 12 skills with
routing and safety guidance — **✅** (see [AGENT_SKILLS.md](AGENT_SKILLS.md)).

## 11. Testing

Fixture import/structure/pagination/render/round-trip, MCP protocol, edit ops,
format adapters, editor selection/ops, conversion pairs — see
[TESTING.md](TESTING.md) for the executed suites and the coverage matrix.

## Known limitations (summary)

1. **PDF import is not supported.** PDF export is. Use the source DOCX/ODT for
   editing; PDFs are for distribution.
2. **Google Drive / Google Docs API integration is not implemented.** Google
   Docs interoperability is achieved by importing/exporting DOCX and HTML.
3. Charts, SmartArt, embedded OLE and VML shapes are preserved and placeholdered,
   not natively rendered.
4. Continuous section breaks render as page breaks (warned).
5. Automatic hyphenation, kerning and ligatures are not applied.
6. Vertical cell merges and tight/through text wrap are approximated.
7. Collaborative real-time editing and password-based document protection are
   not implemented.
8. Very large documents are paginated in a single pass; incremental pagination
   is future work.
9. Legacy `.doc`, RTF, ODT, spreadsheet and presentation adapters are
   best-effort importers/exporters; the per-format fidelity and loss reporting is
   in [SUPPORTED_FORMATS.md](SUPPORTED_FORMATS.md).
