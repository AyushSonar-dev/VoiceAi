import OpenAI from "openai";
import type { ChatRequest, ChatResponse, Llm } from "./types.js";
import { LlmProviderError } from "./errors.js";
import type { ProviderProfile } from "./providers.js";

/**
 * The one real function-calling client, over the OpenAI wire protocol.
 *
 * This class is vendor-agnostic on purpose: OpenAI, Google's
 * OpenAI-compatibility endpoint (Gemini), Ollama, and compatible gateways all
 * speak the same `chat.completions` + `tools` + `tool_choice` shape, so there is
 * a SINGLE implementation and a SINGLE tool-calling loop. Adding Gemini
 * required no second client and no second copy of the loop — only a different
 * { apiKey, baseUrl, model } triple from ProviderProfile.
 *
 * It also normalizes the provider's reply into this app's own ChatResponse
 * shape, so no caller ever branches on which vendor answered.
 */
export class OpenAiClient implements Llm {
  private client: OpenAI;
  private profile: ProviderProfile;

  /**
   * `maxRetries` is 0 whenever another provider is available to take over.
   * The SDK otherwise retries a 500 twice on its own, so a single dead vendor
   * would absorb 3 attempts (and ~3x the latency) before the fallback was even
   * consulted. Switching vendors is the better use of that time, and it keeps
   * the number of outbound requests predictable: one per provider. With no
   * fallback configured, the SDK's own retry is the only recovery available, so
   * it is left on.
   */
  constructor(profile: ProviderProfile, opts: { hasFallback?: boolean } = {}) {
    if (!profile.apiKey) {
      throw new Error(`Refusing to construct a client for "${profile.name}" with no API key.`);
    }
    this.profile = profile;
    this.client = new OpenAI({
      apiKey: profile.apiKey,
      baseURL: profile.baseUrl || undefined,
      maxRetries: opts.hasFallback ? 0 : 2,
    });
  }

  get provider(): ProviderProfile["name"] {
    return this.profile.name;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.profile.model,
        messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: req.tools?.length ? (req.tools as never) : undefined,
        tool_choice: "auto" as const,
      });
    } catch (err) {
      // Normalized here so the fallback layer only has to inspect one shape.
      throw new LlmProviderError({ provider: this.profile.name, model: this.profile.model, cause: err });
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
