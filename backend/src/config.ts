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
  voiceId: process.env.VOICE_ID || "jane",

  elevenLabsKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
  // Voice settings for natural, human-like speech (multilingual v2 supports bilingual)
  elevenLabsStability: Number(process.env.ELEVENLABS_STABILITY || 0.4),
  elevenLabsSimilarityBoost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.85),
  elevenLabsStyle: Number(process.env.ELEVENLABS_STYLE || 0.6),
  elevenLabsUseSpeakerBoost: process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false",

  // LLM for the text/demo path (the live voice path uses AssemblyAI's own LLM).
  geminiKey: process.env.GEMINI_API_KEY || "",
  /**
   * Google's official OpenAI-compatibility endpoint. The `openai` SDK appends
   * `/chat/completions` to this, which is the documented shape.
   */
  geminiBaseUrl: (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",

  currency: process.env.CURRENCY || "\u20b9", // RUPEE SIGN

  // ---------------------------------------------------------------------
  // AUTH / SESSION
  // ---------------------------------------------------------------------
  // Frontend origin for CORS and cookie configuration.
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  // Secret for signing session tokens. In production, set a strong random value.
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
  // Session token cookie name
  sessionCookieName: "echolabs_session",
} as const;

export type Config = typeof config;

export const selfOrigin =
  (process.env.SELF_ORIGIN || `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");

export const ALLOWED_CATEGORIES: readonly string[] = CATEGORIES;

export function formatPrice(n: number): string {
  return `${config.currency}${n.toLocaleString("en-IN")}`;
}