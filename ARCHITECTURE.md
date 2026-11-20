# Architecture

## Principles

1. **One document model** (`packages/core/src/model`) is the single source of
   truth. Editor, renderer, converter, AI and MCP all read and write it.
2. **Deterministic operations.** Every mutation is a function of
   `(document, arguments)`; ids come from a persisted counter, so importing the
   same bytes yields the same document.
3. **Nothing is dropped silently.** Unsupported OOXML constructs are preserved
   verbatim in the model (`UnknownInline.raw`, `UnknownPart.xml`) and reported in
   a `CompatibilityReport`. Every conversion returns a loss list.
4. **Explicit capability detection.** Formats, layout features and AI providers
   report availability; unavailable paths return typed errors, never fake data.
5. **Separation of concerns.** Layout knows nothing about DOCX; renderers know
   nothing about the editor; the service knows nothing about HTTP or MCP.

## Packages

```
packages/core
  model/     versioned IR + operations + validation/history
  docx/      OOXML reader/writer (jszip + @xmldom/xmldom)
  formats/   other format adapters (registry + capabilities)
  layout/    pagination/line-breaking/table/float layout + AFM font metrics
  render/    HTML, SVG, PDF renderers consuming LayoutResult
  convert/   conversion engine + capability matrix + fidelity reporting
  service/   workspace, sessions, undo/redo, auditing, unified API
  ai/        provider independent assistant + deterministic review
  tools/     tool/resource/prompt registry (zod schemas → JSON Schema)
apps/web     React editor + HTTP API (server uses the same service)
apps/mcp     MCP stdio server (official TypeScript SDK)
apps/cli     `dsh-doc` CLI
```

## The document model

`DocDocument` contains: metadata (core + custom), theme, style sheet, numbering
definitions, sections, footnotes/endnotes, comments, revision records,
bookmarks, shapes (text boxes), media (base64), custom XML, settings, unknown
parts, `idSeq` and the compatibility report.

**Blocks** are `Paragraph | Table | TocBlock`. Paragraphs contain flat `Inline`
nodes (`text`, `tab`, `break`, `image`, `field`, `noteRef`, `commentRef`,
`bookmark`, `math`, `shape`, `unknown`). Hyperlinks are a _run mark_, not a
nested container, which keeps UTF-16 offsets linear and makes range editing
tractable.

**Geometry is in points** (1pt = 1/72in). The OOXML boundary converts twips/EMU;
the layout engine and renderers never see twips. This removes an entire class of
unit bugs and keeps PDF, HTML and the editor in agreement.

**Formatting is layered.** `docDefaults → paragraph style chain → character
style chain → direct formatting` (plus numbering-level paragraph properties for
list indentation). `model/styles.ts` implements this once; layout, export and
the editor all use it.

**Styles are kept, not resolved away.** The importer stores the full style sheet
(165 styles in the fixture) with `basedOn` chains, so style modification and
export preserve inheritance.

**Field results are recomputed, not trusted.** `PAGE`, `NUMPAGES`, `PAGEREF`,
`REF` and `SEQ` are resolved by the layout engine; unknown fields fall back to
their cached result so no text is lost.

## DOCX import

`docx/import.ts` + `docx/import-body.ts` + `docx/parsers.ts`:

1. Read the ZIP into a part map (path-traversal checked, OLE/encrypted detected).
2. Resolve relationships, theme, styles, numbering, settings, core/app/custom
   properties, footnotes/endnotes, comments (+`commentsExtended` resolved state).
3. Parse the body in one pass, building sections as paragraph-level `sectPr`
   markers are encountered; the trailing `sectPr` closes the last section.
   Headers/footers are resolved per section with Word's inheritance rule.
4. Parse paragraphs into inlines with a field state machine (begin/instr/
   separate/end, nested fields), run/paragraph property mapping, hyperlink
   relationship resolution, drawing/VML images (with intrinsic pixel size),
   text boxes, OMML math, tracked changes (`w:ins`/`w:del`), comments and
   bookmarks.
