import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyWrite, type Speaker, type TranscriptMessage } from "../src/lib/transcript.js";

/**
 * The conversation list.
 *
 * The reported bug was Echo's reply appearing twice. These tests replay the
 * real event order the voice agent emits — cumulative deltas for the user,
 * incremental deltas for the agent, a final transcript, then `reply.done` — and
 * assert that each actual message exists exactly once in state. Nothing here
 * hides a duplicate at the view layer; the state itself is correct.
 */

/** A minimal harness that drives applyWrite the way the hook does. */
function harness() {
  let messages: TranscriptMessage[] = [];
  const open: Record<Speaker, string | null> = { user: null, agent: null };
  const buffers: Record<Speaker, string> = { user: "", agent: "" };
  let n = 0;
  const makeId = () => `m${++n}`;

  function write(speaker: Speaker, text: string, partial: boolean, interrupted?: boolean) {
    const result = applyWrite(messages, speaker, text, partial, interrupted, open[speaker], makeId);
    messages = result.messages;
    open[speaker] = result.openId;
  }

  return {
    get messages() {
      return messages;
    },
    /** cumulative delta: each value supersedes the last */
    setPartial: (speaker: Speaker, text: string) => write(speaker, text, true),
    /** incremental delta: appends to the buffer */
    append: (speaker: Speaker, chunk: string) => {
      buffers[speaker] = buffers[speaker] ? `${buffers[speaker]} ${chunk}` : chunk;
      write(speaker, buffers[speaker], true);
    },
    commit: (speaker: Speaker, text: string) => {
      buffers[speaker] = "";
      write(speaker, text, false);
    },
    /** reply.done */
    closeAgentReply: (interrupted: boolean) => {
      buffers.agent = "";
      open.agent = null;
      messages = messages.map((m) =>
        m.speaker === "agent" && m.partial ? { ...m, partial: false, interrupted } : m
      );
    },
    /** input.speech.started */
    sealUser: () => {
      buffers.user = "";
      open.user = null;
      messages = messages.map((m) =>
        m.speaker === "user" && m.partial ? { ...m, partial: false } : m
      );
    },
  };
}

describe("transcript streaming", () => {
  test("renders a cumulative user turn as growing text in one message", () => {
    const t = harness();
    // The user stream is cumulative: "H", "He", "Hel", "Hello".
    for (const partial of ["H", "He", "Hel", "Hello there"]) t.setPartial("user", partial);

    assert.equal(t.messages.length, 1, "the user turn split into several messages");
    assert.equal(t.messages[0].text, "Hello there");
    assert.equal(t.messages[0].partial, true);
  });

  test("appends incremental agent deltas into one message", () => {
    const t = harness();
    // The agent stream is incremental: only the new words each time.
    for (const chunk of ["I found", " six", " dresses", " you might like."]) {
      t.append("agent", chunk);
    }

    assert.equal(t.messages.length, 1, "the reply split into several messages");
    assert.equal(t.messages[0].text, "I found six dresses you might like.");
  });

  test("gives a streaming turn one stable id so it grows in place", () => {
    const t = harness();
    t.append("agent", "one");
    const firstId = t.messages[0].id;
    t.append("agent", "two");
    t.append("agent", "three");
    assert.equal(t.messages[0].id, firstId, "the id changed mid-stream");
  });

  test("a final message supersedes the streamed text rather than adding to it", () => {
    const t = harness();
    t.append("agent", "I found six dresses");
    t.commit("agent", "I found six dresses you might like.");

    assert.equal(t.messages.length, 1);
    assert.equal(t.messages[0].text, "I found six dresses you might like.");
    assert.equal(t.messages[0].partial, false);
  });
});

describe("transcript de-duplication", () => {
  test("folds a repeated final reply into one message", () => {
    const t = harness();
    t.commit("agent", "Added the linen shirt to your cart.");
    // The same final transcript arriving again must not become a second bubble.
    t.commit("agent", "Added the linen shirt to your cart.");

    assert.equal(t.messages.length, 1, "the same final message was stored twice");
    assert.equal(t.messages[0].text, "Added the linen shirt to your cart.");
  });

  test("a delta arriving after the final text does not open a second message", () => {
    const t = harness();
    t.commit("agent", "That is in your cart.");
    // A late delta must not resurrect the turn as a new bubble.
    t.append("agent", "Anything else?");
    t.commit("agent", "Anything else?");

    // The next reply is legitimately a new message.
    assert.equal(t.messages.length, 2);
    assert.equal(t.messages[0].text, "That is in your cart.");
    assert.equal(t.messages[1].text, "Anything else?");
  });

  test("keeps two genuinely different replies the agent made in a row", () => {
    const t = harness();
    t.commit("agent", "Yes.");
    t.commit("agent", "Absolutely.");
    assert.equal(t.messages.length, 2, "two real replies were collapsed into one");
  });

  test("survives a full two-turn conversation with the real event order", () => {
    const t = harness();

    // Turn 1: user speaks, agent replies.
    t.sealUser();
    t.setPartial("user", "find me a linen shirt");
    t.commit("user", "find me a linen shirt");
    for (const chunk of ["I found", " a linen shirt", " for you."]) t.append("agent", chunk);
    t.commit("agent", "I found a linen shirt for you.");
    t.closeAgentReply(false);

    // Turn 2: user asks to add it, agent confirms.
    t.sealUser();
    t.setPartial("user", "add it");
    t.commit("user", "add it");
    for (const chunk of ["Added", " it to your cart."]) t.append("agent", chunk);
    t.commit("agent", "Added it to your cart.");
    t.closeAgentReply(false);

    assert.equal(t.messages.length, 4, "expected exactly one message per real turn");
    assert.deepEqual(
      t.messages.map((m) => `${m.speaker}: ${m.text}`),
      [
        "user: find me a linen shirt",
        "agent: I found a linen shirt for you.",
        "user: add it",
        "agent: Added it to your cart.",
      ]
    );
    assert.ok(t.messages.every((m) => m.partial === false), "a message was left streaming");
  });

  test("marks a reply the user cut short, without duplicating it", () => {
    const t = harness();
    t.append("agent", "I was going to list all six but");
    t.closeAgentReply(true);

    assert.equal(t.messages.length, 1);
    assert.equal(t.messages[0].partial, false);
    assert.equal(t.messages[0].interrupted, true);
  });

  test("ignores empty and whitespace-only updates", () => {
    const t = harness();
    t.commit("agent", "Hello.");
    t.setPartial("agent", "");
    t.setPartial("agent", "   ");
    assert.equal(t.messages.length, 1);
  });

  test("every message ends up with a unique id", () => {
    const t = harness();
    t.commit("user", "one");
    t.commit("agent", "two");
    t.commit("user", "three");
    t.commit("agent", "four");
    const ids = t.messages.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate ids would make React reuse a node");
  });
});
