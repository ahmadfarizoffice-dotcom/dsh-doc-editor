# Security policy

This document describes the security model of the DSH Document Engine: the
shared document service behind the editor UI, the MCP server, the native agent
tool definitions and the skill pack in `skills/`. It also explains how to
report a vulnerability.

The engine parses and rewrites untrusted documents. Treat every file that
enters the workspace as hostile input until it has been validated.

## Supported versions

| Version                | Security fixes |
| ---------------------- | -------------- |
| 1.x (current)          | Yes            |
| Older pre-release tags | No             |

Only the latest release on the default branch receives security fixes. There
are no long-term support branches at this time.

## Reporting a vulnerability

Do **not** open a public issue, discussion or pull request for a suspected
vulnerability, and do not attach weaponized documents.

1. Use GitHub's private vulnerability reporting ("Report a vulnerability" on
   the repository Security tab) when it is enabled for the repository.
2. If private reporting is unavailable, contact the maintainers directly
   through the private address published in the repository profile, with the
   subject prefix `[SECURITY]`.
3. Include: affected version/commit, the component (`packages/core`,
   `apps/mcp`, `apps/web`, `apps/cli`, `skills/`), reproduction steps or a
   minimal synthetic document, the observed impact, and whether the issue
   requires a specific `DSH_DOC_*` configuration.

Please include a synthetic fixture rather than a real document. Maintainers
will acknowledge a report within five business days and aim to provide a
triage decision within ten. Coordinated disclosure is expected: please allow
a fix to ship before publishing details. Credit is given unless you ask to
remain anonymous.

## Threat model

### Assets

- Documents inside the configured workspace (they may contain confidential
  business content).
- The host filesystem outside the workspace.
- Operator credentials and provider API keys held in the environment.
- Integrity of documents returned to a human reviewer: silent content loss is
  treated as a security-relevant bug, not a cosmetic one.

### Adversaries and attack paths

1. **A malicious document supplied by a third party.** DOCX/DOTX/DOCM, HTML,
   Markdown, RTF, ODT and legacy DOC files are attacker-controlled ZIP or text
   containers. Editing a hostile file must not compromise the host, leak
   files, execute code, or hang the server.
2. **A malicious or compromised AI provider.** AI features send document text
   to a configured provider; the response is untrusted and must never be
   replayed as raw document edits or markup.
3. **A confused agent.** An agent that follows instructions embedded in a
   document, or that passes workspace-escaping paths, is an attack path even
   when the document itself is well formed.
4. **A remote web client.** The editor API is reachable from a browser and
   must not be usable for cross-origin document theft or unauthorized
   mutation.

### Threats and mitigations

| Threat                                                                                                   | Mitigation                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hostile OOXML parts (unexpected relationship targets, malformed XML, deeply nested markup)               | Parts are parsed defensively; unrecognized parts are preserved verbatim and reported as `unknown`, never executed or resolved externally. Parse failures return a typed `PARSE_FAILED` result instead of partially applying a document.                                                           |
| Zip bombs and decompression amplification (nested ZIPs, huge `document.xml`, many small parts)           | Bounded inflate/decompress with entry count, per-entry and total uncompressed size limits, and `DSH_DOC_MAX_UPLOAD_MB` at the API boundary. Exceeding a limit fails with `FILE_TOO_LARGE`; nothing is silently truncated.                                                                         |
| XXE / external entity expansion                                                                          | The engine does not resolve external entities or external DTDs. DOCTYPE declarations in document XML are not honored for entity substitution, so file disclosure and SSRF via entities are not possible. Billion-laughs style internal expansion is bounded by the same parse limits.             |
| Path traversal from archive entries or relationship targets (`../`, absolute paths, UNC paths, symlinks) | Archive extraction and part resolution reject traversal, absolute paths and symlink escapes. All filesystem access is confined to `DSH_DOC_WORKSPACE`; other paths fail with `WORKSPACE_PATH_DENIED`.                                                                                             |
| Macro execution                                                                                          | Never performed. `vbaProject.bin`, OLE objects, external links and `altChunk` content are recorded, preserved for round-trip and reported as unsupported; no macros, scripts or shell commands from a document are ever run, loaded or `eval`'d.                                                  |
| Document content used as a command channel (prompt injection)                                            | Document text is untrusted data. System prompts state this explicitly, tool results are labeled as untrusted content, and AI output may only become structured document operations that are validated against the schema before application. Raw HTML replacement is never an accepted operation. |
| Cross-origin data theft from the editor API                                                              | Browser origins are restricted by `DSH_DOC_ALLOW_ORIGINS`; the default is an explicit localhost allow-list, not `*`.                                                                                                                                                                              |
| Accidental destructive edits or exfiltration in shared deployments                                       | `DSH_DOC_READ_ONLY=1` disables all mutating and write paths while leaving reads available, and `DSH_DOC_AUDIT_LOG` records each operation with its outcome.                                                                                                                                       |
| Resource exhaustion (huge documents, expensive layout)                                                   | Upload size, part size, page count and render/convert work are bounded per request; expensive operations report a typed failure instead of exhausting memory or CPU.                                                                                                                              |

### Non-goals

- Protecting a workspace whose root is configured to `/`, a home directory, or
  another directory containing unrelated secrets. Confinement is only as
  strong as the configured root.
- Defending against a hostile operator who can already read the host, or
  against a malicious provider retaining documents it was sent.
- Rendering parity with Microsoft Word is a compatibility concern (see the
  capability matrix), not a security boundary.
- The web UI and CLI are not hardened multi-tenant internet services.

## Security design rules for contributors

- Validate at the boundary: one schema for MCP tool input, one workspace path
  resolver, one upload size check. Do not re-implement path joining.
- Preserve unknown content in the model and report it; never drop an element
  silently. Silent loss hides both compatibility and integrity problems.
- Report capabilities and losses (`CompatibilityReport`) with every import and
  lossy conversion.
- Keep operations deterministic and free of network access unless the caller
  explicitly asked for an AI provider.
- Never interpolate document text into a command, shell, template, file path
  or SQL statement.
- Never add a code path that executes macros, embedded scripts, external
  links or `altChunk` payloads.
- Add a regression test with a synthetic malicious fixture for every security
  fix, and note the fixture in the pull request.

## Hardening checklist for deployments

- Point `DSH_DOC_WORKSPACE` at a dedicated directory, never at a home
  directory or repository root.
- Use `DSH_DOC_READ_ONLY=1` for review, conversion and summarization workloads.
- Keep `DSH_DOC_AUDIT_LOG` enabled and outside the served document tree.
- Set `DSH_DOC_ALLOW_ORIGINS` to exact origins; never `*` outside local
  development.
- Keep provider keys in the environment or a secret manager; `.env` files are
  git-ignored and must never be committed.
- Run the MCP server under the least privileged account that can read and
  write the workspace.
