import { AssemblyAI } from "assemblyai";
import { config } from "../config.js";

export class InstrumentUnavailableError extends Error {
  code = "instrument_unavailable";
  constructor(service: string, hint: string) {
    super(`${service} is not configured. ${hint}`);
  }
}

export function hasStt(): boolean {
  return Boolean(config.assemblyaiKey);
}

/**
 * Speech-to-text via AssemblyAI (Universal-1 / pre-recorded API).
 * Full integration; gated on ASSEMBLYAI_API_KEY. Until the key is provided the
 * voice endpoint falls back to a clearly-marked `text` input (demo mode).
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<{ text: string; confidence?: number }> {
  if (!hasStt()) {
    throw new InstrumentUnavailableError(
      "AssemblyAI speech-to-text",
      "Set ASSEMBLYAI_API_KEY in backend/.env to enable voice transcription."
    );
  }
  const client = new AssemblyAI({
    apiKey: config.assemblyaiKey,
    baseUrl: config.assemblyaiBaseUrl,
  });

  const transcript = await client.transcripts.transcribe({ audio: audioBuffer });

  if (transcript.status === "error") {
    throw new InstrumentUnavailableError("AssemblyAI transcription", transcript.error ?? "transcription failed");
  }
  return { text: transcript.text ?? "", confidence: transcript.confidence ?? undefined };
}