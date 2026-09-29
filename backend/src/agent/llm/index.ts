import { OpenAiClient } from "./openaiClient.js";
import { PlaceholderBrain } from "./placeholderBrain.js";
import { isRecoverableProviderError, LlmProviderError } from "./errors.js";
import { resolveProviderChain } from "./providers.js";
import type { ChatRequest, ChatResponse, Llm } from "./types.js";

let cached: Llm | null = null;

/**
 * Try the preferred provider, then the next one — and only for failures that a
 * different vendor could plausibly fix.
 *
 * This is the WHOLE of the fallback logic. The tool-calling loop above it never
 * learns that two providers exist: it awaits `chat()` and gets back the same
 * normalized ChatResponse either way, so mid-conversation fallback is safe even
 * though earlier tool results in the transcript came from the other vendor.
 *
 * Non-recoverable errors (a malformed tool definition, a bug in our own request)
 * are rethrown untouched, so a real bug is never masked as "provider down".
 */
class FallbackLlm implements Llm {
  private clients: Array<{ profile: ReturnType<typeof resolveProviderChain>[number]; llm: Llm }>;

  constructor(clients: Array<{ profile: ReturnType<typeof resolveProviderChain>[number]; llm: Llm }>) {
    this.clients = clients;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastError: unknown;

    for (let i = 0; i < this.clients.length; i++) {
      const { profile, llm } = this.clients[i];
      try {
        const response = await llm.chat(req);
        if (i > 0) {
          // Say plainly which provider actually answered, so a support log never
          // implies the preferred one was healthy.
          console.warn(`[LLM] provider=${profile.name} model=${profile.model} ok=true fell_back_from=${this.clients[0].profile.name}`);
        }
        return response;
      } catch (err) {
        lastError = err;
        const status = err instanceof LlmProviderError ? err.status : null;
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[LLM] provider=${profile.name} model=${profile.model} status=${status ?? "network"} error=${detail.slice(0, 200)}`);

        const recoverable = err instanceof LlmProviderError ? err.recoverable : isRecoverableProviderError(err);
        const isLast = i === this.clients.length - 1;

        if (!recoverable) {
          // Our bug, or a client-side error. A different vendor would fail the
          // same way, so surface the real cause instead of hiding it.
          throw err;
        }
        if (isLast) break;
        console.warn(`[LLM] Falling back from ${profile.name} to ${this.clients[i + 1].profile.name}`);
      }
    }

    // Every configured provider failed. Re-throw the last real error (not a
    // vague "something went wrong") so the cause stays visible in the log.
    throw lastError ?? new Error("No LLM provider is configured.");
  }
}

/**
 * Build the conversation brain.
 *
 * - LLM_PROVIDER=gemini  -> Gemini only (no OpenAI key needed).
 * - LLM_PROVIDER=openai  -> OpenAI only.
 * - LLM_PROVIDER=auto    -> OpenAI if configured, else Gemini if configured,
 *                           with runtime fallback from one to the other.
 * - no keys at all        -> the clearly-marked PLACEHOLDER brain, over the SAME
 *                           tool-use loop, so the demo and tests still work.
 *
 * A missing OPENAI_API_KEY is never an error; it is simply one fewer provider.
 */
export function createLlm(): Llm {
  if (cached) return cached;

  const chain = resolveProviderChain();

  if (chain.length === 0) {
    console.warn(
      "[LLM] PLACEHOLDER BRAIN: no LLM provider configured — set OPENAI_API_KEY (and optionally OPENAI_BASE_URL / OPENAI_MODEL) " +
        "or GEMINI_API_KEY (and optionally GEMINI_MODEL) for a real LLM. The rule-based placeholder brain is running over the " +
        "real tool-use loop."
    );
    cached = new PlaceholderBrain();
    return cached;
  }

  const hasFallback = chain.length > 1;
  const clients = chain.map((profile) => ({ profile, llm: new OpenAiClient(profile, { hasFallback }) as Llm }));

  console.log(
    `[LLM] provider=${clients[0].profile.name} model=${clients[0].profile.model}` +
      (clients.length > 1 ? ` (fallback: ${clients.slice(1).map((c) => c.profile.name).join(", ")})` : "")
  );

  cached = clients.length > 1 ? new FallbackLlm(clients) : clients[0].llm;
  return cached;
}

// Test hook.
export function __resetLlmForTests(): void {
  cached = null;
}
