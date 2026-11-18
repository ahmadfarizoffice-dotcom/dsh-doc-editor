/**
 * Typed client for the document HTTP API (server/server.ts).
 *
 * The client never fabricates capability data: every response shape below is
 * what the server returns, and unavailable server features surface as
 * `ApiError` with the server's machine-readable `code`.
 */
import type { DocDocument, DocRange } from "@dsh-doc/core/model";

export interface Capabilities {
  /** Paginated server-side rendering (HTML/PDF) is available. */
  renderer: boolean;
  /** Export targets that the server can actually produce right now. */
  formats: string[];
  /** An AI provider is configured server-side. */
  ai: boolean;
  /** The shared document model package could be loaded by the server. */
  model: boolean;
  /** DOCX import/export adapters were found. */
  docx: boolean;
  /** The conversion engine was found. */
  convert: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  capabilities: Capabilities;
  warnings?: string[];
}

export type DocumentKind = "json" | "docx";

export interface DocumentSummary {
  id: string;
  title: string;
  kind: DocumentKind;
  bytes: number;
  updatedAt: string;
}

export interface DocumentMeta {
  createdAt?: string;
  updatedAt?: string;
  validated?: boolean;
  warnings?: string[];
  source?: string;
}

export interface DocumentRecord {
  id: string;
  title: string;
  document: DocDocument;
  meta: DocumentMeta;
}

export interface AiAssistRequest {
  mode: "ask" | "suggest" | "edit";
  prompt: string;
  document: DocDocument;
  range?: DocRange;
  options?: {
    /** Explicit assistant operation (summarize, review, rewrite, translate, generate_content, suggest_edits). */
    operation?: string;
    targetLanguage?: string;
    language?: string;
    style?: string;
    maxSentences?: number;
    tone?: string;
  };
}

export interface AiSuggestion {
  before: string;
  after: string;
  rationale?: string;
  range?: DocRange;
}

export interface AiOperation {
  summary: string;
  /** Structured operations, when the provider returns an applicable edit. */
  operations?: unknown[];
}

export interface AiAssistResponse {
  mode: "ask" | "suggest" | "edit";
  answer?: string;
  suggestion?: AiSuggestion;
  operation?: AiOperation;
  operationName?: string;
  provider?: string;
  findings?: unknown[];
  warnings?: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnavailable(): boolean {
    return this.status === 501 || this.code === "AI_PROVIDER_NOT_CONFIGURED";
  }
}

interface ErrorBody {
  error?: string;
  code?: string;
  message?: string;
  details?: unknown;
}

async function readError(response: Response): Promise<ApiError> {
  let body: ErrorBody | undefined;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    body = undefined;
  }
  const code = body?.code ?? body?.error;
  const message =
    body?.message ??
    (body?.error ? String(body.error) : undefined) ??
    `${response.status} ${response.statusText}`;
  return new ApiError(message, response.status, code, body?.details);
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class DocumentApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) throw await readError(response);
    return response;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  async health(): Promise<HealthResponse> {
    return this.json<HealthResponse>("/api/health");
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const body = await this.json<{ documents: DocumentSummary[] }>(
      "/api/documents",
    );
    return body.documents;
  }

  async getDocument(id: string): Promise<DocumentRecord> {
    return this.json<DocumentRecord>(
      `/api/documents/${encodeURIComponent(id)}`,
    );
  }

  async createDocument(input: {
    title?: string;
    document?: DocDocument;
  }): Promise<DocumentRecord> {
    return this.json<DocumentRecord>("/api/documents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    });
  }

  async saveDocument(
    id: string,
    document: DocDocument,
    title?: string,
  ): Promise<DocumentRecord> {
    return this.json<DocumentRecord>(
      `/api/documents/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ document, title }),
      },
    );
  }

  async deleteDocument(id: string): Promise<void> {
    await this.request(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async openDocument(
    file: File | Blob,
    fileName = "document.docx",
  ): Promise<DocumentRecord> {
    const form = new FormData();
    form.append("file", file, fileName);
    return this.json<DocumentRecord>("/api/documents/open", {
      method: "POST",
      body: form,
    });
  }

  /** Requests an export and returns the produced bytes plus the server file name. */
  async exportDocument(
    id: string,
    format: string,
  ): Promise<{ blob: Blob; fileName: string }> {
    const response = await this.request(
      `/api/documents/${encodeURIComponent(id)}/export`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ format }),
      },
    );
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const fileName = match
      ? decodeURIComponent(match[1])
      : `document.${format}`;
    return { blob: await response.blob(), fileName };
  }

  async render(format: "html" | "pdf"): Promise<Response> {
    return this.request(`/api/render?format=${encodeURIComponent(format)}`);
  }

  async assist(request: AiAssistRequest): Promise<AiAssistResponse> {
    return this.json<AiAssistResponse>("/api/ai/assist", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
  }
}

/** True when the error means "the server did not have this capability". */
export function isUnavailableError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 501;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return error.code ? `${error.message} (${error.code})` : error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Saves a blob to disk through an anchor (used for exports). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
