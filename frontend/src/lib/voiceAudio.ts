/**
 * Browser audio pipeline for the real Voice Agent path:
 *  - capture: getUserMedia -> AudioWorklet that downsamples to 24 kHz mono and
 *    emits Int16 PCM chunks (the exact wire format AssemblyAI expects).
 *  - playback: decode base64 PCM16 reply.audio chunks and schedule them on a
 *    24 kHz AudioBuffer so the browser resamples on output.
 *
 * Uses the default-rate AudioContext with in-worklet resampling so Firefox
 * keeps echo cancellation and Safari keeps correct pitch (per the Voice Agent
 * browser-integration docs: forcing 24 kHz only works on Chromium).
 */

const WORKLET_PROCESSOR = /* js */ `
class EchoPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      const n = Math.floor(input.length / this.ratio);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const sample = input[Math.floor(i * this.ratio)] ?? 0;
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("echolabs-pcm", EchoPcmProcessor);
`;

let moduleUrl: string | null = null;
async function getProcessorModuleUrl(): Promise<string> {
  if (!moduleUrl) {
    const blob = new Blob([WORKLET_PROCESSOR], { type: "text/javascript" });
    moduleUrl = URL.createObjectURL(blob);
  }
  return moduleUrl;
}

export interface VoiceMic {
  context: AudioContext;
  /** Call with the base64-encoded PCM16 chunks via setOnPcm. */
  setOnPcm: (send: (base64: string) => void) => void;
  stop: () => void;
}

export async function startCapture(): Promise<VoiceMic> {
  const context = new AudioContext();
  if (context.state === "suspended") await context.resume();

  const url = await getProcessorModuleUrl();
  await context.audioWorklet.addModule(url);
  const worklet = new AudioWorkletNode(context, "echolabs-pcm");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false },
  });
  const source = context.createMediaStreamSource(stream);
  source.connect(worklet);

  const mic: VoiceMic = {
    context,
    setOnPcm: (send) => {
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        send(int16ToBase64(new Int16Array(e.data)));
      };
    },
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      worklet.disconnect();
      source.disconnect();
      void context.close().catch(() => undefined);
    },
  };
  return mic;
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin);
}

function base64ToPcm16(base64: string): Int16Array {
  const raw = atob(base64);
  const pcm = new Int16Array(raw.length / 2);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
  }
  return pcm;
}

export interface VoicePlayer {
  play: (pcm16Base64: string) => void;
  flush: () => void;
}

export function createPlayer(context: AudioContext): VoicePlayer {
  let playbackTime = context.currentTime;

  return {
    play: (base64) => {
      const pcm = base64ToPcm16(base64);
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;

      const buffer = context.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);
      const src = context.createBufferSource();
      src.buffer = buffer;
      src.connect(context.destination);

      const now = context.currentTime;
      playbackTime = Math.max(playbackTime, now);
      src.start(playbackTime);
      playbackTime += buffer.duration;
    },
    flush: () => {
      playbackTime = context.currentTime;
    },
  };
}