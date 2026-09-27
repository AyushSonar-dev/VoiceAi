"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "./voiceAgent";

/**
 * The interface has several independent signals of what the agent is doing
 * (socket status, mic state, tool round-trips, whether audio is playing). This
 * module reduces them to ONE phase, so the orb, the status label and the screen
 * reader announcement can never disagree with each other.
 */
export type AgentPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

export interface PhaseInput {
  /** false until the user has pressed Connect. */
  connected: boolean;
  agentStatus: AgentStatus | null;
  /** microphone is capturing */
  recording: boolean;
  /** a turn is in flight (tool calls, checkout, etc.) */
  busy: boolean;
  /** the agent's voice is actually being produced */
  speaking: boolean;
  /** filler phrase is playing, e.g. "let me check that" */
  filler: boolean;
}

export interface PhaseView {
  phase: AgentPhase;
  /** short, human, screen-reader friendly — "I'm listening." */
  label: string;
  /** what the agent is doing, for the visible status line */
  detail: string;
  /** calmer/quieter presentation when the app is merely waiting */
  isBusy: boolean;
}

const COPY: Record<AgentPhase, { label: string; detail: string }> = {
  idle: { label: "Ready when you are.", detail: "Start the conversation whenever you like." },
  connecting: { label: "Connecting.", detail: "Setting up a private voice connection." },
  listening: { label: "I'm listening.", detail: "Speak, or type your request." },
  thinking: { label: "I'm thinking.", detail: "Checking the catalog and your cart." },
  speaking: { label: "I'm speaking.", detail: "Here's what I found." },
  error: { label: "Something went wrong.", detail: "I lost the connection. Reconnect to continue." },
  ended: { label: "Call ended.", detail: "Press connect again whenever you're ready." },
};

export function resolvePhase(input: PhaseInput): AgentPhase {
  if (input.agentStatus === "error") return "error";
  if (!input.connected) return "idle";
  if (input.agentStatus === "connecting") return "connecting";
  // Speaking wins over thinking: while the voice is coming out of the speaker
  // the honest thing to show (and announce) is that the agent is speaking.
  if (input.speaking) return "speaking";
  if (input.busy || input.filler || input.agentStatus === "thinking") return "thinking";
  if (input.recording || input.agentStatus === "listening") return "listening";
  if (input.agentStatus === "ended") return "ended";
  return "listening";
}

export function usePhaseView(input: PhaseInput): PhaseView {
  const phase = resolvePhase(input);
  const copy = COPY[phase];
  // While the agent is looking something up, name the tool round-trip so the
  // wait is explained rather than blank.
  const detail = input.filler ? "One moment — checking the catalog." : copy.detail;
  return { phase, label: copy.label, detail, isBusy: phase === "thinking" || phase === "connecting" };
}

/**
 * Smoothing for the measured audio level. Real RMS jumps around between frames;
 * this gives the visuals a fast attack and a gentle release so they track speech
 * without flickering.
 */
export function useSmoothedLevel(target: number, reducedMotion: boolean): number {
  const [value, setValue] = useState(0);
  const targetRef = useRef(target);
  const rafRef = useRef(0);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (reducedMotion) {
      // Reduced motion still gets an honest size cue, just a static one.
      setValue(0);
      return;
    }
    let current = 0;
    const tick = () => {
      const goal = targetRef.current;
      current += (goal - current) * (goal > current ? 0.45 : 0.12);
      if (current < 0.002 && goal === 0) current = 0;
      setValue(current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [reducedMotion]);

  return value;
}
