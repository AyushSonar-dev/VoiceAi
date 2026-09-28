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
 * The one rule that decides how a piece of text lands in the conversation.
 *
 * Kept pure and separate from the hook so it can be tested directly, because
 * getting this wrong is what makes a reply appear twice.
 *
 * Three things have to hold:
 *
 * 1. The two streaming events are not the same shape. `transcript.user.delta`
 *    carries the CUMULATIVE text for the turn so far, so each one supersedes the
 *    last; `transcript.agent.delta` carries only the newly spoken words and must
 *    be appended. The caller chooses which to call, because guessing here
 *    renders the user as "H He Hel Hello".
 *
 * 2. A turn that is still streaming keeps a stable id, so React reuses the same
 *    DOM node and the text visibly grows in place rather than piling up.
 *
 * 3. A final message identical to the message right before it is the same turn
 *    arriving twice, so it folds into the existing entry. That is what makes each
 *    real message exist exactly once in state, and therefore get announced
 *    exactly once — the fix is in the state, not hidden in the view.
 */
export function applyWrite(
  prev: TranscriptMessage[],
  speaker: Speaker,
  text: string,
  partial: boolean,
  interrupted: boolean | undefined,
  openId: string | null,
  makeId: () => string
): { messages: TranscriptMessage[]; openId: string | null } {
  const clean = tidy(text);
  if (!clean) return { messages: prev, openId };

  // Continue the turn that is already on screen.
  if (openId) {
    const index = prev.findIndex((m) => m.id === openId);
    if (index >= 0) {
      const next = [...prev];
      next[index] = { ...next[index], text: clean, partial, interrupted };
      // A final message is sealed, so a delta arriving afterwards starts a new
      // turn instead of overwriting what was already said.
      return { messages: next, openId: partial ? openId : null };
    }
  }

  // The same final message twice in a row is one message, not two.
  const tail = prev[prev.length - 1];
  if (!partial && tail && tail.speaker === speaker && !tail.partial && tail.text === clean) {
    const next = [...prev];
    next[prev.length - 1] = { ...tail, interrupted };
    return { messages: next, openId: null };
  }

  const id = makeId();
  return {
    messages: [...prev, { id, speaker, text: clean, partial, interrupted }],
    openId: partial ? id : null,
  };
}

/**
 * The conversation history, built from the events the existing voice-agent
 * session already emits. Presentation state only — the backend still owns every
 * fact in the conversation.
 *
 * The message list is mirrored in a ref so every event is applied synchronously
 * against the current list. A burst of deltas inside one React tick therefore
 * cannot read a stale value and drop words, and no id is ever allocated inside a
 * state updater, which React may invoke more than once.
 */
export function useTranscript() {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const messagesRef = useRef<TranscriptMessage[]>([]);
  const open = useRef<{ user: string | null; agent: string | null }>({
    user: null,
    agent: null,
  });
  const buffers = useRef<{ user: string; agent: string }>({ user: "", agent: "" });

  const run = useCallback(
    (
      speaker: Speaker,
      text: string,
      partial: boolean,
      interrupted?: boolean
    ): void => {
      const result = applyWrite(
        messagesRef.current,
        speaker,
        text,
        partial,
        interrupted,
        open.current[speaker],
        nextId
      );
      messagesRef.current = result.messages;
      open.current[speaker] = result.openId;
      setMessages(result.messages);
    },
    []
  );

  /** Cumulative partial: the newest value replaces whatever was on screen. */
  const setPartial = useCallback(
    (speaker: Speaker, cumulativeText: string) => run(speaker, cumulativeText, true),
    [run]
  );

  /** Incremental partial: append the new words to what is already on screen. */
  const appendPartial = useCallback(
    (speaker: Speaker, chunk: string) => {
      const addition = tidy(chunk);
      if (!addition) return;
      const next = buffers.current[speaker]
        ? `${buffers.current[speaker]} ${addition}`
        : addition;
      buffers.current[speaker] = next;
      run(speaker, next, true);
    },
    [run]
  );

  /** The final, authoritative text for this turn. */
  const commit = useCallback(
    (speaker: Speaker, text: string) => {
      buffers.current[speaker] = "";
      run(speaker, text, false);
    },
    [run]
  );

  /** Closes a streamed reply, flagging it if the user cut in. */
  const closeAgentReply = useCallback((interrupted: boolean) => {
    buffers.current.agent = "";
    open.current.agent = null;
    const next = messagesRef.current.map((m) =>
      m.speaker === "agent" && m.partial ? { ...m, partial: false, interrupted } : m
    );
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /** A fresh turn begins, so anything still streaming is now final. */
  const sealOpen = useCallback((speaker: Speaker) => {
    buffers.current[speaker] = "";
    open.current[speaker] = null;
    const next = messagesRef.current.map((m) =>
      m.speaker === speaker && m.partial ? { ...m, partial: false } : m
    );
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const clear = useCallback(() => {
    messagesRef.current = [];
    open.current = { user: null, agent: null };
    buffers.current = { user: "", agent: "" };
    setMessages([]);
  }, []);

  return { messages, setPartial, appendPartial, commit, closeAgentReply, sealOpen, clear };
}

export type TranscriptController = ReturnType<typeof useTranscript>;
