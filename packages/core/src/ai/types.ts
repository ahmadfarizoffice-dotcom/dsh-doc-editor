/** AI assistant types. The engine is provider independent. */
import type { DocDocument, DocRange, RunProps } from "../model/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletion {
  text: string;
  provider: string;
  model?: string;
  /** Token usage when the provider reports it. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProvider {
  id: string;
  label: string;
  /** Deterministic providers can answer without network access. */
  offline: boolean;
  available(): boolean;
  complete(
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: "text" | "json";
    },
  ): Promise<AiCompletion>;
}

export interface AiConfig {
  provider: "auto" | "offline" | "openai" | "ollama" | "disabled";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export type AiMode = "ask" | "suggest" | "edit";

export interface AiOperation {
  tool: string;
  args: Record<string, unknown>;
  /** Human readable summary shown in the operation log. */
  summary: string;
}

export interface AiFinding {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  blockId?: string;
  start?: number;
  end?: number;
  text?: string;
  suggestion?: string;
}

export interface AiResult {
  ok: boolean;
  operation: string;
  provider: string;
  model?: string;
  mode?: AiMode;
  /** Free-form answer for Ask mode. */
  answer?: string;
  /** Proposed operations (Suggest/Edit modes). Never applied by the AI layer. */
  operations?: AiOperation[];
  /** Before/after preview for the first operation, when available. */
  preview?: { before: string; after: string };
  /** Document text that was sent as context (for auditability). */
  contextChars?: number;
  findings?: AiFinding[];
  truncated?: boolean;
  warnings?: string[];
  error?: { code: string; message: string; hint?: string };
}

export interface AiRequest {
  document?: DocDocument;
  range?: DocRange;
  selectionText?: string;
  prompt?: string;
  instruction?: string;
  targetLanguage?: string;
  tone?: string;
  mode?: AiMode;
  style?: "bullet" | "paragraph" | "executive";
  maxSentences?: number;
  checks?: string[];
  /** Explicit provider override (never from document content). */
  provider?: AiConfig["provider"];
  model?: string;
}

export interface RewriteCandidate {
  range: DocRange;
  before: string;
  after: string;
  props?: RunProps;
}
