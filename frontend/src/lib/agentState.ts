"use client";

import { useRef } from "react";
import type { AgentStatus } from "./voiceAgent";

/**
 * The visual system for the Agent Core.
 *
 * Everything here is derived from the real Voice Agent events — the socket
 * status, whether the user is actually speaking, whether the agent's audio is
 * playing, and the measured RMS of the microphone and of the agent's own
 * playback. No state is invented and no level is faked: when there is no audio
 * at all the level is `null` and the core is driven by time alone.
 */
export type AgentPhase =
  | "disconnected"
  | "connecting"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

export interface PhaseInput {
  /** the user has entered the voice experience */
  connected: boolean;
  agentStatus: AgentStatus | null;
  /** the microphone is capturing */
  recording: boolean;
  /** a turn is in flight (tool calls, checkout, etc.) */
  busy: boolean;
  /** the agent's voice is actually being produced */
  speaking: boolean;
  /** filler phrase is playing, e.g. "let me check that" */
  filler: boolean;
  /**
   * The server's voice-activity detection says the user is speaking right now.
   * This is the signal that separates IDLE ("ready, waiting for you") from
   * LISTENING ("you are talking and I am taking it in") — the agent's own
   * status reports `listening` in both cases, so status alone cannot tell them
   * apart and would make the two states look identical.
   */
  userSpeaking: boolean;
}

export interface PhaseView {
  phase: AgentPhase;
  /** the visible state line, short enough to sit under the core */
  label: string;
  /** one line of context under the state */
  detail: string;
  /** exactly what a screen reader should hear; no colour or motion implied */
  spoken: string;
}

const COPY: Record<AgentPhase, { label: string; detail: string; spoken: string }> = {
  disconnected: {
    label: "Not connected",
    detail: "Press connect to bring Echo online.",
    spoken: "Echo is not connected.",
  },
  connecting: {
    label: "Connecting",
    detail: "Opening a private voice connection.",
    spoken: "Echo is connecting.",
  },
  idle: {
    label: "Ready",
    detail: "Say anything, or type it below.",
    spoken: "Echo is ready and listening for you.",
  },
  listening: {
    label: "Listening",
    detail: "Go ahead — I'm taking it in.",
    spoken: "Echo is listening.",
  },
  thinking: {
    label: "Thinking",
    detail: "Checking the catalog and your cart.",
    spoken: "Echo is thinking.",
  },
  speaking: {
    label: "Speaking",
    detail: "Here's what I found.",
    spoken: "Echo is speaking.",
  },
  error: {
    label: "Connection lost",
    detail: "Try connecting again.",
    spoken: "The voice connection was lost.",
  },
  ended: {
    label: "Call ended",
    detail: "Connect again whenever you're ready.",
    spoken: "The call has ended.",
  },
};

/**
 * Speaking beats thinking: while the voice is coming out of the speaker, the
 * honest thing to show and announce is that the agent is speaking.
 */
export function resolvePhase(input: PhaseInput): AgentPhase {
  if (input.agentStatus === "error") return "error";
  if (!input.connected) return "disconnected";
  if (input.agentStatus === "connecting") return "connecting";
  if (input.speaking) return "speaking";
  if (input.busy || input.filler || input.agentStatus === "thinking") return "thinking";
  if (input.agentStatus === "ended") return "ended";
  if (input.recording && input.userSpeaking) return "listening";
  // Connected, the microphone is open, but nobody is talking: this is the calm
  // resting state, not the "I am hearing you" state.
  if (input.recording || input.agentStatus === "listening") return "idle";
  return "idle";
}

export function usePhaseView(input: PhaseInput): PhaseView {
  const phase = resolvePhase(input);
  const copy = COPY[phase];
  const detail = input.filler && phase === "thinking" ? "One moment…" : copy.detail;
  return { phase, label: copy.label, detail, spoken: copy.spoken };
}

/* ------------------------------------------------------------------ core look */

