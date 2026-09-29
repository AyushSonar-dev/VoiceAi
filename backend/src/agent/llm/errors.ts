import type { LlmProviderName } from "../../config.js";

/**
 * Provider errors are classified, not blanket-caught.
 *
 * Falling back is only correct when the SAME request would plausibly succeed on
 * a different vendor: bad credentials, exhausted quota, rate limiting, or the
 * provider being down. A 400 from a malformed tool definition is our bug — it
 * would fail identically on Gemini, so retrying it there would only bury the
 * real error behind a second, more confusing one.
 */

/** HTTP statuses worth retrying on a different vendor. */
const RECOVERABLE_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504, 529]);

/** Transport-level failures: the request never got an answer. */
const NETWORK_HINTS = [
  "connection error",
  "fetch failed",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "socket hang up",
  "network",
  "timeout",
];

/** Extract an HTTP status from an OpenAI SDK error, if it has one. */
function statusOf(err: unknown): number | null {
  const anyErr = err as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  for (const candidate of [anyErr?.status, anyErr?.statusCode]) {
    if (typeof candidate === "number") return candidate;
  }
  const code = anyErr?.code;
  if (typeof code === "string" && /^\d{3}$/.test(code)) return Number(code);
  const msg = typeof anyErr?.message === "string" ? anyErr.message : "";
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Whether this failure justifies trying the next provider.
 *
 * True for auth, quota, rate-limit, transport and 5xx failures. False for
 * programming errors, malformed tool definitions, and client-side 4xx
 * (400/404/422) — those are bugs or misconfiguration, and retrying them
 * elsewhere only hides the cause.
 */
export function isRecoverableProviderError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== null) {
    if (RECOVERABLE_STATUS.has(status)) return true;
    // 4xx that is not auth/rate related is our request, not the provider.
    if (status >= 400 && status < 500) return false;
    // 5xx we do not recognise is still the provider's problem.
    return status >= 500;
  }

  // No status at all: either a transport failure, or a genuine programming
  // error (TypeError, ReferenceError, ...) which must NOT be swallowed.
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
    return false;
  }
  // The OpenAI SDK's connection errors set `name: "Error"` and carry the real
  // identity on the constructor, so both are checked — otherwise a dead network
  // silently stops being a fallback candidate.
  const identities = [`${(err as { name?: string } | null)?.name ?? ""}`, `${err?.constructor?.name ?? ""}`];
  if (
    identities.some((id) => id === "APIConnectionTimeoutError" || id === "APIConnectionError")
  ) {
    return true;
  }

  const message = err instanceof Error ? err.message : String(err ?? "");
  const lowered = `${message} ${identities.join(" ")}`.toLowerCase();
  return NETWORK_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * Strip anything key-shaped out of a message before it reaches a log.
 *
 * Providers sometimes echo the request (including the Authorization header) back
 * in an error body. This is a last line of defence so a key cannot reach the
 * log even if a vendor is careless.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "[redacted-key]")
    .replace(/((?:api[_-]?key|authorization|bearer|token)["'\s:=]{1,6})[^\s,;"'}]{6,}/gi, "$1[redacted]")
    .slice(0, 300);
}

/** A provider call failed. Carries the vendor/model for actionable logs. */
export class LlmProviderError extends Error {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly status: number | null;
  readonly recoverable: boolean;

  constructor(input: { provider: LlmProviderName; model: string; cause: unknown }) {
    const detail = redactSecrets(input.cause instanceof Error ? input.cause.message : String(input.cause));
    super(`llm_${input.provider}_failed: ${statusOf(input.cause) ?? "network"} ${detail}`);
    this.name = "LlmProviderError";
    this.provider = input.provider;
    this.model = input.model;
    this.status = statusOf(input.cause);
    this.recoverable = isRecoverableProviderError(input.cause);
  }

  /** Short, secret-free line for the server log. */
  logFields(): Record<string, string | number | boolean | null> {
    return {
      provider: this.provider,
      model: this.model,
      status: this.status,
      error: this.message.slice(0, 200),
      recoverable: this.recoverable,
    };
  }
}
