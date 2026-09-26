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
  /**
   * Production strictness. By default an unreachable MongoDB degrades to the
   * in-memory store so the app still serves; set REQUIRE_MONGO=true to make an
   * unreachable database a fatal boot error instead.
   */
  requireMongo: process.env.REQUIRE_MONGO === "true",

  assemblyaiKey: process.env.ASSEMBLYAI_API_KEY || "",
  assemblyaiBaseUrl: process.env.ASSEMBLYAI_BASE_URL || "https://api.assemblyai.com",

  // Voice Agent API (agents host): the agent owns STT + LLM + TTS + turn-taking.
  voiceAgentHost: process.env.VOICE_AGENT_HOST || "https://agents.assemblyai.com",
  voiceAgentWsUrl: process.env.VOICE_AGENT_WS_URL || "wss://agents.assemblyai.com/v1/ws",
  voiceTokenTtlSeconds: Number(process.env.VOICE_TOKEN_TTL_SECONDS || 300),
  voiceMaxSessionSeconds: Number(process.env.VOICE_MAX_SESSION_SECONDS || 900),
  voiceId: process.env.VOICE_ID || "ivy",

  elevenLabsKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",

  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  llmModel: process.env.LLM_MODEL || "gpt-4o-mini",

  /**
   * Visual product understanding. Uses the SAME OpenAI-compatible provider and
   * key as the conversation brain (which is already vision-capable) — no second
   * vendor, no second credential. Defaults to a vision-capable model so it
   * works out of the box; override for gateways that expose another one.
   */
  visionModel: process.env.VISION_MODEL || "gpt-4o-mini",
  visionTimeoutMs: Number(process.env.VISION_TIMEOUT_MS || 25000),
  visionImageMaxBytes: Number(process.env.VISION_IMAGE_MAX_BYTES || 6_000_000),

  currency: process.env.CURRENCY || "\u20b9", // RUPEE SIGN
} as const;

export type Config = typeof config;

export const selfOrigin =
  (process.env.SELF_ORIGIN || `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");

export const ALLOWED_CATEGORIES: readonly string[] = CATEGORIES;

export function formatPrice(n: number): string {
  return `${config.currency}${n.toLocaleString("en-IN")}`;
}