"use client";

import { useEffect, useState, type FormEvent } from "react";

export type AgentStatusShown = "connecting" | "listening" | "thinking" | "ended" | "error";

interface Props {
  sttAvailable: boolean;
  ttsAvailable: boolean;
  /** true when the real AssemblyAI Voice Agent backend is configured */
  voiceAgent: boolean;
  busy: boolean;
  recording: boolean;
  agentStatus: AgentStatusShown | null;
  onMicToggle: () => void;
  onSubmitText: (text: string) => void;
  lastUserText: string;
}

function statusText(status: AgentStatusShown | null, recording: boolean): string {
  if (recording) return "Listening… speak now.";
  switch (status) {
    case "connecting":
      return "Connecting to the voice agent…";
    case "thinking":
      return "Thinking…";
    case "error":
      return "The voice agent hit an error. Try again.";
    case "ended":
      return "Call ended. Tap the mic or type to start again.";
    case "listening":
      return "Connected — speak or type.";
    default:
      return "Tap the mic or type below.";
  }
}

export function VoicePanel({
  sttAvailable,
  ttsAvailable,
  voiceAgent,
  busy,
  recording,
  agentStatus,
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

  const micUsable = (voiceAgent || sttAvailable) && mediaSupported;
  const canMic = micUsable && !busy;
  const demoFallback = !voiceAgent && !sttAvailable;

  return (
    <div className="card" aria-labelledby="voice-heading">
      <div className="row spread">
        <h2 id="voice-heading">Talk to Echo</h2>
        <p className="transcript" style={{ margin: 0 }}>
          {voiceAgent
            ? "Voice: AssemblyAI Voice Agent"
            : `STT: ${sttAvailable ? "AssemblyAI" : "demo text"} · TTS: ${ttsAvailable ? "ElevenLabs" : "browser voice"}`}
        </p>
      </div>

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={`btn micBtn${recording ? " recording" : ""}`}
          onClick={onMicToggle}
          disabled={!canMic}
          aria-label={recording ? "Stop listening" : "Start listening"}
          title={
            !micUsable
              ? "Voice needs the AssemblyAI backend — use the text box below."
              : !mediaSupported
                ? "This browser can't capture audio — use the text box below."
                : recording
                  ? "Stop listening"
                  : "Start listening"
          }
        >
          {recording ? "Stop" : "Mic"}
        </button>

        <span aria-live="polite" className="transcript" data-testid="mic-status">
          {statusText(agentStatus, recording)}
        </span>
      </div>

      {demoFallback && (
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