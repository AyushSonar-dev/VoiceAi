"use client";

import { useEffect, useState, type FormEvent } from "react";

interface Props {
  sttAvailable: boolean;
  ttsAvailable: boolean;
  /** true when the real AssemblyAI Voice Agent backend is configured */
  voiceAgent: boolean;
  busy: boolean;
  recording: boolean;
  onMicToggle: () => void;
  onSubmitText: (text: string) => void;
  lastUserText: string;
}

/**
 * The controls that start and steer a turn. The behaviour here is unchanged from
 * the original panel — press to talk, or type — only the presentation is
 * different.
 */
export function VoicePanel({
  sttAvailable,
  ttsAvailable,
  voiceAgent,
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

  const micUsable = (voiceAgent || sttAvailable) && mediaSupported;
  const canMic = micUsable && !busy;
  const demoFallback = !voiceAgent && !sttAvailable;

  // Order matters: the browser's own limits are checked before the backend's,
  // otherwise a device with no microphone is blamed on missing API keys.
  const micLabel = recording ? "Stop listening" : "Start listening";
  const micTitle = !mediaSupported
    ? "This browser can't capture audio — type your request instead."
    : !voiceAgent && !sttAvailable
      ? "Voice needs the AssemblyAI keys — type your request instead."
      : recording
        ? "Stop listening. Echo stops hearing you."
        : "Start listening. Echo starts hearing you.";

  return (
    <section className="panel voice" aria-labelledby="voice-heading">
      <h2 id="voice-heading" className="sr-only">
        Talk to Echo
      </h2>

      <div className="voice__row">
        <button
          type="button"
          className="mic"
          data-active={recording}
          onClick={onMicToggle}
          disabled={!canMic}
          aria-pressed={recording}
          aria-label={micTitle}
          title={micTitle}
        >
          <span className="mic__ring" aria-hidden="true" />
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
            <path
              d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="voice__status">
          {/* The agent state has a single authoritative readout of its own, next
              to the orb, and that is the one screen readers hear. This line only
              names which services are in use, so the two never talk over each
              other. */}
          <p className="voice__status-main">
            {recording ? "Recording" : "Press to talk, or type below"}
          </p>
          <p className="voice__status-sub">
            {voiceAgent
              ? "Live voice agent"
              : `Speech-to-text ${sttAvailable ? "ready" : "off"} · speech ${
                  ttsAvailable ? "ready" : "browser"
                }`}
          </p>
        </div>
      </div>

      {demoFallback ? (
        <p className="notice">
          Demo mode: voice keys aren&apos;t configured, so type what you would say out loud. The
          microphone button stays disabled rather than pretending to work.
        </p>
      ) : null}

      {/* A chat composer, not a site search: `role="form"` names the landmark
          correctly instead of announcing a search region. */}
      <form className="voice__form" onSubmit={submit} role="form" aria-label="Ask Echo to shop">
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
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>

      {lastUserText ? (
        <p className="voice__status-sub" style={{ margin: 0 }}>
          Last thing you said: “{lastUserText}”
        </p>
      ) : null}
    </section>
  );
}
