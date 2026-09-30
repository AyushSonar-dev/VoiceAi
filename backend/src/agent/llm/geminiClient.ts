// The `openai` package is only the wire client: Gemini is reached through
// Google's OpenAI-compatible endpoint (config.geminiBaseUrl).
import OpenAI from "openai";
import type { ChatRequest, ChatResponse, Llm } from "./types.js";
import { LlmProviderError, isRecoverableProviderError } from "./errors.js";
import type { ProviderProfile } from "./providers.js";
import { CircuitBreaker } from "../../middleware/circuitBreaker.js";

/** Only a provider outage should trip the breaker — not our own bad request or a bad key. */
function isOutage(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return false;
  return isRecoverableProviderError(err);
}

/** Function-calling chat client for Gemini, normalized into the app's ChatResponse shape. */
export class GeminiClient implements Llm {
  private client: OpenAI;
  private profile: ProviderProfile;
  private breaker: CircuitBreaker;

  constructor(profile: ProviderProfile) {
    if (!profile.apiKey) {
      throw new Error(`Refusing to construct a client for "${profile.name}" with no API key.`);
    }
    this.profile = profile;
    this.breaker = new CircuitBreaker({
      name: `llm-${profile.name}`,
      failureThreshold: 5,
      windowMs: 30_000,
      resetTimeoutMs: 15_000,
      isFailure: isOutage,
    });
    this.client = new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 2 });
  }

  get provider(): ProviderProfile["name"] {
    return this.profile.name;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.breaker.call(() =>
        this.client.chat.completions.create({
          model: this.profile.model,
          messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          tools: req.tools?.length ? (req.tools as never) : undefined,
          tool_choice: "auto" as const,
        })
      );
    } catch (err) {
      const wrapped = new LlmProviderError({ provider: this.profile.name, model: this.profile.model, cause: err });
      console.error(`[LLM] provider=${this.profile.name} model=${this.profile.model} status=${wrapped.status ?? "network"} error=${wrapped.message.slice(0, 200)}`);
      throw wrapped;
    }

    const m = completion.choices[0]?.message;
    if (!m) return { message: { role: "assistant", content: "" } };

    return {
      message: {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.tool_calls?.length
          ? m.tool_calls.map((tc) => ({
              id: tc.id,
              function: {
                name: tc.function.name ?? "",
                arguments: tc.function.arguments ?? "{}",
              },
            }))
          : null,
      },
    };
  }
}
