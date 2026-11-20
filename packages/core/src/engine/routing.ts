/**
 * Engine routing rules.
 *
 * LibreOffice is the default *conversion and PDF rendering* engine, but it is
 * an optional dependency and it is not always the most faithful writer. This
 * module owns the decision as a pure function so every surface (service, MCP
 * tools, CLI, tests and the engine matrix) shares exactly one routing table:
 *
 *   preference × availability × target format × measured text loss
 *     → engine, route reason and typed fallback reason
 *
 * The rules implemented here are the product contract:
 *  - `auto` is LibreOffice-first with automatic, *reported* fallback.
 *  - `internal` never starts LibreOffice at all.
 *  - `libreoffice` still falls back when the binary is missing or fails, but the
 *    fallback is always typed (`fallbackReason`) rather than silent.
 *  - `pdf` is always routed through LibreOffice when it is available; text-loss
 *    comparison does not apply because PDF has no text adapter.
 *  - `docx`, `odt`, `rtf` and `html` are routed through LibreOffice only when
 *    the produced bytes keep the document text; a loss downgrades the result to
 *    the internal adapter with `fallbackReason: "text-loss"`.
 *  - `txt` keeps the internal adapter: plain text is not a LibreOffice writer
 *    strength and both projections are lossy for rich documents, so the
 *    deterministic internal path wins and LibreOffice is never started.
 *  - Formats LibreOffice's writer filter table does not cover (markdown,
 *    `dotx`, `docm`, preview formats) keep the internal adapter.
 */
import { LibreOfficeError } from "./libreoffice.js";

/** Which engine the caller wants. `auto` is LibreOffice-first. */
export type EnginePreference = "auto" | "libreoffice" | "internal";

/** The engine that actually produced (or will produce) the bytes. */
export type ConversionEngineId = "libreoffice" | "internal";

/**
 * Typed reason why LibreOffice did not produce the result. Always set when the
 * internal engine replaces a LibreOffice attempt; never used for an explicit
 * `internal` preference.
 */
export type FallbackReason =
  "engine-unavailable" | "conversion-failed" | "timeout" | "text-loss";

/** Stable route reason, including non-fallback reasons. */
export type RouteReason =
  | "libreoffice"
  | "preference-internal"
  | "engine-unavailable"
  | "format-unsupported"
  | "internal-format"
  | "text-loss"
  | "conversion-failed"
  | "timeout";

export const ENGINE_PREFERENCE_DEFAULT: EnginePreference = "auto";

export const ENGINE_PREFERENCES: readonly EnginePreference[] = Object.freeze([
  "auto",
  "libreoffice",
  "internal",
]);

/**
 * Formats where a LibreOffice conversion replaces the internal adapter when the
 * engine is available and the output keeps the text.
 */
export const LIBREOFFICE_ROUTED_FORMATS: readonly string[] = Object.freeze([
  "docx",
  "odt",
  "rtf",
  "html",
  "pdf",
]);

/**
 * Formats owned by the internal adapter by design. Plain text is not a
 * LibreOffice writer strength: both projections are lossy for rich documents
 * (headers/notes), so the deterministic internal adapter is preferred and
 * LibreOffice is never started for it.
 */
export const INTERNAL_OWNED_FORMATS: readonly string[] = Object.freeze(["txt"]);

const FORMAT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  text: "txt",
  htm: "html",
  xhtml: "html",
  markdown: "md",
});

export function isEnginePreference(value: unknown): value is EnginePreference {
  return (
    typeof value === "string" &&
    (ENGINE_PREFERENCES as readonly string[]).includes(value)
  );
}

/** Lenient normalisation for environment values: unknown input → `auto`. */
export function normalizeEnginePreference(
  value: unknown,
  fallback: EnginePreference = ENGINE_PREFERENCE_DEFAULT,
): EnginePreference {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return isEnginePreference(normalized) ? normalized : fallback;
}

