"use client";

import { useEffect, useRef } from "react";
import { CORE_PROFILES, type AgentPhase, type AudioMeter } from "@/lib/agentState";
import { coreBufferSize, coreRingAlpha, levelForPhase, renderCoreFrame } from "@/lib/coreRender";

interface Props {
  phase: AgentPhase;
  /**
   * Live audio, shared by reference. The core picks the direction that matches
   * its own phase — the microphone while listening, the agent's playback while
   * speaking — and ignores the other, so the two can never fight over the same
   * circle. Read inside the draw loop rather than passed per render, because it
   * changes every frame.
   */
  audio: AudioMeter;
  reducedMotion: boolean;
  /** rendered CSS pixel diameter */
  size: number;
  className?: string;
}

/**
 * The Agent Core.
 *
 * A shaded disc driven by the real conversation: the socket status, whether the
 * user is speaking, whether the agent's audio is playing, and the measured RMS
 * of the microphone or the speaker.
 *
 * This component owns only the frame loop, the canvas sizing and the ring. The
 * shading and the silhouette are in coreRender, so the geometry that matters —
 * a perfect, unclipped circle — can be verified without a browser.
 */
export function AgentCore({ phase, audio, reducedMotion, size, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Held in refs so the loop never has to be torn down and rebuilt on every
  // event; a new phase or a new level is just a value the next frame reads.
  const phaseRef = useRef(phase);
  const audioRef = useRef(audio);
  // Keep the box identity stable even if the caller ever passes a new one.
  audioRef.current = audio;
  const reducedRef = useRef(reducedMotion);
  const repaintRef = useRef<(() => void) | null>(null);

  phaseRef.current = phase;
  reducedRef.current = reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Even CSS box, so the centre sits on an exact pixel boundary; an odd box is
    // the usual reason a canvas circle looks slightly oval.
    const cssSize = Math.max(8, Math.round(size / 2) * 2);
    // The shading buffer is deliberately smaller than the device resolution; the
    // browser upscales it. Both sizes come from one function so they cannot
    // drift apart and leave the ring drawn at the wrong scale.
    const backing = coreBufferSize(cssSize, dpr);
    if (canvas.width !== backing || canvas.height !== backing) {
      canvas.width = backing;
      canvas.height = backing;
    }

    const image = ctx.createImageData(backing, backing);
    let raf = 0;
    let running = true;
    let breath = 0;
    let smoothed = 0;
    let lastFrame = performance.now();
    const started = lastFrame;

    const paint = (now: number) => {
      const t = (now - started) / 1000;
      // Real frame delta, clamped so a backgrounded tab cannot jump the breath.
      const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
      lastFrame = now;

      const currentPhase = phaseRef.current;
      // The measured level is read live, straight from the shared box, so the
      // core follows the audio without a single re-render.
      const raw = levelForPhase(audioRef.current, currentPhase, reducedRef.current);
      const goal = raw ?? 0;
      // Fast attack so quiet syllables still register; slow release so the core
      // settles instead of flickering between words.
      smoothed += (goal - smoothed) * (goal > smoothed ? 0.5 : 0.12);
      if (smoothed < 0.0015 && goal === 0) smoothed = 0;

      const frame = renderCoreFrame({
        cssSize,
        dpr,
        phase: currentPhase,
        t,
        level: smoothed,
        energy: 1,
        breath,
      });

      // Frame rate independence: `breath` is measured in cycles, so the rate
      // means the same thing on a 60Hz and a 120Hz display.
      breath = (breath + CORE_PROFILES[currentPhase].breath * dt) % 1;

      image.data.set(frame.data);
      ctx.putImageData(image, 0, 0);

      const ring = coreRingAlpha(currentPhase, smoothed);
      if (ring > 0) {
        const half = backing / 2;
        const ringR = frame.radius + Math.max(3, half * 0.035) + smoothed * half * 0.012;
        ctx.beginPath();
        ctx.arc(half, half, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(240, 238, 232, ${ring})`;
        ctx.lineWidth = Math.max(1, half * 0.006);
        ctx.stroke();
      }

      if (running) raf = requestAnimationFrame(paint);
    };

    repaintRef.current = () => {
      // One frame, no loop: used for reduced motion and for repainting after a
      // state change so the core still visibly changes without animating.
      paint(performance.now());
      running = false;
      cancelAnimationFrame(raf);
    };

    if (reducedMotion) {
      repaintRef.current();
    } else {
      running = true;
      raf = requestAnimationFrame(paint);
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reducedRef.current) {
        running = true;
        lastFrame = performance.now();
        raf = requestAnimationFrame(paint);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      repaintRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [size, reducedMotion]);

  // With reduced motion there is no loop, so each state change repaints the
  // single static frame. The state stays legible because the profile changes
  // size, texture, brightness and the ring — only motion is removed.
  // Audio is not a dependency: reduced motion ignores the level entirely, so a
  // repaint can never be caused by the meter.
  useEffect(() => {
    if (reducedMotion) repaintRef.current?.();
  }, [reducedMotion, phase, size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        // A square CSS box is the outer guarantee, before the first frame.
        width: `${cssSizeOf(size)}px`,
        height: `${cssSizeOf(size)}px`,
      }}
      /* Purely decorative: the same state is always present as text and in the
         live region, so the animation is never the only signal. */
      aria-hidden="true"
      role="presentation"
    />
  );
}

function cssSizeOf(size: number) {
  return Math.max(8, Math.round(size / 2) * 2);
}
