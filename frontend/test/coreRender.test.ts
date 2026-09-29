import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  CORE_PROFILES,
  easeToward,
  lerpProfile,
  profilesConverged,
  resolvePhase,
  type AgentPhase,
  type AudioMeter,
} from "../src/lib/agentState.js";
import { renderCoreFrame, levelForPhase } from "../src/lib/coreRender.js";
import type { AgentStatus } from "../src/lib/voiceAgent.js";

/**
 * The Agent Core's silhouette.
 *
 * These assertions exist because "the circle looked clipped / not quite round"
 * is the failure this component has to be immune to. The shading is drawn per
 * pixel from the exact distance to the centre, so roundness is a property of the
 * geometry rather than of a border-radius, a container's aspect ratio, or a
 * layout that happened to be square.
 */

const PHASES: AgentPhase[] = [
  "disconnected",
  "connecting",
  "deactivating",
  "idle",
  "listening",
  "thinking",
  "speaking",
  "error",
  "ended",
];

/** Alpha of the pixel whose centre is nearest to (x, y), in device pixels. */
function alphaAt(data: Uint8ClampedArray, size: number, x: number, y: number) {
  return data[(y * size + x) * 4 + 3];
}

function paint(over: Partial<Parameters<typeof renderCoreFrame>[0]> = {}) {
  return renderCoreFrame({
    cssSize: 300,
    dpr: 1,
    phase: "idle",
    t: 1.7,
    level: null,
    energy: 0.5,
    breath: 0.25,
    ...over,
  });
}

describe("core silhouette", () => {
  test("is round in every state, at every size and display density", () => {
    for (const phase of PHASES) {
      for (const cssSize of [200, 251, 414, 519]) {
        for (const dpr of [1, 1.5, 2]) {
          const frame = paint({ phase, cssSize, dpr });
          const { size, data, radius } = frame;
          const cx = size / 2;
          const cy = size / 2;

          // At every angle, a point inside the painted radius must be opaque and
          // the same distance beyond it must be completely clear. A clipped or
          // oval disc fails on at least one of them.
          for (let a = 0; a < 360; a += 15) {
            const rad = (a * Math.PI) / 180;
            const ix = Math.round(cx + Math.cos(rad) * (radius - 2));
            const iy = Math.round(cy + Math.sin(rad) * (radius - 2));
            const ox = Math.round(cx + Math.cos(rad) * (radius + 2));
            const oy = Math.round(cy + Math.sin(rad) * (radius + 2));
            const label = `${phase} ${cssSize}@${dpr} ${a}deg`;

            assert.ok(
              alphaAt(data, size, ix, iy) > 200,
              `expected opaque inside the disc at ${label}`
            );
            assert.equal(
              alphaAt(data, size, ox, oy),
              0,
              `expected clear outside the disc at ${label}`
            );
          }
        }
      }
    }
  });

  test("never paints to the edge of the box, even at full volume and peak breath", () => {
    for (const phase of PHASES) {
      const frame = paint({ phase, cssSize: 400, dpr: 2, t: 3.3, level: 1, energy: 1, breath: 0.5 });
      // A margin of at least a couple of device pixels is always left, so the
      // silhouette cannot be cut off by the edge of the canvas.
      assert.ok(frame.radius < frame.size / 2, `${phase} painted past the centre`);
      assert.ok(
        frame.size / 2 - frame.radius > 1,
        `${phase} left no margin inside the canvas`
      );
    }
  });

  test("keeps an even square backing store so the centre sits on exact pixels", () => {
    for (const cssSize of [199, 200, 333, 414, 517]) {
      for (const dpr of [1, 2, 3]) {
        const frame = paint({ cssSize, dpr });
        assert.equal(frame.size % 2, 0, `${cssSize}@${dpr} produced an odd box`);
        assert.equal(frame.data.length, frame.size * frame.size * 4);
      }
    }
  });

  test("caps the shading buffer so the animation holds a frame budget", () => {
    // Every pixel costs a noise lookup, and the cost is quadratic, so an
    // uncapped buffer at full device resolution would stutter. The browser
    // upscales instead, which is invisible on a surface this grainy.
    for (const cssSize of [200, 414, 520]) {
      for (const dpr of [1, 2, 3]) {
        const frame = paint({ cssSize, dpr });
        assert.ok(frame.size <= 320, `${cssSize}@${dpr} drew a ${frame.size}px buffer`);
        // Still at least device resolution for a small core, so small screens
        // are not needlessly soft.
        if (cssSize <= 240 && dpr === 1) {
          assert.ok(frame.size >= cssSize - 1, "a small core was downscaled needlessly");
        }
        // The CSS size is reported separately so the component can size the
        // element independently of the buffer.
        assert.equal(frame.cssSize, cssSize);
      }
    }
  });

  test("keeps every painted pixel either fully opaque or fully clear", () => {
    // A soft-edged disc was the original reason the core looked ragged, so only
    // the single antialiased boundary row may be an intermediate alpha.
    const frame = paint({ cssSize: 300, dpr: 2, phase: "listening", t: 2.2, level: 0.6, energy: 0.8 });
    let intermediate = 0;
    for (let i = 3; i < frame.data.length; i += 4) {
      const a = frame.data[i];
      if (a !== 0 && a !== 255) intermediate += 1;
    }
    assert.ok(
      intermediate < frame.size * 4,
      `too many partially transparent pixels: ${intermediate}`
    );
  });
});

