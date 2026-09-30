import { GeminiClient } from "./geminiClient.js";
import { PlaceholderBrain } from "./placeholderBrain.js";
import { geminiProfile } from "./providers.js";
import type { Llm } from "./types.js";

let cached: Llm | null = null;

/**
 * Build the conversation brain: Gemini when GEMINI_API_KEY is set, otherwise the
 * clearly-marked placeholder brain over the SAME tool-use loop, so the demo and
 * tests still work without a key.
 */
export function createLlm(): Llm {
  if (cached) return cached;

  const profile = geminiProfile();
  if (!profile) {
    console.warn(
      "[LLM] PLACEHOLDER BRAIN: GEMINI_API_KEY is not set — the rule-based placeholder brain is running over the real tool-use loop."
    );
    cached = new PlaceholderBrain();
    return cached;
  }

  console.log(`[LLM] provider=${profile.name} model=${profile.model}`);
  cached = new GeminiClient(profile);
  return cached;
}

// Test hook.
export function __resetLlmForTests(): void {
  cached = null;
}
