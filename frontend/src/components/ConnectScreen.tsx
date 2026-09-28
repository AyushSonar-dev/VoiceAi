"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { AgentPhase } from "@/lib/agentState";

interface Props {
  phase: AgentPhase;
  ready: boolean;
  voiceAgent: boolean;
  micUnsupported: boolean;
  reducedMotion: boolean;
  onConnect: () => void;
}

/**
 * The pre-connection invitation.
 *
 * This is not a separate screen: the core is already on the page behind it, and
 * pressing connect only removes the invitation and brings the rest of the
 * interface in. The transition is therefore a change of surroundings around one
 * continuous object, rather than a swap between two layouts.
 */
export function ConnectScreen({
  phase,
  ready,
  voiceAgent,
  micUnsupported,
  reducedMotion,
  onConnect,
}: Props) {
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;
  const connecting = phase === "connecting";

  return (
    <motion.div
      className="invite"
      initial={still ? { opacity: 0 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={still ? { opacity: 0 } : { opacity: 0, y: -10, transition: { duration: 0.22 } }}
      transition={{ duration: still ? 0.15 : 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <p className="invite__lede">
        A shopping assistant you talk to. Ask for a shirt, add it to your cart, apply a
        coupon, check out — out loud.
      </p>

      <button
        type="button"
        className="invite__cta"
        onClick={onConnect}
        disabled={!ready || connecting || micUnsupported}
      >
        {connecting ? "Connecting…" : "Connect"}
      </button>

      <p className="invite__note">
        {!ready
          ? "Checking what's available…"
          : micUnsupported
            ? "This browser can't reach a microphone, so use the keyboard once you're connected."
            : voiceAgent
              ? "Opens a live voice connection. Your browser will ask for microphone access."
              : "No live voice agent is configured. You can still type your request."}
      </p>
    </motion.div>
  );
}