5. TOC fields are detected across paragraphs and converted into a generated
   `TocBlock` (the cached result is discarded because the layout engine
   recomputes page numbers).
6. Anything uninterpreted is preserved raw and reported.

## DOCX export

`docx/export.ts` writes a complete package (document, styles, numbering,
settings, theme, font table, headers/footers with per-part relationships,
footnotes/endnotes, comments + commentsExtended, media, content types, rels).
The writer is deterministic and emits unknown inline constructs verbatim.
Generated TOCs become real Word TOC fields with cached entries and `PAGEREF`
fields, and heading bookmarks are synthesized so entries are clickable.

Verified by round-trip tests: the fixture exports to ~17 KB and re-imports with
identical text, paragraph count, section geometry, header/footer content and
table dimensions.

## Layout engine

`layout/engine.ts` consumes the model and emits `LayoutPage[]` containing
absolutely positioned boxes. Text metrics come from the standard-14 AFM tables
(`layout/afm-metrics.ts`, generated from PDFKit's AFM data) so pagination is
deterministic without shipping fonts. Document fonts are mapped to metric
families (Calibri→Helvetica, Cambria→Times, Consolas→Courier) and substitutions
are reported.

Pipeline per section: compute frames from page size, margins, gutter and
columns; flow blocks; paginate.

- **Paragraphs**: tokens are words/CJK characters/tabs/atoms; greedy line
  breaking with first-line/hanging indents, tab stops, list labels, alignment
  (left/center/right/justify via word gaps), line spacing (auto/exact/atLeast),
  space before/after, keep/widow controls, paragraph borders and shading.
- **Tables**: column widths from `tblGrid` (fixed/auto), cell content layout
  (including nested tables), row heights, cell margins/borders/shading,
  horizontal `gridSpan` merges, vertical `vMerge`, header-row repetition, row
  splitting across pages with a pagination guard.
- **Images**: inline images participate in the line box; anchored images are
  positioned boxes with square wrap.
- **Text boxes**: parsed content is laid out in the shape's frame.
- **Headers/footers**: laid out in the margin regions per section variant
  (default/first/even), with field substitution per page.
- **Footnotes/endnotes**: reference markers are numbered; note text is laid out
  in a bottom region that reduces the column height.
- **TOC**: entries come from the outline; a two-pass loop resolves page numbers
  and re-paginates until stable.

Approximations are emitted as `LayoutWarning`s (for example continuous section
breaks, which are laid out as page breaks).

## Renderers

All renderers consume `LayoutResult`, guaranteeing that print preview and PDF
agree.

- `render/html.ts` — page-accurate absolutely positioned HTML (runs, borders,
  images as data URIs, print CSS, optional interaction attributes).
- `render/svg.ts` — one self-contained SVG per page.
- `render/pdf.ts` — PDFKit; draws runs with the same metrics the layout used,
  plus vector rectangles/lines and embedded images.

PDF text is drawn word-by-word at layout coordinates, so justification and
pagination match the preview exactly.

## Conversion engine

`formats/*` implement the adapter contract (`detect/import/export` +
`FormatCapabilities`). `formats/index.ts` is the registry (`importAny`,
`exportAny`, `availableFormats`). `convert/index.ts` adds the capability matrix,
runs the conversion, and computes a **fidelity report** (content preservation by
comparing text/stats before and after, structural preservation, unsupported
element list, duration).

Conversion never silently drops content: adapters record losses and unknown
elements.

## Service layer

`service/service.ts` is the unified API used by every client:

- **Sessions** hold the model, a snapshot `DocumentHistory`, dirty state, and a
  revision counter that invalidates the layout cache.
- **Workspace** stores each document twice — `document.json` (lossless model:
  ids, comments, revisions) and `document.docx` (interoperability) — plus
  `record.json` and an `audit.log`. Paths are confined to the workspace;
  ids must match `[A-Za-z0-9_-]{1,64}`.
- **Operations** are deterministic model functions followed by a history push
  and an audit entry (content is never logged, only sizes and codes).
- **Optional modules** (formats/convert/AI) are loaded dynamically; if absent,
  the service returns a typed `*_UNAVAILABLE` error instead of pretending.

## MCP server

`tools/registry.ts` defines all 53 tools once with zod schemas. The MCP server
maps each descriptor to `McpServer.registerTool`, resources to
`registerResource` (static + templates), and prompts to `registerPrompt` using
the official `@modelcontextprotocol/sdk`. `apps/mcp/src/write-manifest.ts` emits
`dist/tools.json` (JSON Schema) used by CI validation and by native agent tool
loaders. `tools/resources.ts` also exposes OpenAI-style function definitions, so
the same registry feeds frameworks that use native tool calling.

## AI assistant

`ai/` is provider independent: `AiProvider` with OpenAI-compatible, Ollama and
offline heuristic implementations. The assistant builds bounded document
context, marks it explicitly as untrusted data, and returns **structured
operations** (`tool` + `args` + summary) with before/after previews. It never
applies changes; the caller applies them through the same editing tools, so undo,
audit and formatting preservation behave exactly like manual edits. Summarise
and review work without a provider; generative operations return
`AI_PROVIDER_REQUIRED` when none is configured.

## Packaging and agent integrations

**DeepSeek Harness bundle.** `dsh-plugin/` is the source of a separate,
self-contained bundle repository. `tools/build-dsh-plugin.mjs`:

1. takes the compiled `packages/core/dist/dsh-entry.js` (service + tool registry
   - AI helpers),
2. bundles it, and every dependency, into one `engine.js` with esbuild,
3. rewrites PDFKit's generated standard-font loader table so its
   `#standard-fonts/*` package-import specifiers resolve to inlined font data
   instead of requiring a package context the bundle does not have,
4. copies the Host half (`index.js`), the Client half (`client.js`), the patch,
   locales, icon and detail document into `dist/dsh-plugin/`.

`tools/check-dsh-plugin.mjs` then validates the manifest, display metadata, the
client identity, registers the Host plugin against a mock Cordis context, and
runs a create → read → PDF round trip. The published repository is build-free:
installing it from a GitHub link downloads `engine.js` and nothing else, with no
install scripts and no dependency graph.

The Host half registers 17 `document_*` tools on `ctx.tools` and, when
`webServer` exists, a same-origin `/api/dsh-documents` route family used by the
Client half. The Client half registers a `sidebar.panellist` icon and a `main`
panel keyed `dsh-documents`, both verified live through the Slot inspector.

**Other agents.** `integrations/` holds a Claude Code plugin (manifest,
marketplace, `.mcp.json`, 12 skills, 3 slash commands), a Codex `config.toml`
plus idempotent installer, an Antigravity MCP config, and an OpenCode config
with an optional tool plugin. Every route launches the same
`apps/mcp/dist/main.js`; the shared `resolve-repo.mjs` refuses to start without a
built server and prints the exact build command.

## Security model

- Workspace-confined paths with explicit allowed read roots; traversal rejected.
- Document ids validated; stored files never resolved from user strings.
- ZIP entries are checked for absolute paths and `..`.
- XML parsing never resolves external entities; no network calls during parsing.
- Macros, ActiveX, OLE and embedded scripts are never executed; they are
  preserved and reported.
- Read-only mode disables every mutation.
- Audit log for mutating operations (MCP and service).
- Document content is untrusted data for AI prompts; prompt-injection text is
  treated as document content and tool proposals are name-allowlisted.

## Versioning and compatibility

`DOCUMENT_SCHEMA_VERSION` is `1.0.0`. `model/validate.ts` migrates older payloads
and rejects newer majors. The compatibility report records source format,
features with occurrence counts and support levels, losses and unknown
elements, plus `transparent: true` only when nothing was dropped.

## Performance

- Layout is linear in content with a pagination guard for tables; results are
  cached per session revision.
- The editor applies model operations and re-renders only affected blocks.
- Images are lazy `<img>` loads in the browser; PDF rendering streams pages.
- Export/import are single-pass over the ZIP parts.
- Known limit: layout of very large documents (thousands of pages) is currently
  a full pass; incremental pagination is future work (see FEATURES.md).
