/**
 * Provider implementations. `offline` is a deterministic, clearly labelled
 * heuristic provider used for summarisation/review and for tests; it never
 * pretends to be an LLM. `openai` talks to any OpenAI-compatible endpoint and
 * `ollama` to a local Ollama server.
 */
import type {
  AiCompletion,
  AiConfig,
  AiProvider,
  ChatMessage,
} from "./types.js";

export class AiProviderError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/* --------------------------------------------------------------- offline */

/** Deterministic provider for offline capabilities (no network, no model). */
export class OfflineHeuristicProvider implements AiProvider {
  readonly id = "offline";
  readonly label = "Offline heuristics (no language model)";
  readonly offline = true;

  available(): boolean {
    return true;
  }

  async complete(): Promise<AiCompletion> {
    throw new AiProviderError(
      "AI_PROVIDER_REQUIRED",
      "This operation needs a configured language model provider",
      "Set DSH_DOC_AI_PROVIDER to openai or ollama (with credentials), then retry.",
    );
  }
}

/* ---------------------------------------------------------------- openai */

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = "openai";
  readonly label: string;
  readonly offline = false;
  private readonly config: AiConfig;

  constructor(config: AiConfig) {
    this.config = config;
    this.label = `OpenAI-compatible (${config.model ?? "gpt-4o-mini"})`;
  }

  available(): boolean {
    return Boolean(
      this.config.apiKey &&
      (this.config.baseUrl ?? process.env.OPENAI_BASE_URL ?? true),
    );
  }

  async complete(
    messages: ChatMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: "text" | "json";
    } = {},
  ): Promise<AiCompletion> {
    const apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AiProviderError(
        "AI_NOT_CONFIGURED",
        "OPENAI_API_KEY is not set",
      );
    }
    const baseUrl = (
      this.config.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    const model =
      this.config.model ?? process.env.DSH_DOC_AI_MODEL ?? "gpt-4o-mini";
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 60_000,
    );
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? this.config.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? this.config.maxTokens ?? 1200,
          response_format:
            options.responseFormat === "json"
              ? { type: "json_object" }
              : undefined,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AiProviderError(
          "AI_REQUEST_FAILED",
          `Provider returned HTTP ${response.status}`,
          body.slice(0, 400),
        );
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = payload.choices?.[0]?.message?.content ?? "";
      return {
        text,
        provider: this.id,
        model,
        usage: {
          inputTokens: payload.usage?.prompt_tokens,
          outputTokens: payload.usage?.completion_tokens,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* ---------------------------------------------------------------- ollama */

export class OllamaProvider implements AiProvider {
  readonly id = "ollama";
  readonly label: string;
  readonly offline = false;
  private readonly config: AiConfig;

  constructor(config: AiConfig) {
    this.config = config;
    this.label = `Ollama (${config.model ?? "llama3.1"})`;
  }

  available(): boolean {
    return true;
  }

  async complete(
    messages: ChatMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: "text" | "json";
    } = {},
  ): Promise<AiCompletion> {
    const host = (
      this.config.baseUrl ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434"
    ).replace(/\/$/, "");
    const model =
      this.config.model ?? process.env.DSH_DOC_AI_MODEL ?? "llama3.1";
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 120_000,
    );
    try {
      const response = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature ?? this.config.temperature ?? 0.2,
            num_predict: options.maxTokens ?? this.config.maxTokens ?? 1200,
          },
          format: options.responseFormat === "json" ? "json" : undefined,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AiProviderError(
          "AI_REQUEST_FAILED",
          `Ollama returned HTTP ${response.status}`,
        );
      }
      const payload = (await response.json()) as {
        message?: { content?: string };
      };
      return { text: payload.message?.content ?? "", provider: this.id, model };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* --------------------------------------------------------------- factory */

export function resolveAiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  const envProvider = (process.env.DSH_DOC_AI_PROVIDER ?? "").toLowerCase();
  const explicit =
    overrides.provider ?? (envProvider as AiConfig["provider"] | undefined);
  const model = overrides.model ?? process.env.DSH_DOC_AI_MODEL;
  const baseUrl =
    overrides.baseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.OLLAMA_HOST;
  const apiKey = overrides.apiKey ?? process.env.OPENAI_API_KEY;
  let provider: AiConfig["provider"];
  if (explicit && explicit !== "auto") provider = explicit;
  else if (apiKey) provider = "openai";
  else if (process.env.OLLAMA_HOST) provider = "ollama";
  else provider = "offline";
  return {
    provider,
    model,
    baseUrl,
    apiKey,
    temperature: overrides.temperature,
    maxTokens: overrides.maxTokens,
    timeoutMs: overrides.timeoutMs,
  };
}

let overrideProvider: AiProvider | undefined;

/** Test seam: inject a provider (never used by production code paths). */
export function setProviderForTesting(provider: AiProvider | undefined): void {
  overrideProvider = provider;
}

export function createProvider(config: AiConfig): AiProvider {
  if (overrideProvider) return overrideProvider;
  switch (config.provider) {
    case "disabled":
      return new OfflineHeuristicProvider();
    case "openai":
      return new OpenAiCompatibleProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "offline":
      return new OfflineHeuristicProvider();
    default:
      return new OfflineHeuristicProvider();
  }
}

export function providerStatus(): {
  provider: string;
  model?: string;
  offline: boolean;
  available: boolean;
  configured: boolean;
} {
  const config = resolveAiConfig();
  const provider = createProvider(config);
  return {
    provider: provider.id,
    model: config.model,
    offline: provider.offline,
    available: provider.available(),
    configured: provider.id !== "offline",
  };
}
