import { Router, type Request, type Response } from "express";
import { runTurn } from "../agent/agent.js";
import { pickFiller, buildVoiceAgentSystemPrompt } from "../agent/prompts.js";
import { transcribeAudio, synthesizeSpeech, hasTts, InstrumentUnavailableError } from "../instruments/index.js";
import { buildState } from "./state.js";
import { config } from "../config.js";
import { VOICE_AGENT_TOOL_DEFINITIONS } from "../tools/index.js";

export interface VoiceRequest {
  sessionId?: string;
  audioBase64?: string;
  mimeType?: string;
  /** DEMO FALLBACK: used only when AssemblyAI STT is not configured. */
  text?: string;
}

type SseEvent =
  | { type: "turn"; payload: { userText: string } }
  | { type: "filler"; payload: { text: string; audioUrl: string | null } }
  | { type: "final"; payload: { reply: string; audioUrl: string | null; state: Awaited<ReturnType<typeof buildState>> } }
  | { type: "error"; payload: { message: string } };

function sse(res: Response, event: SseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Keyless demo fallback: the custom transcription -> loop -> TTS orchestration
 * from the pre-Voice-Agent days, served ONLY when ASSEMBLYAI_API_KEY is unset
 * so a repo without secrets can still be exercised. This is the *only* place
 * that hand-rolled pipeline is allowed to run.
 */
async function demoTurnSse(req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const body = (req.body ?? {}) as VoiceRequest;

  if (!body.sessionId) {
    sse(res, { type: "error", payload: { message: "No session was found. Refresh the page and try again." } });
    res.end();
    return;
  }

  let userText = "";
  try {
    if (body.audioBase64) {
      const audio = Buffer.from(body.audioBase64, "base64");
      const result = await transcribeAudio(audio);
      userText = result.text;
      if (!userText.trim()) {
        sse(res, { type: "error", payload: { message: "I didn't catch any speech. Could you try again?" } });
        res.end();
        return;
      }
    } else if (body.text && body.text.trim()) {
      userText = String(body.text).trim();
    } else {
      sse(res, { type: "error", payload: { message: "No audio or text was received." } });
      res.end();
      return;
    }
  } catch (err) {
    const msg =
      err instanceof InstrumentUnavailableError
        ? "Speech recognition isn't configured yet. Type your request instead, or set the AssemblyAI key."
        : "Speech recognition failed. Please try once more.";
    console.error("[ECHOLABS] STT failed (demo):", err instanceof Error ? err.message : err);
    sse(res, { type: "error", payload: { message: msg } });
    res.end();
    return;
  }

  sse(res, { type: "turn", payload: { userText } });

  // ---- filler (voice UX: say something before slow tool calls return) ----
  let fillerSent = false;
  const onToolCall = async () => {
    if (fillerSent) return;
    fillerSent = true;
    try {
      const text = pickFiller();
      if (hasTts()) {
        const audio = await synthesizeSpeech(text);
        sse(res, { type: "filler", payload: { text, audioUrl: audio.audioDataUrl } });
      } else {
        sse(res, { type: "filler", payload: { text, audioUrl: null } });
      }
    } catch {
      sse(res, { type: "filler", payload: { text: "Let me check that.", audioUrl: null } });
    }
  };

  let result;
  try {
    result = await runTurn({ sessionId: body.sessionId, userText, onToolCall });
  } catch (err) {
    console.error("[ECHOLABS] loop failed (demo):", err);
    sse(res, {
      type: "error",
      payload: { message: "I hit an internal error while processing that. Nothing has been changed — please ask me again." },
    });
    res.end();
    return;
  }

  const reply = result.reply || "Just a moment.";

  let audioUrl: string | null = null;
  if (hasTts() && reply.trim()) {
    try {
      audioUrl = (await synthesizeSpeech(reply)).audioDataUrl;
    } catch (err) {
      console.error("[ECHOLABS] TTS failed (demo):", err instanceof Error ? err.message : err);
    }
  }

  const state = await buildState(body.sessionId);
  sse(res, { type: "final", payload: { reply, audioUrl, state } });
  res.end();
}

/**
 * POST /api/voice/setup — the ONLY server-side setup for the real voice path.
 * Mints a short-lived single-use token from AssemblyAI's Voice Agent API and
 * returns the inline session configuration (system prompt + tools + audio +
 * turn detection + voice). The browser then opens a DIRECT WebSocket to
 * wss://agents.assemblyai.com/v1/ws with ?token=... and that connection owns
 * STT, LLM routing, TTS and turn-taking/VAD. Our Express backend only supplies
 * the token/config here and the /api/tools/:name gateway — it never runs a
 * transcription, LLM loop, or TTS itself.
 */
export function voiceAgentSetupBody(): {
  session: {
    system_prompt: string;
    greeting: string;
    tools: typeof VOICE_AGENT_TOOL_DEFINITIONS;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  };
} {
  return {
    session: {
      system_prompt: buildVoiceAgentSystemPrompt(),
      greeting:
        "Hi, I'm Echo. Ask me to find a product, add things to your cart, apply a coupon, or check out — all by voice. What are you looking for today?",
      tools: VOICE_AGENT_TOOL_DEFINITIONS,
      input: {
        format: { encoding: "audio/pcm" },
        language_codes: ["en"],
        transcription_prompt:
          "A shopping assistant conversation. Product names include Diamond-Cut Tennis Bracelet, Pearl Drop Earrings, Turquoise Stud Earrings, Onyx Bead Necklace, Vision 4K TV Stick, QuietWave Budget Earbuds, Canvas Crossbody, Silk Blend Saree, Terry Crew Tee, and similar. Codes: WELCOME15, SAVE10, VIP20, FLASH25.",
        keyterms: [
          "bracelet", "earrings", "necklace", "saree", "earbuds", "television", "tshirt", "jeans",
          "backpack", "watch", "gift", "cart", "coupon", "checkout", "WELCOME15", "SAVE10", "VIP20",
        ],
        turn_detection: {
          vad_threshold: 0.5,
          min_silence: 700,
          max_silence: 3500,
          interrupt_response: true,
          interruption_delay: 120,
        },
      },
      output: {
        voice: config.voiceId,
        format: { encoding: "audio/pcm" },
        volume: 100,
      },
    },
  };
}

export function voiceRouter(): Router {
  const router = Router();

  router.post("/voice/setup", async (_req, res) => {
    if (!config.assemblyaiKey) {
      res.status(503).json({
        error: true,
        code: "voice_not_configured",
        message: "ASSEMBLYAI_API_KEY is not set — the real voice path is unavailable. Use demo mode.",
        demo: true,
      });
      return;
    }
    try {
      const url = new URL(`${config.voiceAgentHost}/v1/token`);
      url.searchParams.set("expires_in_seconds", String(config.voiceTokenTtlSeconds));
      url.searchParams.set("max_session_duration_seconds", String(config.voiceMaxSessionSeconds));
      const tokenRes = await fetch(url, {
        headers: { Authorization: `Bearer ${config.assemblyaiKey}` },
      });
      if (!tokenRes.ok) {
        const detail = await tokenRes.text().catch(() => "");
        console.error(`[ECHOLABS] token mint failed (HTTP ${tokenRes.status}): ${detail.slice(0, 200)}`);
        res.status(502).json({
          error: true,
          code: "token_mint_failed",
          message: "Could not mint a Voice Agent token. Check ASSEMBLYAI_API_KEY and account scope.",
          detail: detail.slice(0, 300),
        });
        return;
      }
      const { token } = (await tokenRes.json()) as { token: string };
      res.json({ token, session: voiceAgentSetupBody().session });
    } catch (err) {
      console.error("[ECHOLABS] voice setup failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: true, code: "setup_failed", message: "Voice setup failed." });
    }
  });

  /**
   * POST /api/voice — LEGACY demo fallback (SSE orchestrator with a custom
   * transcription loop). It is ONLY served when AssemblyAI's Voice Agent is NOT
   * configured: in real mode, this endpoint refuses so nothing accidentally
   * runs down the hand-rolled STT->LLM-loop->TTS path.
   */
  router.post("/voice", async (req, res) => {
    if (config.assemblyaiKey) {
      res.status(409).json({
        error: true,
        code: "use_voice_agent",
        message: "Real voice is live: use the Voice Agent API (POST /api/voice/setup) instead of the demo SSE path.",
      });
      return;
    }
    await demoTurnSse(req, res);
  });

  return router;
}