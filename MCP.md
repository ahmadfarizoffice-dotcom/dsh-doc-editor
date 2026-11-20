# MCP server

`apps/mcp` implements the Model Context Protocol over **stdio** using the
official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32, protocol revision
negotiated by the SDK) and `McpServer.registerTool/registerResource/registerPrompt`.

```bash
pnpm run build
node apps/mcp/dist/main.js          # stdio
```

The server is independent of the web UI: it owns its own `DocumentService`
instance, workspace and audit log.

- Tool manifest: `apps/mcp/dist/tools.json` (JSON Schema, written by the build)
- Server instructions: returned in the MCP `initialize` result

## Connecting a client

`claude_desktop_config.json` / `mcp.json` (Claude Desktop, Claude Code, Cursor,
Windsurf, …):

```json
{
  "mcpServers": {
    "dsh-doc": {
      "command": "node",
      "args": ["/abs/path/dsh-doc-editor/apps/mcp/dist/main.js"],
      "env": {
        "DSH_DOC_WORKSPACE": "/abs/path/document-workspace",
        "DSH_DOC_READ_ONLY": "0"
      }
    }
  }
}
```

Generic SDK client:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client(
  { name: "my-agent", version: "1.0.0" },
  { capabilities: {} },
);
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["/abs/path/dsh-doc-editor/apps/mcp/dist/main.js"],
    env: { ...process.env, DSH_DOC_WORKSPACE: "/abs/path/document-workspace" },
  }),
);

const tools = await client.listTools();
const created = await client.callTool({
  name: "document_create",
  arguments: { title: "Report" },
});
```

Every tool returns a JSON envelope in a text content block:

```json
{ "ok": true, "data": { } }
{ "ok": false, "error": { "code": "DOCUMENT_NOT_OPEN", "message": "…", "details": {} } }
```

with `isError: true` on failures.

## Tools (52)

### Lifecycle

| Tool                    | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `document_create`       | New document (title, author, page size, orientation, initial paragraphs) |
| `document_open`         | Import from an allowed path, returns id + model + compatibility          |
| `document_save`         | Persist DOCX + lossless model snapshot (optional explicit path)          |
| `document_save_as`      | Write to a new path/format                                               |
| `document_close`        | Close session; refuses unsaved changes unless `discardUnsaved`           |
| `document_get_metadata` | Core/custom metadata, stats, compatibility, layout warnings              |
| `document_list_formats` | Import/export capability matrix for this build                           |

### Reading

| Tool                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `document_get_content`   | Sections + typed blocks (id, style, text, list label, table geometry) |
| `document_get_outline`   | Heading outline (level, text, block id, section)                      |
| `document_get_text`      | Plain text (+ optional block range, word/character counts)            |
| `document_get_selection` | Text and block ids for a range                                        |
| `document_get_page_info` | Page count and the rendered page containing a block                   |
| `document_search`        | Literal/regex search with context and optional page numbers           |

### Editing

| Tool                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `document_insert_text`          | Insert at a position; newlines create paragraphs         |
| `document_replace_text`         | Replace a range, preserving surrounding formatting       |
| `document_delete_range`         | Delete a range (tracked when enabled)                    |
| `document_format_text`          | Character formatting over a range                        |
| `document_format_paragraph`     | Alignment, spacing, indents, keep/widow, shading         |
| `document_apply_style`          | Apply a named paragraph style                            |
| `document_insert_heading`       | Insert Heading 1–9                                       |
| `document_insert_list`          | Bullet/numbered list with nesting and restart            |
| `document_insert_table`         | Table with data and repeating header row                 |
| `document_edit_table`           | Row/column insert/delete, merge, split, delete table     |
| `document_insert_image`         | Image from workspace path or base64 (inline or floating) |
| `document_insert_hyperlink`     | External URL or internal bookmark anchor                 |
| `document_insert_page_break`    | Page/line/column break                                   |
| `document_insert_section_break` | Split section, optional landscape                        |
| `document_edit_header`          | Section header text (PAGE/NUMPAGES resolved)             |
| `document_edit_footer`          | Section footer text                                      |

### Advanced

| Tool                              | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `document_add_comment`            | Anchored review comment                                  |
| `document_track_change`           | Enable/disable tracked changes                           |
| `document_accept_change`          | Accept one revision or all                               |
| `document_reject_change`          | Reject one revision or all                               |
| `document_insert_footnote`        | Footnote or endnote                                      |
| `document_insert_toc`             | Generated TOC with engine-computed page numbers          |
| `document_insert_equation`        | TeX-like linear math → OMML                              |
| `document_compare`                | Paragraph LCS diff + word diffs + metadata/style changes |
| `document_get_revision_history`   | Session history + pending tracked changes                |
| `document_undo` / `document_redo` | Snapshot undo/redo                                       |

### Conversion

| Tool                        | Purpose                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `document_convert`          | Convert open document (or path) to a target format                                                       |
| `document_export_pdf`       | Layout engine → PDF (returns page count)                                                                 |
| `document_import`           | Import any supported format                                                                              |
| `document_export`           | Export to docx/dotx/docm/pdf/html/md/txt/odt/rtf                                                         |
| `document_engine_status`    | Optional external engine (LibreOffice) detection, version and capability matrix                          |
| `document_convert_external` | Convert through LibreOffice when installed; typed `ENGINE_UNAVAILABLE` with detection evidence otherwise |

### AI

| Tool                           | Requires provider                   | Purpose                                                                                                                            |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `document_ai_summarize`        | no (extractive) / yes (abstractive) | Summary of document or range                                                                                                       |
| `document_ai_review`           | no                                  | Mechanical checks (spelling list, repeated words, double spaces, missing spaces, long sentences, mixed date formats, placeholders) |
| `document_ai_rewrite`          | yes                                 | Proposed rewrite + before/after                                                                                                    |
| `document_ai_translate`        | yes                                 | Proposed translation + before/after                                                                                                |
| `document_ai_generate_content` | yes                                 | Proposed new content + insert operation                                                                                            |
| `document_ai_suggest_edits`    | yes                                 | Up to N validated structured operations                                                                                            |

AI tools **return proposals**; they never mutate the document. Apply them with
the matching editing tool so undo/audit/formatting behave normally.

## Resources

| URI                                     | Content                                        |
| --------------------------------------- | ---------------------------------------------- |
| `dshdoc://documents`                    | Open documents and dirty state                 |
| `dshdoc://formats`                      | Format capability matrix                       |
| `dshdoc://documents/{id}/metadata`      | Metadata, stats, compatibility                 |
| `dshdoc://documents/{id}/outline`       | Outline JSON                                   |
| `dshdoc://documents/{id}/content`       | Structured content JSON                        |
| `dshdoc://documents/{id}/text`          | Plain text                                     |
| `dshdoc://documents/{id}/revisions`     | History + pending changes                      |
| `dshdoc://documents/{id}/compatibility` | Compatibility + validation + feature inventory |