describe("core state profiles", () => {
  test("gives every state a distinct radius", () => {
    // Size is the cue that survives a greyscale render, a still screenshot and a
    // screen reader's silence, so no two states may share one.
    const radii = PHASES.map((p) => CORE_PROFILES[p].radius);
    assert.equal(new Set(radii).size, PHASES.length, "two states share a radius");

    // And the ladder must be strictly ordered, so the states tell a story:
    // thinking is visibly smaller than idle, listening visibly larger.
    const bySize = [...PHASES].sort(
      (a, b) => CORE_PROFILES[a].radius - CORE_PROFILES[b].radius
    );
    assert.deepEqual(bySize, [
      "ended",
      "disconnected",
      "error",
      "thinking",
      "deactivating",
      "connecting",
      "idle",
      "speaking",
      "listening",
    ]);
  });

  test("gives every state a unique overall signature", () => {
    // Two resting states may legitimately share a near-zero flow, so the
    // invariant is not per-field uniqueness but that no two states are
    // indistinguishable once size, texture, light and motion are read together.
    const signature = (phase: AgentPhase) => {
      const p = CORE_PROFILES[phase];
      return [
        p.radius,
        p.grain,
        p.grainScale,
        p.flow,
        p.inward,
        p.spin,
        p.light,
        p.energy,
        p.ring,
      ].join("/");
    };
    const all = PHASES.map(signature);
    assert.equal(new Set(all).size, PHASES.length, "two states are visually identical");
  });

  test("separates idle from listening, which the agent reports with one status", () => {
    // The agent's `listening` status covers both "idly waiting" and "the user is
    // talking", so the two profiles must be far enough apart to carry that
    // difference on their own.
    const idle = CORE_PROFILES.idle;
    const listening = CORE_PROFILES.listening;
    assert.ok(listening.radius > idle.radius, "listening is not larger than idle");
    assert.ok(listening.grain > idle.grain, "listening is not grainier than idle");
    assert.ok(listening.flow > idle.flow, "listening is not livelier than idle");
  });

  test("speaking is driven by measured audio, and absent audio drives nothing", () => {
    const quiet = paint({ phase: "speaking", level: null, energy: 1, breath: 0 });
    const zero = paint({ phase: "speaking", level: 0, energy: 1, breath: 0 });
    const loud = paint({ phase: "speaking", level: 1, energy: 1, breath: 0 });

    // No audio must be treated as genuinely no audio, not as a level of zero
    // that happens to be indistinguishable from a silent signal.
    assert.equal(quiet.level, null);
    assert.ok(Math.abs(quiet.radius - zero.radius) < 1e-6, "null and zero differ");
    assert.ok(loud.radius > quiet.radius + 4, "a loud signal does not expand the core");
  });

  test("drawing the core produces different pixels over time", () => {
    // Guards against a frame that renders once and then never changes, which
    // would make every state look identical on screen.
    const a = paint({ phase: "listening", t: 0.2, level: 0.5, energy: 1 });
    const b = paint({ phase: "listening", t: 1.9, level: 0.5, energy: 1 });
    assert.notDeepEqual(Array.from(a.data), Array.from(b.data));
  });
});

