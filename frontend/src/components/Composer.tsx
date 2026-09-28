"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface Props {
  connected: boolean;
  recording: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onSend: (text: string) => void;
  reducedMotion: boolean;
}

/**
 * The single input row: microphone, text field, send.
 *
 * One control surface, sitting directly under the core, rather than a panel of
 * its own. Typing and speaking are the same gesture in this product, so they
 * share one line.
 */
export function Composer({ connected, recording, busy, onStart, onStop, onSend, reducedMotion }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    onSend(value);
    setText("");
  };

  const micLabel = !connected
    ? "Connect to the microphone"
    : recording
      ? "Stop listening"
      : "Start the microphone";

  return (
    <motion.form
      className="composer"
      onSubmit={submit}
      initial={false}
      aria-label="Talk to Echo"
    >
      <button
        type="button"
        className="mic"
        data-active={recording || undefined}
        onClick={connected ? (recording ? onStop : onStart) : onStart}
        disabled={busy}
        aria-pressed={connected && recording}
        aria-label={micLabel}
        title={micLabel}
      >
        <MicGlyph active={connected && recording} />
      </button>

      <div className="composer__field">
        <label className="sr-only" htmlFor={fieldId}>
          Type a message for Echo
        </label>
        <input
          id={fieldId}
          ref={inputRef}
          className="composer__input"
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={connected ? "Ask for anything…" : "Connect to start typing…"}
          disabled={!connected}
          autoComplete="off"
          enterKeyHint="send"
        />
        <button
          type="submit"
          className="composer__send"
          disabled={!connected || busy || !text.trim()}
          aria-label="Send message"
        >
          <SendGlyph />
        </button>
      </div>

      <motion.p
        className="composer__hint"
        aria-hidden="true"
        initial={false}
        animate={{ opacity: connected ? 1 : 0.4 }}
        transition={{ duration: still ? 0 : 0.2 }}
      >
        {connected
          ? recording
            ? "Mic is open — speak naturally."
            : "Mic is off — type, or press the mic."
          : "Press connect to begin."}
      </motion.p>
    </motion.form>
  );
}

function MicGlyph({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="glyph">
      <path
        d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3Z"
        fill="currentColor"
      />
      <path
        d="M5.5 11a.75.75 0 0 1 1.5 0 5 5 0 0 0 10 0 .75.75 0 0 1 1.5 0 6.5 6.5 0 0 1-5.75 6.44V20h2.25a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5H12v-2.56A6.5 6.5 0 0 1 6.25 11"
        fill="currentColor"
        opacity={active ? 0.9 : 0.55}
      />
    </svg>
  );
}

function SendGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="glyph">
      <path
        d="M4.4 11.3 19.1 5c.7-.3 1.4.4 1.1 1.1l-6.3 14.7c-.3.7-1.3.7-1.6 0l-2.3-5.2-5.2-2.3c-.7-.3-.7-1.3 0-1.6Z"
        fill="currentColor"
      />
    </svg>
  );
}
