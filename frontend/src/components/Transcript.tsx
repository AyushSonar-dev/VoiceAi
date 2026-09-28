"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { TranscriptMessage } from "@/lib/transcript";

interface Props {
  messages: TranscriptMessage[];
  reducedMotion: boolean;
  onClear: () => void;
}

/**
 * The conversation, rendered as typography rather than a card.
 *
 * The list is a `role="log"`, so assistive technology can navigate the history,
 * but it is deliberately NOT itself a live region. Announcing a container whose
 * text grows on every delta would read the reply out dozens of times, and a
 * reply that is also spoken by the agent would be delivered twice over.
 *
 * Instead, one dedicated live region below the list holds the text of the most
 * recent *completed* message and nothing else. Streaming text never enters it,
 * so each real message is announced exactly once — when it finishes.
 */
export function Transcript({ messages, reducedMotion, onClear }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;

  const latestFinal = findLatestFinal(messages);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "end" });
  }, [messages, still]);

  if (messages.length === 0) return null;

  return (
    <section className="conversation" aria-labelledby="conversation-heading">
      <div className="conversation__bar">
        <h2 id="conversation-heading" className="conversation__heading">
          Conversation
        </h2>
        <button type="button" className="linkish" onClick={onClear}>
          Clear
        </button>
      </div>

      <ol className="conversation__list" role="log" aria-label="Conversation">
        {messages.map((message) => (
          <motion.li
            key={message.id}
            className="turn"
            data-speaker={message.speaker}
            data-partial={message.partial || undefined}
            initial={still ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: still ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="turn__who" aria-hidden="true">
              {message.speaker === "user" ? "You" : "Echo"}
            </span>
            <p className="turn__text">
              {message.text}
              {message.interrupted ? <span className="turn__cut"> — cut short</span> : null}
            </p>
          </motion.li>
        ))}
        <div ref={endRef} />
      </ol>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {latestFinal
          ? `${latestFinal.speaker === "user" ? "You said" : "Echo said"}: ${latestFinal.text}`
          : ""}
      </span>
    </section>
  );
}

/** The newest message that has stopped streaming, or `null` if none has. */
function findLatestFinal(messages: TranscriptMessage[]): TranscriptMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!messages[i].partial) return messages[i];
  }
  return null;
}
