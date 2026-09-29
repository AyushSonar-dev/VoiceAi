import { config, type LlmProviderName } from "../../config.js";

/**
 * Everything needed to talk to one vendor. Both providers implement the same
 * OpenAI wire protocol, so this is the ONLY place that knows a vendor exists
 * as a distinct thing — the client, the tool loop, and the tools are shared.
 */
export interface ProviderProfile {
  /** Vendor id, used for logs and capability reporting. Never a secret. */
  name: LlmProviderName;
  apiKey: string;
  baseUrl: string;
  /** Chat model for the tool-calling loop. */
  model: string;
  /**
   * Whether this vendor accepts `response_format: { type: "json_object" }`.
   * OpenAI does; a gateway may not, so the hint is dropped on rejection
   * rather than failing the request.
   */
  supportsResponseFormat: boolean;
}

/**
 * Resolve a vendor into a profile, or `null` when it has no API key.
 *
 * A missing key is NOT an error: it just means this vendor is unavailable, and
 * the caller decides whether to try the next one. This is what lets the app run
 * with only GEMINI_API_KEY, or with only OPENAI_API_KEY, or with neither.
 */
export function resolveProfile(name: LlmProviderName): ProviderProfile | null {
  if (name === "gemini") {
    if (!config.geminiKey) return null;
    return {
      name: "gemini",
      apiKey: config.geminiKey,
      baseUrl: config.geminiBaseUrl,
      model: config.geminiModel,
      // Google's compatibility layer accepts json_object, but it is documented
      // as having gaps; the client can drop it on rejection.
      supportsResponseFormat: true,
    };
  }
  if (!config.openaiKey) return null;
  return {
    name: "openai",
    apiKey: config.openaiKey,
    // An explicit base URL also covers Ollama and other compatible gateways.
    baseUrl: process.env.OPENAI_BASE_URL ? config.openaiBaseUrl : "",
    model: config.openaiModel,
    supportsResponseFormat: true,
  };
}

/**
 * The providers to try, in order.
 *
 * - "openai" / "gemini": only that vendor, and ONLY if it is configured. If it
 *   is not, the list is empty and the app uses the placeholder brain. Pinning a
 *   provider therefore never silently switches vendors behind the user's back.
 * - "auto": OpenAI when it has a key, then Gemini when it has one. A missing
 *   OpenAI key is the normal way to end up on Gemini, with no warning and no
 *   crash.
 *
 * Only configured vendors appear, so a provider with no key is never called.
 */
export function resolveProviderChain(): ProviderProfile[] {
  const setting = config.llmProvider;
  const order: LlmProviderName[] =
    setting === "openai" ? ["openai"] : setting === "gemini" ? ["gemini"] : ["openai", "gemini"];

  return order.map(resolveProfile).filter((p): p is ProviderProfile => p !== null);
}

/** The provider that will actually answer first, for capability reporting. */
export function activeProviderName(): LlmProviderName | "placeholder" {
  return resolveProviderChain()[0]?.name ?? "placeholder";
}
