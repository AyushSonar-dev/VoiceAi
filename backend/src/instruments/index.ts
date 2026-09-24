import { hasStt, transcribeAudio, InstrumentUnavailableError } from "./assemblyai.js";
import { hasTts, synthesizeSpeech } from "./elevenlabs.js";

export { hasStt, transcribeAudio, hasTts, synthesizeSpeech, InstrumentUnavailableError };

export interface InstrumentCapabilities {
  stt: boolean;
  tts: boolean;
}

export function voiceCapabilities(): InstrumentCapabilities {
  return { stt: hasStt(), tts: hasTts() };
}