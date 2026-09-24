import { Router, type Response } from "express";
import { runTurn } from "../agent/agent.js";
import { pickFiller } from "../agent/prompts.js";
import { transcribeAudio, synthesizeSpeech, hasTts, InstrumentUnavailableError } from "../instruments/index.js";
import { buildState } from "./state.js";

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

export function voiceRouter(): Router {
  const router = Router();

  /**
   * POST /api/voice
   * Full-turn orchestrator: STT (AssemblyAI) -> tool-use loop (LLM) -> TTS
   * (ElevenLabs) -> SSE events for a live region + synced UI state.
   *
   * The spoken reply is TTS'd ONLY after the backend-confirmed loop result; the
   * reply text is derived from tool results, never guessed.
   */
  router.post("/voice", async (req, res) => {
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

    // ---- STT: real audio goes to AssemblyAI; keyless demo accepts text ----
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
      console.error("[ECHOLABS] STT failed:", err instanceof Error ? err.message : err);
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

    // ---- the real tool-use loop; reply exists only after backend results ----
    let result;
    try {
      result = await runTurn({ sessionId: body.sessionId, userText, onToolCall });
    } catch (err) {
      console.error("[ECHOLABS] loop failed:", err);
      sse(res, {
        type: "error",
        payload: {
          message:
            "I hit an internal error while processing that. Nothing has been changed — please ask me again.",
        },
      });
      res.end();
      return;
    }

    const reply = result.reply || "Just a moment.";

    // ---- TTS (ElevenLabs); absent key -> browser speech fallback on the UI ----
    let audioUrl: string | null = null;
    if (hasTts() && reply.trim()) {
      try {
        audioUrl = (await synthesizeSpeech(reply)).audioDataUrl;
      } catch (err) {
        console.error("[ECHOLABS] TTS failed:", err instanceof Error ? err.message : err);
      }
    }

    const state = await buildState(body.sessionId);
    sse(res, { type: "final", payload: { reply, audioUrl, state } });
    res.end();
  });

  return router;
}