/**
 * "Ask AI" panel.
 *
 * Three modes (Ask / Suggest / Edit) call POST /api/ai/assist. No output is ever
 * synthesized by the UI: when the server has no provider the panel states that
 * explicitly. Suggestions are applied only after an explicit click, and every
 * applied change goes through the normal model history (so Undo works).
 */
import { useMemo, useState } from "react";
import type { AiAssistResponse, AiSuggestion } from "../app/api";
import type { AiMode, AppSnapshot, AppStore } from "../app/state";
import { insertTextAtSelection, selectionHasRange } from "../model/ops";
import { findParagraph, textOffsetToPosition } from "@dsh-doc/core/model";

interface AiPaneProps {
  store: AppStore;
  snapshot: AppSnapshot;
}

const QUICK_ACTIONS: Array<{
  label: string;
  mode: AiMode;
  prompt: string;
  operation?: string;
  style?: string;
  targetLanguage?: boolean;
}> = [
  {
    label: "Summarize",
    mode: "ask",
    prompt: "Summarize this document in five bullet points.",
    operation: "summarize",
  },
  {
    label: "Rewrite professionally",
    mode: "suggest",
    prompt: "Rewrite the selected text in a professional, concise tone.",
    operation: "rewrite",
  },
  {
    label: "Translate",
    mode: "suggest",
    prompt: "Translate the selected text.",
    operation: "translate",
    targetLanguage: true,
  },
  {
    label: "Find spelling mistakes",
    mode: "ask",
    prompt: "Find spelling and grammar mistakes and list them with fixes.",
    operation: "review",
  },
  {
    label: "Create TOC",
    mode: "edit",
    prompt: "Create a table of contents covering levels 1 to 3.",
  },
  {
    label: "Convert to table",
    mode: "edit",
    prompt: "Convert the selected tabular text into a table.",
  },
  {
    label: "Executive summary",
    mode: "ask",
    prompt: "Write a one-paragraph executive summary of this document.",
    operation: "summarize",
    style: "executive",
  },
];

