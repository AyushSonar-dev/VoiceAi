import { config } from "../config.js";
import { InstrumentUnavailableError } from "./assemblyai.js";

const TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

export function hasTts(): boolean {
  return Boolean(config.elevenLabsKey);
}

/**
 * Text-to-speech via ElevenLabs (plan decision: AssemblyAI no longer sells
 * standalone TTS, so the spoken reply is synthesized here). Full integration;
 * gated on ELEVENLABS_API_KEY. Returns audio as a data URL the browser can
 * play directly.
 */
export async function synthesizeSpeech(text: string): Promise<{ audioDataUrl: string; mime: string }> {
  if (!hasTts()) {
    throw new InstrumentUnavailableError(
      "ElevenLabs text-to-speech",
      "Set ELEVENLABS_API_KEY in backend/.env to enable spoken replies."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${TTS_ENDPOINT}/${encodeURIComponent(config.elevenLabsVoiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: config.elevenLabsModel,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS error (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    }

    const mime = res.headers.get("content-type") || "audio/mpeg";
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return { audioDataUrl: `data:${mime};base64,${base64}`, mime };
  } finally {
    clearTimeout(timer);
  }
}