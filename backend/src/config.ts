import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load repo-root .env first, then a backend-local .env.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const config = {
  port: Number(process.env.PORT || 4000),

  mongoUri: process.env.MONGODB_URI || "",

  assemblyaiKey: process.env.ASSEMBLYAI_API_KEY || "",
  assemblyaiBaseUrl: process.env.ASSEMBLYAI_BASE_URL || "https://api.assemblyai.com",

  elevenLabsKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",

  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  llmModel: process.env.LLM_MODEL || "gpt-4o-mini",

  currency: process.env.CURRENCY || "\u20b9", // RUPEE SIGN
} as const;

export type Config = typeof config;

export const selfOrigin =
  (process.env.SELF_ORIGIN || `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");

export const ALLOWED_CATEGORIES: readonly string[] = CATEGORIES;

export function formatPrice(n: number): string {
  return `${config.currency}${n.toLocaleString("en-IN")}`;
}