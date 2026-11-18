# @dsh-doc/web

Browser word processor and HTTP host for the document platform. The React app
edits the shared `DocDocument` model directly: the `contenteditable` surface is
a projection of the model, and every user intent is translated into a
deterministic model operation (`@dsh-doc/core/model`) before the DOM is
re-rendered and the caret restored from the model selection.

## Commands

```bash
# from the repo root, after `pnpm install`
pnpm --filter @dsh-doc/web dev          # Vite dev server (proxies /api to :4317)
pnpm --filter @dsh-doc/web build        # vite build → dist-client, tsc → dist-server
pnpm --filter @dsh-doc/web start        # node dist-server/server.js (default :4317)
pnpm --filter @dsh-doc/web test         # vitest (app-local config)
node_modules/.bin/vitest run apps/web   # tests through the root vitest config
```

The server listens on `127.0.0.1:4317` by default; override with `PORT` / `HOST`.
Workspace documents live in `<repo>/.workspace` (`DSH_DOC_WORKSPACE` overrides).
`DSH_DOC_CORE_DIST` can point at an alternative build of `packages/core/dist`.

## Resolution

`@dsh-doc/core/model` is aliased to `packages/core/src/model/index.ts` in
`vite.config.ts`, `tsconfig.json` and `vitest.config.ts`. The full
`@dsh-doc/core` index is deliberately not imported by the client: it pulls in
the Node-only OOXML/conversion/render adapters. The server loads core modules
dynamically at runtime (`server/core.ts`) and reports every absence explicitly.

## HTTP API

| Method | Path                           | Behaviour                                                                                                                                                                              |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                  | version + probed capabilities (`renderer`, `formats`, `ai`, `model`, `docx`, `convert`) + warnings                                                                                     |
| GET    | `/api/documents`               | workspace documents (`.json` records and `.docx` files)                                                                                                                                |
| POST   | `/api/documents`               | create; uses the core model server-side, or accepts a client-created document                                                                                                          |
| POST   | `/api/documents/open`          | multipart DOCX import (≤25 MB, `.docx/.dotx/.docm`) via the core OOXML adapter, else 501                                                                                               |
| GET    | `/api/documents/:id`           | `{id, title, document, meta}`                                                                                                                                                          |
| PUT    | `/api/documents/:id`           | save (404 when the id is unknown, 409 for DOCX-backed ids)                                                                                                                             |
| DELETE | `/api/documents/:id`           | delete the JSON record and/or DOCX file                                                                                                                                                |
| POST   | `/api/documents/:id/export`    | `docx/html/odt/rtf/md/txt/pdf`; conversion engine first, then the DOCX exporter, the PDF renderer and `documentText`; 501 with `FORMAT_UNAVAILABLE` when nothing can produce the bytes |
| GET    | `/api/render?format=html\|pdf` | server layout renderer; 501 `RENDERER_UNAVAILABLE` when absent                                                                                                                         |
| POST   | `/api/ai/assist`               | core assistant (`summarize`, `review`, `rewrite`, `translate`, `generate_content`, `suggest_edits`); 501 `AI_PROVIDER_NOT_CONFIGURED` when no provider is configured                   |

Ids are restricted to `[A-Za-z0-9_-]{1,128}`; JSON bodies are limited to 25 MB;
uploads are memory-buffered, extension-filtered and size-limited.

## Graceful degradation

- **AI** — with the offline provider, `Ask`/`Summarize`/`Find mistakes` work
  (extractive summary and deterministic review, labelled as such). `Suggest`
  (rewrite/translate) and `Edit` (suggest_edits) need a configured language
  model and answer `501 AI_PROVIDER_NOT_CONFIGURED`; the panel shows the error
  instead of inventing output.
- **Server renderer / preview** — the preview prefers `GET /api/render`; when it
  is unavailable the view shows a banner and paginates locally by measuring
  block heights (blocks move whole to the next page — no splitting).
- **Export / import** — the export menu lists only formats the server reports.
  The conversion engine, DOCX exporter, PDF renderer and DOCX importer are used
  only when loadable; otherwise the API returns 501 and the UI shows the reason.
- **Server offline** — the client keeps working locally with a recovery
  autosave in `localStorage`; the header shows `offline` and saving reports the
  failure.
- **Autosave / recovery** — a 5 s idle autosave writes a recovery snapshot; on
  load the user is asked to recover or discard it. `beforeunload` warns about
  unsaved changes.

## Known limitations

- Editing is continuous, not paginated (pagination appears in the preview).
- `formatRange` on a collapsed caret is a no-op in the core model, so the
  toolbar's pending format is applied to the next typed text instead.
- Image insertion stores base64 media in the document (self-contained, but the
  JSON payload grows with the image).
- Preview pagination does not split blocks, tables across pages, footnotes,
  headers/footers or floating objects; it says so on screen.
- Fields with cached results render read-only; maths renders as its linear
  projection.
- Undo coalesces edits with the same key inside a 900 ms window; structural
  operations each get their own history entry.
