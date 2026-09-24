"use client";

import { useEffect, useState, type FormEvent } from "react";

interface Props {
  sttAvailable: boolean;
  ttsAvailable: boolean;
  busy: boolean;
  recording: boolean;
  onMicToggle: () => void;
  onSubmitText: (text: string) => void;
  lastUserText: string;
}

export function VoicePanel({
  sttAvailable,
  ttsAvailable,
  busy,
  recording,
  onMicToggle,
  onSubmitText,
  lastUserText,
}: Props) {
  const [draft, setDraft] = useState("");
  const [mediaSupported, setMediaSupported] = useState(true);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setMediaSupported(!!navigator.mediaDevices?.getUserMedia);
    }
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    onSubmitText(text);
    setDraft("");
  };

  const canRecord = sttAvailable && mediaSupported && !busy;

  return (
    <div className="card" aria-labelledby="voice-heading">
      <div className="row spread">
        <h2 id="voice-heading">Talk to Echo</h2>
        <p className="transcript" style={{ margin: 0 }}>
          STT: {sttAvailable ? "AssemblyAI" : "demo text"} · TTS: {ttsAvailable ? "ElevenLabs" : "browser voice"}
        </p>
      </div>

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={`btn micBtn${recording ? " recording" : ""}`}
          onClick={onMicToggle}
          disabled={!canRecord}
          aria-label={recording ? "Stop recording" : "Start voice recording"}
          title={
            !sttAvailable
              ? "Voice input needs the AssemblyAI key — use the text box below."
              : !mediaSupported
                ? "This browser can't capture audio — use the text box below."
                : recording
                  ? "Stop recording"
                  : "Start voice recording"
          }
        >
          {recording ? "Stop" : "Mic"}
        </button>

        <span aria-live="polite" className="transcript" data-testid="mic-status">
          {recording ? "Listening… speak now." : busy ? "Thinking…" : "Tap the mic or type below."}
        </span>
      </div>

      {!sttAvailable && (
        <p className="transcript" style={{ marginTop: 0 }}>
          DEMO FALLBACK: voice isn&apos;t configured yet, so you can type what you would say out loud.
        </p>
      )}

      <form onSubmit={submit} className="row" role="search" aria-label="Type a request for Echo">
        <label className="sr-only" htmlFor="voice-input">
          What would you like to shop for?
        </label>
        <input
          id="voice-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. show me bracelets under 2000 rupees"
          disabled={busy}
          autoComplete="off"
        />
        <button type="submit" className="btn primary" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>

      {lastUserText && (
        <p className="transcript" style={{ marginBottom: 0 }}>
          You said: “{lastUserText}”
        </p>
      )}
    </div>
  );
}