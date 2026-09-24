import OpenAI from "openai";
import { config } from "../../config.js";
import type { Llm, ChatRequest, ChatResponse } from "./types.js";

/**
 * Real function-calling client over an OpenAI-compatible endpoint.
 * Works with OpenAI, Ollama (OPENAI_BASE_URL), and compatible gateways.
 * Fails loudly if called without a key — the factory in llm/index.ts only
 * constructs this when OPENAI_API_KEY is present.
 */
export class OpenAiClient implements Llm {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.openaiKey,
      baseURL: config.openaiBaseUrl || undefined,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const completion = await this.client.chat.completions.create({
      model: config.llmModel,
      messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: req.tools?.length ? (req.tools as never) : undefined,
      tool_choice: "auto" as const,
    });

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