## Prompts

`summarize_document`, `review_document`, `proofread_document`,
`rewrite_document`, `translate_document`, `generate_document`,
`compare_documents`, `format_document`.

Each prompt injects a safety preamble stating that document text is untrusted
data, and names the tools the agent should use.

## Security

| Control                        | Implementation                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Workspace confinement          | All writes under `DSH_DOC_WORKSPACE`; ids validated                                |
| Path traversal                 | Rejected (relative-path and absolute-escape checks; ZIP entries checked)           |
| File access restriction        | Reads only from workspace + `DSH_DOC_ALLOWED_ROOTS`                                |
| Input validation               | zod schemas per tool, enforced by the SDK before the handler                       |
| Read-only mode                 | `DSH_DOC_READ_ONLY=1` blocks every mutation                                        |
| Audit logging                  | JSON Lines at `DSH_DOC_AUDIT_LOG`; no document text, only action/tool/outcome/size |
| Destructive confirmation       | `destructiveHint` annotations; AI never auto-applies                               |
| No shell execution             | No child processes anywhere in the service                                         |
| No arbitrary filesystem access | Path resolution is centralised in `Workspace`                                      |
| Macros                         | Never executed; preserved in DOCM                                                  |
| Prompt injection               | Document content delimited as data; AI operations name-allowlisted                 |

## Error codes

| Code                                                                | Meaning / recovery                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DOCUMENT_NOT_OPEN`                                                 | Call `document_open`/`document_create` first; `details.openDocuments` lists open ids |
| `DOCUMENT_NOT_FOUND`                                                | The workspace has no such document                                                   |
| `BLOCK_NOT_FOUND` / `SECTION_NOT_FOUND` / `TABLE_NOT_FOUND`         | Re-read `document_get_content` and use current ids                                   |
| `INVALID_DOCUMENT_ID` / `PATH_TRAVERSAL` / `PATH_OUTSIDE_WORKSPACE` | Path is not permitted; use a workspace-relative path                                 |
| `READ_ONLY_MODE`                                                    | Workspace is read-only; unset `DSH_DOC_READ_ONLY`                                    |
| `FILE_NOT_FOUND` / `FILE_TOO_LARGE`                                 | Path missing or over the import limit                                                |
| `FORMAT_UNAVAILABLE` / `CONVERSION_UNAVAILABLE`                     | This build has no adapter for that format                                            |
| `AI_PROVIDER_REQUIRED` / `AI_NOT_CONFIGURED` / `AI_REQUEST_FAILED`  | Configure a provider or use `document_ai_review`/`document_ai_summarize`             |
| `UNSAVED_CHANGES`                                                   | Save or pass `discardUnsaved`                                                        |
| `NOTHING_TO_UNDO` / `NOTHING_TO_REDO`                               | History exhausted                                                                    |
| `TOOL_EXECUTION_FAILED`                                             | Unexpected error; message contains the cause                                         |

## Configuration

See [`.env.example`](.env.example) and [README.md](README.md#configuration).
