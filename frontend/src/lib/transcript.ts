"use client";

import { useCallback, useRef, useState } from "react";

export type Speaker = "user" | "agent";

export interface TranscriptMessage {
  id: string;
  speaker: Speaker;
  text: string;
  /** streaming in — rendered, but not yet announced */
  partial: boolean;
  /** the user barged in and cut this reply short */
  interrupted?: boolean;
}

let counter = 0;
const nextId = () => `m${++counter}`;

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The conversation history, built from the events the existing voice-agent
 * session already emits. Presentation state only — nothing here is sent to the
 * backend, which still owns every fact in the conversation.
 *
 * The two streaming events are NOT the same shape, which is the subtle part:
 * `transcript.user.delta` carries the CUMULATIVE text for the turn so far, so
 * each one supersedes the last, while `transcript.agent.delta` carries only the
 * newly spoken words and must be appended. Getting this backwards shows the user
 * "H He Hel Hello", so the two are separate methods rather than one guess.
 */
export function useTranscript() {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const open = useRef<{ user: string | null; agent: string | null }>({ user: null, agent: null });

  const idFor = (speaker: Speaker) => open.current[speaker];

  /** Write into the in-flight message, or start one. */
  const write = useCallback(
    (speaker: Speaker, text: string, partial: boolean, interrupted?: boolean) => {
      const clean = tidy(text);
      if (!clean) return;
      setMessages((prev) => {
        const openId = open.current[speaker];
        if (openId) {
          const index = prev.findIndex((m) => m.id === openId);
          if (index >= 0) {
            const next = [...prev];
            next[index] = { ...next[index], text: clean, partial, interrupted };
            return next;
          }
        }
        const message: TranscriptMessage = {
          id: nextId(),
          speaker,
          text: clean,
          partial,
          interrupted,
        };
        open.current[speaker] = message.id;
        return [...prev, message];
      });
    },
    []
  );

  /**
   * Cumulative partial: the provider resends the whole utterance each time, so
   * the newest value replaces whatever was shown. Used for the user.
   */
  const setPartial = useCallback(
    (speaker: Speaker, cumulativeText: string) => {
      write(speaker, cumulativeText, true);
    },
    [write]
  );

  /**
   * Incremental partial: the provider sends only the new words, so they are
   * appended to the buffer already on screen. Used for the agent. The buffer is
   * read from a ref, not from state, so a burst of deltas in one tick can't
   * read a stale value and lose words.
   */
  const buffers = useRef<{ user: string; agent: string }>({ user: "", agent: "" });
  const appendPartial = useCallback(
    (speaker: Speaker, chunk: string) => {
      const addition = tidy(chunk);
      if (!addition) return;
      const next = buffers.current[speaker]
        ? `${buffers.current[speaker]} ${addition}`
        : addition;
      buffers.current[speaker] = next;
      write(speaker, next, true);
    },
    [write]
  );

  /** The final, authoritative text for this turn. */
  const commit = useCallback(
    (speaker: Speaker, text: string) => {
      buffers.current[speaker] = "";
      write(speaker, text, false);
      open.current[speaker] = null;
    },
    [write]
  );

  /** Closes a streamed reply, flagging it if the user cut in. */
  const closeAgentReply = useCallback((interrupted: boolean) => {
    buffers.current.agent = "";
    setMessages((prev) =>
      prev.map((m) =>
        m.speaker === "agent" && m.partial ? { ...m, partial: false, interrupted } : m
      )
    );
    open.current.agent = null;
  }, []);

  /** A fresh turn begins: any previous open bubble is now final. */
  const sealOpen = useCallback((speaker: Speaker) => {
    buffers.current[speaker] = "";
    setMessages((prev) =>
      prev.map((m) => (m.speaker === speaker && m.partial ? { ...m, partial: false } : m))
    );
    open.current[speaker] = null;
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    open.current = { user: null, agent: null };
    buffers.current = { user: "", agent: "" };
  }, []);

  return { messages, setPartial, appendPartial, commit, closeAgentReply, sealOpen, clear };
}

export type TranscriptController = ReturnType<typeof useTranscript>;
