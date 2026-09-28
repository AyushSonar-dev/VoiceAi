import { CORE_PROFILES, type AgentPhase, type AudioMeter } from "./agentState";

/**
 * The Agent Core's pixel shading, as a pure function.
 *
 * It is deliberately separate from the React component: the one property that
 * matters most here — that the silhouette is a mathematically round disc which
 * is never clipped, whatever the size or display density — is something that can
 * only be trusted if it can be checked. Keeping the maths here makes it
 * testable without a browser.
 */

export interface CoreFrame {
  /** Shading buffer size in pixels; always square and even. */
  size: number;
  /** Backing-store size the component should allocate, i.e. `size`. */
  cssSize: number;
  /** Effective density the buffer was rendered at. */
  dpr: number;
  /** RGBA, `size * size * 4` bytes. */
  data: Uint8ClampedArray;
  /** Painted radius in buffer pixels. */
  radius: number;
  /** Phase actually rendered. */
  phase: AgentPhase;
  /** Measured audio 0..1 that drove this frame, or null when there was none. */
  level: number | null;
}

/**
 * The largest shading buffer worth drawing.
 *
 * Every pixel costs a noise lookup, which is four hashes, so the cost is
 * quadratic in the buffer size. The core also animates continuously, so the
 * budget is per frame: at 320px the whole disc shades in a few milliseconds,
 * which holds 60fps on a modest laptop, and the browser's own upscale to the
 * displayed size is invisible on a surface this grainy. Rendering the sphere at
 * full device resolution instead would quadruple the work for no visible gain,
 * because there is no hard edge inside the disc to preserve.
 */
const MAX_SHADE = 320;
const MIN_SHADE = 64;

/** The even, square buffer size used for a given CSS size and display density. */
export function coreBufferSize(cssSize: number, devicePixelRatio: number): number {
  const requested = cssSize * Math.min(1.5, Math.max(1, devicePixelRatio));
  const capped = Math.min(MAX_SHADE, Math.max(MIN_SHADE, requested));
  // Even, so the centre sits on an exact pixel boundary; an odd box is the
  // usual reason a canvas circle looks subtly oval.
  return Math.max(8, Math.round(capped / 2) * 2);
}

/* ---------------------------------------------------------------- noise */

/**
 * An integer bit-mix hash, not the usual `fract(sin(...))` trick.
 *
 * The sphere needs four hashes per pixel, every frame, for every pixel inside
 * the disc. `Math.sin` is an order of magnitude slower than integer multiplies,
 * and profiling this loop showed the sin-based hash was the single largest cost
 * in the animation. This produces an equally uniform value at a fraction of the
 * price, which is what buys the frame rate back.
 */
function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

/* ------------------------------------------------------------- painting */

export interface RenderOptions {
  /** CSS pixel diameter. Rounded to an even integer internally. */
  cssSize: number;
  dpr: number;
  phase: AgentPhase;
  /** Seconds since the loop started; drives flow and spin. */
  t: number;
  /** Smoothed measured level 0..1, or null when there is no audio. */
  level: number | null;
  /** Smoothed energy 0..1 from useAudioEnergy. */
  energy: number;
  /** Breath position in cycles, 0..1. */
  breath: number;
}

/**
 * Paints one frame.
 *
 * Coverage is decided by the exact distance from the centre, so the painted
 * region is a true circle at any size and density: a pixel is fully opaque well
 * inside the radius, fully transparent well outside it, and the single pixel
 * straddling the boundary is blended. Nothing is ever drawn outside the radius,
 * so the disc cannot be clipped by the canvas box however the layout behaves.
 */