describe("core frame budget", () => {
  test("shades a frame well inside the 60fps budget", () => {
    // The sphere is redrawn every frame, so its cost is a per-frame budget, not
    // a one-off. A `Math.sin`-based noise hash and full device resolution both
    // blew this budget when this was first written; the guard stops either from
    // creeping back in.
    for (let i = 0; i < 60; i++) paint({ cssSize: 414, dpr: 2, t: i * 0.016 });

    const N = 40;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      paint({ cssSize: 414, dpr: 2, phase: "speaking", t: i * 0.016, level: 0.6, energy: 1 });
    }
    const msPerFrame = (performance.now() - t0) / N;

    assert.ok(
      msPerFrame < 16.7,
      `a frame took ${msPerFrame.toFixed(2)}ms, over the 16.7ms budget for 60fps`
    );
  });
});

describe("which audio the core listens to", () => {
  const mic: AudioMeter = { value: 0.7, source: "in" };
  const voice: AudioMeter = { value: 0.9, source: "out" };
  const silence: AudioMeter = { value: 0, source: null };

  test("the microphone drives the core only while listening", () => {
    assert.equal(levelForPhase(mic, "listening", false), 0.7);
    // Same meter, every other phase: nothing to respond to, and never the
    // microphone's noise driving the core while the agent is talking.
    for (const phase of PHASES) {
      if (phase === "listening") continue;
      assert.equal(levelForPhase(mic, phase, false), null, phase);
    }
  });

  test("the agent's own voice drives the core only while speaking", () => {
    assert.equal(levelForPhase(voice, "speaking", false), 0.9);
    for (const phase of PHASES) {
      if (phase === "speaking") continue;
      assert.equal(levelForPhase(voice, phase, false), null, phase);
    }
  });

  test("the two directions never drive the core at once", () => {
    assert.equal(levelForPhase(mic, "speaking", false), null);
    assert.equal(levelForPhase(voice, "listening", false), null);
  });

  test("silence is null, never a fake zero", () => {
    assert.equal(levelForPhase(silence, "listening", false), null);
    assert.equal(levelForPhase(silence, "speaking", false), null);
    assert.equal(levelForPhase({ value: 0, source: "in" }, "listening", false), null);
  });

  test("reduced motion reads no level at all", () => {
    for (const phase of PHASES) {
      assert.equal(levelForPhase(mic, phase, true), null, phase);
      assert.equal(levelForPhase(voice, phase, true), null, phase);
    }
  });
});