/** Strict normalisation for API input: unknown input throws. */
export function parseEnginePreference(value: unknown): EnginePreference {
  if (typeof value !== "string") {
    throw new RangeError(
      `engine must be one of ${ENGINE_PREFERENCES.join(", ")} (got ${typeof value})`,
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!isEnginePreference(normalized)) {
    throw new RangeError(
      `engine must be one of ${ENGINE_PREFERENCES.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return normalized;
}

/** `PDF` / `.Html` / `text` → `pdf` / `html` / `txt`. */
export function normalizeRoutingFormat(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  return FORMAT_ALIASES[normalized] ?? normalized;
}

/**
 * User-facing extension → internal adapter id. The routing table speaks
 * extensions (`txt`, `md`) while the format registry names adapters (`text`,
 * `markdown`).
 */
const ADAPTER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  txt: "text",
  md: "markdown",
});

export function adapterFormatFor(format: string): string {
  const normalized = normalizeRoutingFormat(format);
  return ADAPTER_ALIASES[normalized] ?? normalized;
}

export interface EngineRouteInput {
  preference: EnginePreference;
  /** Whether LibreOffice answered `--version` and can be launched. */
  available: boolean;
  /** Target format, normalised by `normalizeRoutingFormat`. */
  format: string;
  /**
   * Result of the post-conversion text comparison. Only meaningful for the
   * DOCX/ODT/RTF/HTML text-bearing targets.
   */
  textLoss?: boolean;
}

export interface EngineRoute {
  engine: ConversionEngineId;
  preference: EnginePreference;
  format: string;
  /** True when LibreOffice detection succeeded (regardless of the decision). */
  available: boolean;
  /** True when LibreOffice's writer filter table covers this target. */
  capable: boolean;
  reason: RouteReason;
  fallbackReason: FallbackReason | null;
}

function route(
  input: EngineRouteInput,
  engine: ConversionEngineId,
  reason: RouteReason,
  fallbackReason: FallbackReason | null,
  capable: boolean,
): EngineRoute {
  return {
    engine,
    preference: input.preference,
    format: normalizeRoutingFormat(input.format),
    available: input.available,
    capable,
    reason,
    fallbackReason,
  };
}

/**
 * The routing table. Pure: no detection, no process, no filesystem.
 *
 * The `textLoss` axis only downgrades text-bearing targets; PDF is excluded
 * because its text is not read back through an adapter.
 */
export function routeConversion(input: EngineRouteInput): EngineRoute {
  const format = normalizeRoutingFormat(input.format);
  const preference = isEnginePreference(input.preference)
    ? input.preference
    : ENGINE_PREFERENCE_DEFAULT;
  const normalized: EngineRouteInput = { ...input, preference, format };
  const capable = LIBREOFFICE_ROUTED_FORMATS.includes(format);

  // 1. An explicit internal preference skips LibreOffice entirely.
  if (preference === "internal") {
    return route(normalized, "internal", "preference-internal", null, capable);
  }

  // 2. Targets LibreOffice should not write: keep the internal adapter and say
  //    why. Plain text is owned by the internal adapter; anything else is not
  //    covered by LibreOffice's writer filter table.
  if (!capable) {
    return route(
      normalized,
      "internal",
      INTERNAL_OWNED_FORMATS.includes(format)
        ? "internal-format"
        : "format-unsupported",
      null,
      capable,
    );
  }

  // 3. No binary: LibreOffice-first has to fall back, typed and reported.
  if (!input.available) {
    return route(
      normalized,
      "internal",
      "engine-unavailable",
      "engine-unavailable",
      capable,
    );
  }

  // 4. Measured text loss: the internal adapter wins. PDF never reaches here
  //    because the caller only supplies `textLoss` for text-bearing targets.
  if (input.textLoss === true && format !== "pdf") {
    return route(normalized, "internal", "text-loss", "text-loss", capable);
  }

  // 5. LibreOffice.
  return route(normalized, "libreoffice", "libreoffice", null, capable);
}

/** Route after a LibreOffice attempt threw; never silently returns LO. */
export function routeAfterFailure(
  input: Omit<EngineRouteInput, "textLoss">,
  failure: FallbackReason,
): EngineRoute {
  const capable = LIBREOFFICE_ROUTED_FORMATS.includes(
    normalizeRoutingFormat(input.format),
  );
  return route(
    { ...input, format: normalizeRoutingFormat(input.format) },
    "internal",
    failure,
    failure,
    capable,
  );
}

/**
 * Maps an engine failure to the typed fallback reason. Unknown errors are
 * `conversion-failed`; only the engine's own timeout/unavailable codes are
 * promoted.
 */
export function fallbackReasonForError(error: unknown): FallbackReason {
  if (error instanceof LibreOfficeError) {
    if (error.code === "ENGINE_TIMEOUT") return "timeout";
    if (error.code === "ENGINE_UNAVAILABLE") return "engine-unavailable";
    return "conversion-failed";
  }
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === "string") {
    if (code === "ENGINE_TIMEOUT") return "timeout";
    if (code === "ENGINE_UNAVAILABLE") return "engine-unavailable";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  return "conversion-failed";
}

/** One-row summary used by `document_engine_status` and the engine matrix. */
export function describeRoute(routeValue: EngineRoute): {
  engine: ConversionEngineId;
  reason: RouteReason;
  fallbackReason: FallbackReason | null;
  preference: EnginePreference;
  available: boolean;
  capable: boolean;
} {
  return {
    engine: routeValue.engine,
    reason: routeValue.reason,
    fallbackReason: routeValue.fallbackReason,
    preference: routeValue.preference,
    available: routeValue.available,
    capable: routeValue.capable,
  };
}
