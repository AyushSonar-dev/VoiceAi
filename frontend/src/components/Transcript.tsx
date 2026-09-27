"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { TranscriptMessage } from "@/lib/transcript";

interface Props {
  messages: TranscriptMessage[];
  reducedMotion: boolean;
  /** the most recent completed agent message, announced politely on arrival */
  announcement: string;
}

/**
 * The conversation, as real semantic text in the DOM — selectable, searchable
 * and readable by assistive technology. Only the last completed agent message
 * is announced; streaming deltas and the orb's motion are never announced, so a
 * screen reader isn't flooded by animation.
 */
export function Transcript({ messages, reducedMotion, announcement }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Follow the conversation, but only when the user is already at the bottom
    // so scrolling back to re-read isn't yanked away.
    const el = endRef.current;
    if (!el) return;
    const nearest = el.closest(".transcript");
    if (!nearest) return;
    const distance = nearest.scrollHeight - nearest.scrollTop - nearest.clientHeight;
    if (distance < 160) nearest.scrollTop = nearest.scrollHeight;
  }, [messages]);

  return (
    <section className="panel panel--flush" aria-labelledby="transcript-heading">
      <h2 id="transcript-heading" className="sr-only">
        Conversation transcript
      </h2>

      {/* One polite announcement for the newest finished reply. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <div className="transcript" tabIndex={0} role="log" aria-label="Conversation">
        {messages.length === 0 ? (
          <p className="transcript__empty">
            Nothing said yet. Try “find me a white dress under 2000”.
          </p>
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.article
                key={m.id}
                className={`turn turn--${m.speaker}`}
                initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: reducedMotion ? 0 : 0.28, ease: [0.22, 0.61, 0.36, 1] }}
              >
                <span className="turn__who">{m.speaker === "user" ? "You" : "Echo"}</span>
                <p className="turn__text" data-partial={m.partial ? "true" : "false"}>
                  {m.text}
                </p>
                {m.interrupted ? <p className="turn__flag">(interrupted)</p> : null}
              </motion.article>
            ))}
          </AnimatePresence>
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
