import { config } from "../../config.js";

export interface ProviderProfile {
  name: "gemini";
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Gemini's profile, or `null` when GEMINI_API_KEY is unset (placeholder brain runs instead). */
export function geminiProfile(): ProviderProfile | null {
  if (!config.geminiKey) return null;
  return {
    name: "gemini",
    apiKey: config.geminiKey,
    baseUrl: config.geminiBaseUrl,
    model: config.geminiModel,
  };
}

/** The provider that will answer, for capability reporting. */
export function activeProviderName(): "gemini" | "placeholder" {
  return geminiProfile() ? "gemini" : "placeholder";
}
