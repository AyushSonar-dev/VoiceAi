"use client";

import { useEffect, useRef } from "react";
import type { AgentPhase } from "@/lib/agentState";

interface Props {
  phase: AgentPhase;
  /**
   * Measured level 0..1 from the microphone, the agent's audio, or neither.
   * `null` means no audio is available at all (e.g. typed input, or the demo
   * path) — in that case the sphere must NOT pretend to react to sound.
   */
  level: number | null;
  reducedMotion: boolean;
  /** rendered pixel diameter */
  size: number;
  className?: string;
}

/**
 * A shaded sphere rendered per-pixel with animated film grain, displaced by a
 * slow flow field. Deliberately monochrome and quiet: it should read as
 * material, not as a sci-fi hologram.
 *
 * Rendered at a fraction of the display size and upscaled by the browser, which
 * is both faster and gives the grain its softness.
 */
export function AgentOrb({ phase, level, reducedMotion, size, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Kept in refs so the animation loop never needs to be torn down and rebuilt
  // on every state change.
  const phaseRef = useRef(phase);
  const levelRef = useRef(level);
  const reducedRef = useRef(reducedMotion);
  /** Draws exactly one frame — used for the reduced-motion static render. */
  const redrawRef = useRef<(() => void) | null>(null);

  phaseRef.current = phase;
  levelRef.current = level;
  reducedRef.current = reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Render small; CSS scales it up. The grain is a feature, not a defect.
    const renderSize = Math.max(48, Math.round(size / 3));
    canvas.width = Math.round(renderSize * dpr);
    canvas.height = Math.round(renderSize * dpr);
    const image = ctx.createImageData(canvas.width, canvas.height);
    const px = image.data;

    let raf = 0;
    let running = true;
    let smoothed = 0;
    const started = performance.now();

    // ---- deterministic value noise, so grain is stable frame to frame ----
    const hash = (x: number, y: number) => {
      const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };
    const smooth = (t: number) => t * t * (3 - 2 * t);
    const noise = (x: number, y: number) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = smooth(x - xi);
      const yf = smooth(y - yi);
      const a = hash(xi, yi);
      const b = hash(xi + 1, yi);
      const c = hash(xi, yi + 1);
      const d = hash(xi + 1, yi + 1);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };

    // Per-phase character. Everything is monochrome; only the motion differs.
    const PROFILE: Record<AgentPhase, {
      radius: number;      // relative disc size
      grain: number;       // grain amplitude
      grainScale: number;  // grain frequency
      flow: number;        // speed of the displacement field
      light: number;       // lighting strength
      shimmer: number;     // vertical banding (thinking only)
    }> = {
      idle:      { radius: 0.74, grain: 0.10, grainScale: 3.1, flow: 0.10, light: 0.55, shimmer: 0 },
      connecting:{ radius: 0.78, grain: 0.16, grainScale: 3.4, flow: 0.30, light: 0.62, shimmer: 0.15 },
      listening: { radius: 0.86, grain: 0.20, grainScale: 3.8, flow: 0.42, light: 0.70, shimmer: 0 },
      thinking:  { radius: 0.80, grain: 0.26, grainScale: 5.2, flow: 0.85, light: 0.78, shimmer: 0.30 },
      speaking:  { radius: 0.90, grain: 0.22, grainScale: 3.6, flow: 0.55, light: 0.80, shimmer: 0 },
      error:     { radius: 0.72, grain: 0.30, grainScale: 6.5, flow: 0.16, light: 0.42, shimmer: 0 },
      ended:     { radius: 0.68, grain: 0.08, grainScale: 2.8, flow: 0.06, light: 0.45, shimmer: 0 },
    };

    const draw = (now: number) => {
      const t = (now - started) / 1000;
      const phase = phaseRef.current;
      const profile = PROFILE[phase] ?? PROFILE.idle;
      const measured = levelRef.current;
      // Only a real reading moves the sphere. `null` = no audio available.
      const target = measured === null ? 0 : measured;
      smoothed += (target - smoothed) * (target > smoothed ? 0.5 : 0.1);

      // Listening also gets a gentle breath from the real mic level so the
      // sphere visibly responds to someone actually talking.
      const breathe =
        phase === "listening" || phase === "speaking" ? smoothed : 0;
      const radius = Math.min(1, profile.radius * (1 + breathe * 0.10));
      const grainAmp = profile.grain * (1 + breathe * 1.25);
      const flow = profile.flow * (1 + breathe * 0.8);
      const light = Math.min(1, profile.light + breathe * 0.22);

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const baseR = (Math.min(w, h) / 2) * radius;
      // Light from the upper left, as with a soft studio key light.
      const lx = -0.42;
      const ly = -0.5;
      const lz = 0.76;

      let i = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const nx = (x - cx) / baseR;
          const ny = (y - cy) / baseR;
          const r2 = nx * nx + ny * ny;

          if (r2 > 1) {
            // Soft edge instead of a hard cut.
            const edge = Math.min(1, (1 - r2) * 26);
            px[i] = 0;
            px[i + 1] = 0;
            px[i + 2] = 0;
            px[i + 3] = Math.round(Math.max(0, edge) * 255);
            i += 4;
            continue;
          }

          const nz = Math.sqrt(Math.max(0, 1 - r2));

          // Displacement field: organic drift, pulled inward while thinking.
          const swirl = phase === "thinking" ? 0.6 : 1;
          const dx = nx + Math.sin(ny * 2.2 + t * flow) * 0.16 * swirl;
          const dy = ny + Math.cos(nx * 2.0 - t * flow * 0.85) * 0.16 * swirl;

          const g =
            noise(dx * profile.grainScale, dy * profile.grainScale + t * flow * 1.6) - 0.5;

          // Lambert-ish shading with a rim term.
          const lambert = Math.max(0, nx * lx + ny * ly + nz * lz);
          const rim = Math.pow(1 - nz, 3.2);

          let lum = 0.06 + lambert * light + rim * 0.30;
          lum += g * grainAmp;

          if (profile.shimmer > 0) {
            // A slow band travelling up the sphere reads as "processing".
            const band = Math.sin((ny + t * 0.5) * 9) * 0.5 + 0.5;
            lum += band * profile.shimmer * (0.35 + Math.abs(g));
          }

          lum = Math.max(0, Math.min(1, lum));
          // Gentle contrast curve; keeps highlights from clipping to flat white.
          lum = lum * lum * (3 - 2 * lum);

          const v = Math.round(lum * 246);
          px[i] = v;
          px[i + 1] = v;
          px[i + 2] = v;
          px[i + 3] = 255;
          i += 4;
        }
      }

      ctx.putImageData(image, 0, 0);
      if (running) raf = requestAnimationFrame(draw);
    };

    redrawRef.current = () => draw(performance.now());

    if (reducedMotion) {
      // One honest static frame: state is still visible, nothing moves.
      redrawRef.current();
    } else {
      raf = requestAnimationFrame(draw);
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reducedRef.current) {
        running = true;
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      redrawRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `reducedMotion` is a dependency so toggling the setting rebuilds the
    // effect: it starts or stops the loop rather than leaving one running.
  }, [size, reducedMotion]);

  // With reduced motion there is no loop, so each state change repaints the
  // single static frame instead. The state stays visible without any animation.
  useEffect(() => {
    if (reducedMotion) redrawRef.current?.();
  }, [reducedMotion, phase, level, size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
      // Purely decorative: the same state is always available as text and to
      // screen readers. Never announce or describe the canvas itself.
      aria-hidden="true"
      role="presentation"
    />
  );
}