describe("eased state changes", () => {
  test("lerp walks between two states and lands exactly on the target", () => {
    const from = CORE_PROFILES.listening;
    const to = CORE_PROFILES.disconnected;

    assert.equal(lerpProfile(from, to, 0).radius, from.radius, "k=0 must not move");
    assert.equal(lerpProfile(from, to, 1).radius, to.radius, "k=1 must arrive");

    // Halfway is genuinely halfway on every field, not a per-field snap.
    const half = lerpProfile(from, to, 0.5);
    for (const key of Object.keys(from) as Array<keyof typeof from>) {
      assert.ok(
        Math.abs(half[key] - (from[key] + to[key]) / 2) < 1e-9,
        `${key} is not halfway`
      );
    }
  });

  test("every field moves monotonically toward the target", () => {
    const from = CORE_PROFILES.speaking;
    const to = CORE_PROFILES.idle;
    let previous = from.radius;
    for (const k of [0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const step = lerpProfile(from, to, k).radius;
      assert.ok(step <= previous + 1e-9, "radius must never reverse");
      previous = step;
    }
  });

  test("k is clamped, so a bad frame cannot overshoot the target", () => {
    const from = CORE_PROFILES.listening;
    const to = CORE_PROFILES.disconnected;
    assert.equal(lerpProfile(from, to, -5).radius, from.radius);
    assert.equal(lerpProfile(from, to, 99).radius, to.radius);
  });

  test("easeToward closes the gap and never jumps", () => {
    const from = CORE_PROFILES.listening;
    const to = CORE_PROFILES.idle;
    const distance = Math.abs(from.radius - to.radius);

    // One frame of a 60Hz display is a small step, not the whole distance.
    const oneFrame = easeToward(from, to, 1 / 60);
    const step = Math.abs(oneFrame.radius - from.radius);
    assert.ok(step > 0, "must actually move");
    assert.ok(step < distance, "must not arrive in a single frame");

    // Many frames converge, and each frame is smaller than the one before it.
    let look = from;
    let last = Infinity;
    for (let i = 0; i < 240; i += 1) {
      look = easeToward(look, to, 1 / 60);
      const remaining = Math.abs(look.radius - to.radius);
      assert.ok(remaining <= last + 1e-12, "convergence must not oscillate");
      last = remaining;
    }
    assert.ok(profilesConverged(look, to), "must eventually arrive");
  });

  test("easeToward is frame rate independent", () => {
    const from = CORE_PROFILES.connecting;
    const to = CORE_PROFILES.speaking;
    // The same wall-clock time in a different number of frames must land in
    // effectively the same place, or the transition would depend on the display.
    let sixty = from;
    for (let i = 0; i < 60; i += 1) sixty = easeToward(sixty, to, 1 / 60);
    let hundredTwenty = from;
    for (let i = 0; i < 120; i += 1) hundredTwenty = easeToward(hundredTwenty, to, 1 / 120);
    assert.ok(
      Math.abs(sixty.radius - hundredTwenty.radius) < 1e-6,
      "60Hz and 120Hz disagree"
    );
  });

  test("a frozen clock makes no progress at all", () => {
    const from = CORE_PROFILES.listening;
    const to = CORE_PROFILES.idle;
    assert.equal(easeToward(from, to, 0).radius, from.radius);
  });
});

describe("disconnect is its own visible state", () => {
  const base = {
    connected: true,
    agentStatus: null as AgentStatus | null,
    recording: false,
    busy: false,
    speaking: false,
    filler: false,
    deactivating: false,
    userSpeaking: false,
  };

  test("is not confused with a plain disconnect", () => {
    // `connected` is cleared as part of shutting down, so this state is only
    // reachable if it is checked first.
    assert.equal(resolvePhase({ ...base, deactivating: true, connected: false }), "deactivating");
  });

  test("settles back to disconnected when the shutdown finishes", () => {
    assert.equal(resolvePhase({ ...base, deactivating: false, connected: false }), "disconnected");
  });

  test("keeps the profile ladder honest while closing", () => {
    assert.ok(
      CORE_PROFILES.deactivating.radius < CORE_PROFILES.connecting.radius,
      "deactivating should be smaller than connecting"
    );
    assert.ok(
      CORE_PROFILES.deactivating.radius > CORE_PROFILES.error.radius,
      "deactivating should still be larger than error"
    );
  });

  test("carries no audio drive, so nothing surges on the way out", () => {
    const meter: AudioMeter = { value: 0.8, source: "in" };
    assert.equal(levelForPhase(meter, "deactivating", false), null);
  });
});
