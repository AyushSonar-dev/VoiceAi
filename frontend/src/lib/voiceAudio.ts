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
      // True RMS of the real input block, sent alongside the audio so the UI can
      // drive visual state from actual signal level instead of a fake animation.
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const sample = input[Math.floor(i * this.ratio)] ?? 0;
        sum += sample * sample;
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }
      const rms = n > 0 ? Math.sqrt(sum / n) : 0;
      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("echolabs-pcm", EchoPcmProcessor);
`;

/**
 * Normalise a raw RMS into 0..1. Speech sits well below full scale, so this is
 * a gentle curve with a noise floor: it must ignore room tone and never peg at
 * 1 for ordinary talking.
 */
export function rmsToLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const FLOOR = 0.008;
  if (rms <= FLOOR) return 0;
  const scaled = Math.min(1, (rms - FLOOR) / 0.22);
  return Math.min(1, scaled * scaled * 1.35);
}

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
  /**
   * Real input level 0..1 for the same block. This is measured from the
   * microphone signal, so the interface can react to actual speech rather than
   * running a loop that pretends to be an audio meter.
   */
  setOnLevel: (report: (level: number) => void) => void;
  stop: () => void;
}

interface WorkletFrame {
  pcm: ArrayBuffer;
  rms: number;
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

  // One port, many listeners: assigning onmessage twice would silently drop
  // either the audio stream or the level meter.
  let sendPcm: ((base64: string) => void) | null = null;
  let reportLevel: ((level: number) => void) | null = null;
  worklet.port.onmessage = (e: MessageEvent<WorkletFrame>) => {
    const frame = e.data;
    if (!frame) return;
    if (reportLevel) reportLevel(rmsToLevel(frame.rms));
    if (sendPcm && frame.pcm) sendPcm(int16ToBase64(new Int16Array(frame.pcm)));
  };

  const mic: VoiceMic = {
    context,
    setOnPcm: (send) => {
      sendPcm = send;
    },
    setOnLevel: (report) => {
      reportLevel = report;
    },
    stop: () => {
      sendPcm = null;
      reportLevel = null;
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

export interface VoicePlayerOptions {
  /**
   * Real output level 0..1, reported from the PCM actually scheduled for
   * playback (and decayed to 0 once the queue drains), so "speaking" visuals
   * follow the agent's actual voice.
   */
  onLevel?: (level: number) => void;
}

export function createPlayer(context: AudioContext, options: VoicePlayerOptions = {}): VoicePlayer {
  let playbackTime = context.currentTime;
  const { onLevel } = options;
  // Queue of { at, duration, peak } so the level meter decays to silence when
  // the scheduled audio has actually finished, not on an arbitrary timer.
  let queue: Array<{ at: number; duration: number; peak: number }> = [];
  let raf = 0;

  const stopMeter = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const meter = () => {
    const now = context.currentTime;
    queue = queue.filter((q) => q.at + q.duration > now);
    let peak = 0;
    for (const q of queue) peak = Math.max(peak, q.peak);
    // Ease the tail off over the last 120 ms of audio for a natural release.
    let level = peak;
    if (peak > 0) {
      const soonest = queue.reduce((a, b) => (a.at < b.at ? a : b));
      const remaining = soonest.at + soonest.duration - now;
      if (remaining < 0.12) level = peak * (remaining / 0.12);
    }
    onLevel?.(Math.max(0, Math.min(1, level)));
    if (queue.length > 0) {
      raf = requestAnimationFrame(meter);
    } else {
      stopMeter();
      onLevel?.(0);
    }
  };

  const ensureMeter = () => {
    if (!onLevel || raf) return;
    raf = requestAnimationFrame(meter);
  };

  return {
    play: (base64) => {
      const pcm = base64ToPcm16(base64);
      const float32 = new Float32Array(pcm.length);
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) {
        float32[i] = pcm[i] / 32768;
        sum += float32[i] * float32[i];
      }
      const peak = pcm.length > 0 ? Math.sqrt(sum / pcm.length) : 0;

      const buffer = context.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);
      const src = context.createBufferSource();
      src.buffer = buffer;
      src.connect(context.destination);

      const now = context.currentTime;
      playbackTime = Math.max(playbackTime, now);
      src.start(playbackTime);
      queue.push({ at: playbackTime, duration: buffer.duration, peak: rmsToLevel(peak) });
      playbackTime += buffer.duration;
      ensureMeter();
    },
    flush: () => {
      playbackTime = context.currentTime;
      queue = [];
      stopMeter();
      onLevel?.(0);
    },
  };
}