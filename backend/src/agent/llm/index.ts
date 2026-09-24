import { config } from "../../config.js";
import { OpenAiClient } from "./openaiClient.js";
import { PlaceholderBrain } from "./placeholderBrain.js";
import type { Llm } from "./types.js";

let cached: Llm | null = null;

/**
 * Build the conversation brain.
 * - OPENAI_API_KEY set   -> real OpenAI-compatible function-calling client.
 * - OPENAI_API_KEY unset -> clearly-marked PLACEHOLDER brain over the SAME
 *   tool-use loop, so the demo and tests exercise the real loop end-to-end.
 */
export function createLlm(): Llm {
  if (cached) return cached;
  if (config.openaiKey) {
    cached = new OpenAiClient();
  } else {
    console.warn(
      "[ECHOLABS] PLACEHOLDER BRAIN: OPENAI_API_KEY not set — using the rule-based placeholder brain " +
        "over the real tool-use loop. Set OPENAI_API_KEY (and OPENAI_BASE_URL if needed) for the real LLM."
    );
    cached = new PlaceholderBrain();
  }
  return cached;
}

// Test hook.
export function __resetLlmForTests(): void {
  cached = null;
}