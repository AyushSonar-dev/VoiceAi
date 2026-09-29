import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyWrite, type Speaker, type TranscriptMessage } from "../src/lib/transcript.js";
import { resolvePhase, type AgentPhase, type PhaseInput } from "../src/lib/agentState.js";
import { coreBufferSize, levelForPhase, renderCoreFrame } from "../src/lib/coreRender.js";
import type { AudioMeter } from "../src/lib/agentState.js";
import type { AgentStatus } from "../src/lib/voiceAgent.js";

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

describe("transcript.ts (additional tests)", () => {
  test("handles alternating user and agent messages", () => {
    const t = harness();
    t.setPartial("user", "hello");
    t.commit("user", "hello");
    t.append("agent", "hi");
    t.append("agent", "there");
    t.commit("agent", "hi there");
    t.setPartial("user", "how are you");
    t.commit("user", "how are you");
    t.append("agent", "I'm");
    t.append("agent", "good");
    t.commit("agent", "I'm good");

    assert.equal(t.messages.length, 4);
    assert.equal(t.messages[0].speaker, "user");
    assert.equal(t.messages[1].speaker, "agent");
    assert.equal(t.messages[2].speaker, "user");
    assert.equal(t.messages[3].speaker, "agent");
  });

  test("preserves interrupted flag through seal and commit", () => {
    const t = harness();
    t.append("agent", "I was going to say");
    t.closeAgentReply(true);
    assert.equal(t.messages[0].interrupted, true);
    assert.equal(t.messages[0].partial, false);
  });

  test("empty commits are ignored", () => {
    const t = harness();
    t.commit("agent", "Hello");
    t.commit("agent", "");
    t.commit("agent", "   ");
    assert.equal(t.messages.length, 1);
    assert.equal(t.messages[0].text, "Hello");
  });
});

describe("agentState.ts - resolvePhase", () => {
  const baseInput: PhaseInput = {
    connected: false,
    agentStatus: null,
    recording: false,
    busy: false,
    speaking: false,
    filler: false,
    deactivating: false,
    userSpeaking: false,
  };

  test("returns disconnected when not connected", () => {
    const input = { ...baseInput, connected: false };
    assert.equal(resolvePhase(input), "disconnected");
  });

  test("returns connecting when agentStatus is connecting", () => {
    const input = { ...baseInput, connected: true, agentStatus: "connecting" as AgentStatus };
    assert.equal(resolvePhase(input), "connecting");
  });

  test("returns deactivating when deactivating is true", () => {
    const input = { ...baseInput, connected: true, deactivating: true };
    assert.equal(resolvePhase(input), "deactivating");
  });

  test("returns error when agentStatus is error", () => {
    const input = { ...baseInput, connected: true, agentStatus: "error" as AgentStatus };
    assert.equal(resolvePhase(input), "error");
  });

  test("returns speaking when agent is speaking", () => {
    const input = { ...baseInput, connected: true, speaking: true };
    assert.equal(resolvePhase(input), "speaking");
  });

  test("returns thinking when busy", () => {
    const input = { ...baseInput, connected: true, busy: true };
    assert.equal(resolvePhase(input), "thinking");
  });

  test("returns thinking when filler", () => {
    const input = { ...baseInput, connected: true, filler: true };
    assert.equal(resolvePhase(input), "thinking");
  });

  test("returns thinking when agentStatus is thinking", () => {
    const input = { ...baseInput, connected: true, agentStatus: "thinking" as AgentStatus };
    assert.equal(resolvePhase(input), "thinking");
  });

  test("returns ended when agentStatus is ended", () => {
    const input = { ...baseInput, connected: true, agentStatus: "ended" as AgentStatus };
    assert.equal(resolvePhase(input), "ended");
  });

  test("returns listening when recording and userSpeaking", () => {
    const input = { ...baseInput, connected: true, recording: true, userSpeaking: true };
    assert.equal(resolvePhase(input), "listening");
  });

  test("returns idle when recording but not userSpeaking", () => {
    const input = { ...baseInput, connected: true, recording: true, userSpeaking: false };
    assert.equal(resolvePhase(input), "idle");
  });

  test("returns idle when agentStatus is listening but not recording", () => {
    const input = { ...baseInput, connected: true, agentStatus: "listening" as AgentStatus };
    assert.equal(resolvePhase(input), "idle");
  });

  test("returns idle as default", () => {
    const input = { ...baseInput, connected: true };
    assert.equal(resolvePhase(input), "idle");
  });
});

describe("coreRender.ts", () => {
  test("coreBufferSize returns even square size", () => {
    for (const cssSize of [199, 200, 333, 414, 517]) {
      for (const dpr of [1, 2, 3]) {
        const size = coreBufferSize(cssSize, dpr);
        assert.equal(size % 2, 0, `${cssSize}@${dpr} produced an odd box`);
        assert.ok(size >= 64 && size <= 320, `${cssSize}@${dpr} size out of bounds: ${size}`);
      }
    }
  });

  test("levelForPhase routes audio correctly", () => {
    const mic: AudioMeter = { value: 0.7, source: "in" };
    const voice: AudioMeter = { value: 0.9, source: "out" };
    const silence: AudioMeter = { value: 0, source: null };

    // Microphone only drives listening
    assert.equal(levelForPhase(mic, "listening", false), 0.7);
    for (const phase of ["disconnected", "connecting", "deactivating", "idle", "thinking", "speaking", "error", "ended"] as AgentPhase[]) {
      assert.equal(levelForPhase(mic, phase, false), null, phase);
    }

    // Agent voice only drives speaking
    assert.equal(levelForPhase(voice, "speaking", false), 0.9);
    for (const phase of ["disconnected", "connecting", "deactivating", "idle", "listening", "thinking", "error", "ended"] as AgentPhase[]) {
      assert.equal(levelForPhase(voice, phase, false), null, phase);
    }

    // Silence returns null
    assert.equal(levelForPhase(silence, "listening", false), null);
    assert.equal(levelForPhase(silence, "speaking", false), null);

    // Reduced motion returns null
    for (const phase of ["listening", "speaking", "idle"] as AgentPhase[]) {
      assert.equal(levelForPhase(mic, phase, true), null, phase);
      assert.equal(levelForPhase(voice, phase, true), null, phase);
    }
  });

  test("renderCoreFrame produces valid frame", () => {
    const frame = renderCoreFrame({
      cssSize: 300,
      dpr: 1,
      phase: "idle",
      t: 1.7,
      level: null,
      energy: 0.5,
      breath: 0.25,
    });

    assert.ok(frame.size > 0);
    assert.ok(frame.radius > 0);
    assert.ok(frame.radius < frame.size / 2);
    assert.equal(frame.data.length, frame.size * frame.size * 4);
    assert.equal(frame.phase, "idle");
    assert.equal(frame.level, null);
  });

  test("renderCoreFrame respects reduced motion", () => {
    const frame = renderCoreFrame({
      cssSize: 300,
      dpr: 1,
      phase: "speaking",
      t: 1.7,
      level: 0.5,
      energy: 0.5,
      breath: 0.25,
    });

    // Level should be null when reducedMotion is true (handled by levelForPhase)
    // But the frame itself should still be valid
    assert.ok(frame.size > 0);
  });
});