export function renderCoreFrame(options: RenderOptions): CoreFrame {
  const { t, energy, breath } = options;
  const phase = options.phase;
  const p = CORE_PROFILES[phase] ?? CORE_PROFILES.idle;

  // An even square shading buffer; the CSS box scales it up to the display
  // size, which is invisible on a surface this grainy.
  const cssSize = Math.max(8, Math.round(options.cssSize));
  const size = coreBufferSize(cssSize, options.dpr);
  const dpr = size / cssSize;
  const data = new Uint8ClampedArray(size * size * 4);

  const measured = options.level;
  // `null` is genuinely no audio, so the amplitude term below is exactly 0 and
  // nothing about the movement is invented.
  const audio = measured ?? 0;

  // The single explicit audio -> visual mapping.
  const drive = audio * energy;
  const breathe = p.breathDepth * (0.5 + 0.5 * Math.sin(breath * Math.PI * 2));

  const half = size / 2;
  const swell = 1 + breathe * 0.5 + drive * (phase === "speaking" ? 0.11 : 0.075);
  // The ceiling is below 1 on purpose: it guarantees a transparent margin inside
  // the canvas at full volume, so the disc can never be cut off by the edge. It
  // is set high enough that the loudest real signal still lands inside it, so
  // the clamp never cancels the audio response.
  const radius = half * Math.min(0.96, p.radius * swell);

  const cx = size / 2;
  const cy = size / 2;
  const spin = p.spin > 0 ? Math.sin(t * p.spin) : 0;
  const cos = Math.cos(spin);
  const sin = Math.sin(spin);

  const lx = -0.4;
  const ly = -0.52;
  const lz = 0.75;

  const grainAmp = p.grain * (1 + drive * 1.35);
  const flow = p.flow * (1 + drive * 0.9);
  const light = Math.min(1, p.light + drive * 0.2);
  const exposure = Math.min(1.15, p.energy * (1 + drive * 0.22));

  const edgeLimit = radius + 0.5;
  const edgeLimit2 = edgeLimit * edgeLimit;
  const innerLimit = radius - 0.5;

  let i = 0;
  for (let y = 0; y < size; y++) {
    const dy0 = y + 0.5 - cy;
    const dy2 = dy0 * dy0;
    for (let x = 0; x < size; x++) {
      const dx0 = x + 0.5 - cx;
      const d2 = dx0 * dx0 + dy2;

      // Compared squared, so the overwhelmingly common case costs no square
      // root at all; the root is only needed in the one-pixel boundary band.
      if (d2 > edgeLimit2) {
        // Fully transparent: the buffer is never filled.
        i += 4;
        continue;
      }
      const cover =
        d2 < innerLimit * innerLimit ? 1 : edgeLimit - Math.sqrt(d2);

      const nx = dx0 / radius;
      const ny = dy0 / radius;
      const r2 = nx * nx + ny * ny;
      const nz = Math.sqrt(Math.max(0, 1 - r2));

      const rx = nx * cos - ny * sin;
      const ry = nx * sin + ny * cos;
      const pull = p.inward * 0.22;
      const dx = rx * (1 - pull) + Math.sin(ry * 2.1 + t * flow) * 0.17;
      const dy = ry * (1 - pull) + Math.cos(rx * 1.9 - t * flow * 0.8) * 0.17;

      const g =
        noise(
          dx * p.grainScale + (p.inward > 0 ? 1 / (1 + r2 * 3) : 0),
          dy * p.grainScale + t * flow * 1.5
        ) - 0.5;

      const lambert = nx * lx + ny * ly + nz * lz;
      const u = 1 - nz;
      // Integer exponents rather than Math.pow, which is a library call in the
      // inner loop. The shapes are visually the same at these values.
      const rim = u * u * u;
      // A defined boundary just inside the silhouette, so the circle keeps a
      // clear edge even against a dark background.
      const e = (1 - r2) * 3.2;
      const edge = e > 1 ? 1 : e * e;

      let lum = 0.05 + (lambert > 0 ? lambert : 0) * light + rim * 0.26 + edge * 0.1;
      lum += g * grainAmp;
      lum *= exposure;
      lum = Math.max(0, Math.min(1, lum));
      lum = lum * lum * (3 - 2 * lum);

      const v = Math.round(lum * 248);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = Math.round(cover * 255);
      i += 4;
    }
  }

  return { size, cssSize, dpr, data, radius, phase, level: measured };
}

/**
 * The thin ring outside the silhouette, used to mark the two states where the
 * agent is genuinely taking in or producing sound. Drawn by the caller with the
 * 2D context because it is a stroke rather than shaded pixels.
 */
/**
 * The measured level that applies to a phase, or `null` for "no audio here".
 *
 * Only one direction can be in play at a time and the phase decides which: the
 * microphone while the core is listening, the agent's playback while it is
 * speaking. Everything else — connecting, thinking, idle, ended — is `null`, so
 * the core falls back to its own slow breath instead of reacting to audio that
 * is not its own. Getting this wrong is how a core ends up pulsing to someone
 * else's voice, so it lives here as a pure function and is tested directly.
 */
export function levelForPhase(
  meter: AudioMeter,
  phase: AgentPhase,
  reducedMotion: boolean
): number | null {
  if (reducedMotion) return null;
  if (!meter.source || meter.value <= 0) return null;
  if (phase === "speaking") return meter.source === "out" ? meter.value : null;
  if (phase === "listening") return meter.source === "in" ? meter.value : null;
  return null;
}

export function coreRingAlpha(phase: AgentPhase, drive: number) {
  const p = CORE_PROFILES[phase] ?? CORE_PROFILES.idle;
  if (p.ring <= 0) return 0;
  return Math.min(1, 0.06 + p.ring * 0.16 + drive * 0.12);
}
