export interface RecordingHandle {
  stop: () => Promise<string | undefined>;
}

function pickMime(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const mime of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string | null;
      if (typeof result !== "string") {
        reject(new Error("failed to read recording"));
        return;
      }
      // Strip the data:...;base64, prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function startRecording(): Promise<RecordingHandle> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("media capture not supported in this browser");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();

  return {
    stop: () =>
      new Promise<string | undefined>((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
          blobToBase64(blob).then(resolve).catch(() => resolve(undefined));
        };
        recorder.stop();
      }),
  };
}

/**
 * DEMO FALLBACK: browser-native speech synthesis, used only when the ElevenLabs
 * key is absent (audioUrl is null). Kept visibly separate from the real TTS path.
 */
export function fallbackSpeak(text: string, opts: { rate: number; pitch: number }): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-IN";
  utter.rate = opts.rate;
  utter.pitch = opts.pitch;
  window.speechSynthesis.speak(utter);
}

export function isMediaSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}