export interface CoreProfile {
  /** base radius as a fraction of the half-size, so the silhouette is exact */
  radius: number;
  /** grain amplitude: how far the surface texture deviates from smooth */
  grain: number;
  /** grain frequency: higher is finer */
  grainScale: number;
  /** speed of the displacement field */
  flow: number;
  /** how far the field is pulled toward the centre (thinking draws it inward) */
  inward: number;
  /** key-light strength */
  light: number;
  /** overall exposure, i.e. how present the core feels */
  energy: number;
  /** rotation of the sampling frame, in radians per second */
  spin: number;
  /** breath rate in cycles per second; 0 disables it */
  breath: number;
  /** breath depth as a fraction of the radius */
  breathDepth: number;
  /** a thin ring outside the silhouette, used to mark the two "active" states */
  ring: number;
}

/**
 * Each state is visually distinct in at least three independent ways — size,
 * texture and motion — so the core cannot look the same in two states even
 * without colour, and so it reads at a glance from across the room.
 *
 * The radii form a deliberate ladder, smallest to largest:
 *   ended < disconnected < error < thinking < connecting < idle < speaking < listening
 * Two states may never share a radius, because size is the one cue that survives
 * a greyscale render, a still screenshot and a screen reader's silence — the
 * radius is the fallback when nothing else is available.
 */
export const CORE_PROFILES: Record<AgentPhase, CoreProfile> = {
  // Faded right back: the call is over.
  ended: {
    radius: 0.60, grain: 0.04, grainScale: 2.2, flow: 0.015, inward: 0,
    light: 0.30, energy: 0.40, spin: 0, breath: 0.04, breathDepth: 0.006, ring: 0,
  },
  // Small and almost still: the core is present but resting.
  disconnected: {
    radius: 0.64, grain: 0.05, grainScale: 2.4, flow: 0.02, inward: 0,
    light: 0.34, energy: 0.5, spin: 0, breath: 0.05, breathDepth: 0.008, ring: 0,
  },
  // Low and flat: something went wrong, so nothing swells.
  error: {
    radius: 0.68, grain: 0.16, grainScale: 5.0, flow: 0.05, inward: 0,
    light: 0.28, energy: 0.42, spin: 0, breath: 0.04, breathDepth: 0.006, ring: 0,
  },
  // Contracted and drawn inward: the texture flows toward the middle.
  thinking: {
    radius: 0.72, grain: 0.22, grainScale: 6.0, flow: 0.85, inward: 0.55,
    light: 0.46, energy: 0.62, spin: 0.30, breath: 0.5, breathDepth: 0.012, ring: 0,
  },
  // Swelling into place while the socket opens.
  connecting: {
    radius: 0.78, grain: 0.13, grainScale: 3.0, flow: 0.55, inward: 0.15,
    light: 0.48, energy: 0.68, spin: 0.22, breath: 0.22, breathDepth: 0.022, ring: 0.1,
  },
  // Calm. Low energy, very slow breath, minimal grain drift.
  idle: {
    radius: 0.82, grain: 0.09, grainScale: 2.8, flow: 0.10, inward: 0,
    light: 0.56, energy: 0.74, spin: 0.015, breath: 0.085, breathDepth: 0.016, ring: 0,
  },
  // Bright and wide, driven hard by the real playback amplitude.
  speaking: {
    radius: 0.86, grain: 0.26, grainScale: 3.8, flow: 0.52, inward: 0,
    light: 0.92, energy: 1.0, spin: 0.04, breath: 0.30, breathDepth: 0.04, ring: 0.42,
  },
  // The largest: expanding and coarser, because it is taking you in.
  listening: {
    radius: 0.90, grain: 0.30, grainScale: 4.4, flow: 0.46, inward: 0,
    light: 0.80, energy: 1.0, spin: 0.05, breath: 0.34, breathDepth: 0.05, ring: 0.55,
  },
};

/**
 * Measured audio, shared by reference rather than by state.
 *
 * The microphone and the agent's playback both report their level on every
 * animation frame, so keeping the level in React state would re-render the whole
 * interface — products, cart, transcript — sixty times a second, purely to move
 * one circle. Instead the audio callbacks write into this stable box and the
 * core's own draw loop reads it, so the animation costs no renders at all.
 */
export interface AudioMeter {
  /** RMS 0..1 of whichever source was last active. */
  value: number;
  /** Which direction produced it, or `null` for silence. */
  source: "in" | "out" | null;
}

/** A stable meter box, safe to write to from an audio callback. */
export function useAudioMeter(): AudioMeter {
  return useRef<AudioMeter>({ value: 0, source: null }).current;
}