/** Minimal markdown-ish renderer (headings, bold, italics, code, lists). */
function renderRichText(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nodes: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushList = (): void => {
    if (listItems.length === 0) return;
    const items = listItems;
    const ordered = listOrdered;
    listItems = [];
    const key = `list-${nodes.length}`;
    nodes.push(
      ordered ? (
        <ol key={key}>
          {items.map((item, index) => (
            <li key={`${key}-${index}`}>{inline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {items.map((item, index) => (
            <li key={`${key}-${index}`}>{inline(item)}</li>
          ))}
        </ul>
      ),
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!listItems.length) listOrdered = false;
      listItems.push(bullet[1]);
      continue;
    }
    if (ordered) {
      if (!listItems.length) listOrdered = true;
      listItems.push(ordered[1]);
      continue;
    }
    flushList();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2]);
      nodes.push(
        <div
          key={`h-${nodes.length}`}
          className="ai-heading"
          data-level={level}
          role="heading"
          aria-level={level}
        >
          {content}
        </div>,
      );
      continue;
    }
    if (/^```/.test(line)) {
      nodes.push(
        <pre key={`pre-${nodes.length}`} className="ai-code">
          {line.replace(/^```/, "")}
        </pre>,
      );
      continue;
    }
    nodes.push(<p key={`p-${nodes.length}`}>{inline(line)}</p>);
  }
  flushList();
  return nodes;
}

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      out.push(<strong key={`b-${index++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      out.push(<code key={`c-${index++}`}>{token.slice(1, -1)}</code>);
    } else {
      out.push(<em key={`i-${index++}`}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

function suggestionFor(result: AiAssistResponse | null): AiSuggestion | null {
  if (!result) return null;
  if (result.suggestion) return result.suggestion;
  return null;
}

export function AiPane({ store, snapshot }: AiPaneProps): React.JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [language, setLanguage] = useState("Spanish");
  const [editedSuggestion, setEditedSuggestion] = useState<string | null>(null);
  const mode = snapshot.ui.aiMode;
  const result = snapshot.ui.aiResult;
  const busy = snapshot.ui.aiBusy;
  const available = snapshot.ui.aiAvailable;
  const suggestion = useMemo(() => suggestionFor(result), [result]);
  const hasRange = selectionHasRange(snapshot.document, store.selection);

  const submit = (
    modeToUse: AiMode,
    promptText: string,
    extra?: { targetLanguage?: string; operation?: string; style?: string },
  ): void => {
    const text = promptText.trim();
    if (!text) {
      store.toast("Enter a prompt first", "info");
      return;
    }
    setEditedSuggestion(null);
    void store.runAi({
      mode: modeToUse,
      prompt: text,
      range: hasRange ? store.session.range : undefined,
      options: {
        operation: extra?.operation,
        targetLanguage: extra?.targetLanguage,
        style: extra?.style,
      },
    });
  };

  const applySuggestion = (value: string): void => {
    if (!suggestion) return;
    const selection = store.selection;
    const model = store.session.document;

    if (suggestion.range) {
      const paragraph = findParagraph(
        model,
        suggestion.range.start.blockId,
      )?.paragraph;
      if (paragraph) {
        const start = textOffsetToPosition(
          paragraph,
          suggestion.range.start.offset,
        );
        const end = textOffsetToPosition(
          paragraph,
          suggestion.range.end.offset,
        );
        store.apply("Apply AI suggestion", (next) => {
          insertTextAtSelection(next, { anchor: start, focus: end }, value);
        });
        store.toast("Suggestion applied (undo available)", "success");
        return;
      }
    }

    if (!selectionHasRange(model, selection)) {
      store.toast(
        "Select the text to replace, then apply the suggestion",
        "error",
      );
      return;
    }
    store.apply("Apply AI suggestion", (next) => {
      insertTextAtSelection(next, selection, value);
    });
    store.toast("Suggestion applied (undo available)", "success");
  };

  return (
    <aside className="pane pane-right" aria-label="AI assistant">
      <header className="pane-header">
        <h2>Ask AI</h2>
        <span className={available ? "status-pill ok" : "status-pill warn"}>
          {available ? "connected" : "unavailable"}
        </span>
      </header>

      {!available ? (
        <p className="notice notice-warning">
          {snapshot.ui.aiUnavailableReason ??
            "No AI provider is configured on the server, so no AI output can be produced here."}
        </p>
      ) : null}

      <div className="mode-tabs" role="tablist" aria-label="AI mode">
        {(["ask", "suggest", "edit"] as AiMode[]).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className={mode === entry ? "mode-tab active" : "mode-tab"}
            onClick={() => store.setUi({ aiMode: entry })}
          >
            {entry === "ask" ? "Ask" : entry === "suggest" ? "Suggest" : "Edit"}
          </button>
        ))}
      </div>
      <p className="hint">
        {mode === "ask"
          ? "Answers questions about the document; never changes it."
          : mode === "suggest"
            ? "Proposes replacement text for the selection, shown as a diff."
            : "Proposes document edits as an operation summary you can apply or undo."}
      </p>

      <label className="visually-hidden" htmlFor="ai-prompt">
        Prompt
      </label>
      <textarea
        id="ai-prompt"
        className="ai-prompt"
        rows={3}
        value={prompt}
        placeholder={
          mode === "ask"
            ? "Ask about this document…"
            : "Describe the change you want…"
        }
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit(mode, prompt);
          }
        }}
      />

      <div className="form-row">
        <label htmlFor="ai-language">Translate to</label>
        <input
          id="ai-language"
          type="text"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        />
      </div>

      <div className="ai-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => submit(mode, prompt)}
          disabled={busy}
        >
          {busy ? "Working…" : "Send"}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => store.setUi({ aiResult: null })}
          disabled={!result && !snapshot.ui.aiHistory.length}
        >
          Clear
        </button>
      </div>

      <div className="quick-actions" aria-label="Quick actions">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => {
              setPrompt(action.prompt);
              submit(action.mode, action.prompt, {
                operation: action.operation,
                style: action.style,
                targetLanguage: action.targetLanguage ? language : undefined,
              });
            }}
          >
            {action.label}
          </button>
        ))}
      </div>

      {busy ? (
        <p className="hint">Waiting for the server’s AI provider…</p>
      ) : null}

      {snapshot.ui.aiError ? (
        <p className="notice notice-warning" role="alert">
          {snapshot.ui.aiError}
        </p>
      ) : null}

      {result ? (
        <section className="ai-result" aria-live="polite">
          {result.provider || result.operationName ? (
            <p className="hint">
              {result.operationName ? `${result.operationName} · ` : ""}
              {result.provider ? `provider: ${result.provider}` : ""}
            </p>
          ) : null}
          {result.answer ? (
            <div className="ai-answer">{renderRichText(result.answer)}</div>
          ) : null}

          {suggestion ? (
            <div className="ai-suggestion">
              <h3>Proposed change</h3>
              <div className="diff">
                <div className="diff-side">
                  <h4>Before</h4>
                  <pre>{suggestion.before}</pre>
                </div>
                <div className="diff-side">
                  <h4>After</h4>
                  <pre>{editedSuggestion ?? suggestion.after}</pre>
                </div>
              </div>
              {suggestion.rationale ? (
                <p className="hint">{suggestion.rationale}</p>
              ) : null}
              <div className="ai-actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={() =>
                    applySuggestion(editedSuggestion ?? suggestion.after)
                  }
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => store.setUi({ aiResult: null })}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    setEditedSuggestion(editedSuggestion ?? suggestion.after)
                  }
                >
                  Edit
                </button>
              </div>
              {editedSuggestion !== null ? (
                <>
                  <label
                    className="visually-hidden"
                    htmlFor="ai-suggestion-edit"
                  >
                    Edit suggestion
                  </label>
                  <textarea
                    id="ai-suggestion-edit"
                    rows={4}
                    value={editedSuggestion}
                    onChange={(event) =>
                      setEditedSuggestion(event.target.value)
                    }
                  />
                </>
              ) : null}
            </div>
          ) : null}

          {result.operation ? (
            <div className="ai-operation">
              <h3>Edit proposal</h3>
              <p>{result.operation.summary}</p>
              {result.operation.operations &&
              result.operation.operations.length > 0 ? (
                <pre>
                  {JSON.stringify(result.operation.operations, null, 2)}
                </pre>
              ) : (
                <p className="hint">
                  The provider returned a summary without machine-applicable
                  operations, so this editor does not apply it. Nothing was
                  changed.
                </p>
              )}
              <div className="ai-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => store.undo()}
                  disabled={!snapshot.canUndo}
                >
                  Undo last change
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => store.setUi({ aiResult: null })}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          {result.warnings && result.warnings.length > 0 ? (
            <ul className="hint">
              {result.warnings.map((warning, index) => (
                <li key={`warning-${index}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {snapshot.ui.aiHistory.length > 0 ? (
        <section className="ai-history">
          <h3>Recent</h3>
          <ul>
            {[...snapshot.ui.aiHistory].reverse().map((entry) => (
              <li
                key={entry.id}
                className={entry.error ? "history-error" : undefined}
              >
                <span className="history-mode">{entry.mode}</span>
                <span className="history-prompt">{entry.prompt}</span>
                {entry.error ? (
                  <span className="history-error-text">{entry.error}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="hint">
        The assistant runs server-side (POST /api/ai/assist). This panel never
        fabricates model output; when the endpoint is unavailable it reports the
        server’s error code instead.
      </p>
    </aside>
  );
}
