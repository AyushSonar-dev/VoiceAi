"use client";

import { useEffect, useRef } from "react";
import {
  MAGNIFY_STEPS,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  type Magnify,
  type PrefsController,
  type Theme,
} from "@/lib/prefs";

interface Props {
  /** the single preferences controller — this component never stores its own copy */
  prefs: PrefsController;
  /**
   * In the top bar the group is collapsed behind a disclosure that also reports
   * the current values, because a dozen buttons and a slider would otherwise
   * dominate the header. On the pre-connection screen it is always open, since
   * there is nothing else competing with it.
   */
  compact?: boolean;
}

const CONTRAST_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

const MOTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "system", label: "System" },
  { value: "on", label: "Reduced" },
  { value: "off", label: "Full" },
];

/**
 * Accessibility settings. Deliberately a labelled group of real controls — no
 * unlabelled icon menus, no keyboard traps. Preferences live in localStorage
 * and are never sent to the backend, because they change presentation only.
 *
 * The disclosure is a native `<details>`, so it is keyboard operable and
 * correctly announced without any extra ARIA.
 */
export function AccessibilityControls({ prefs, compact = false }: Props) {
  const {
    prefs: values,
    reducedMotion,
    systemReducedMotion,
    zoomSupported,
    setTheme,
    setTextSizePercent,
    setMagnify,
    setReducedMotion,
  } = prefs;

  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  // Start open on a wide screen, collapsed on a narrow one. Set imperatively so
  // the element stays uncontrolled and the user keeps full control of it.
  useEffect(() => {
    if (!compact) return;
    const wide = window.matchMedia("(min-width: 64rem)").matches;
    if (detailsRef.current) detailsRef.current.open = wide;
  }, [compact]);

  const currentMotion = values.reducedMotion === null ? "system" : values.reducedMotion ? "on" : "off";
  const themeWord =
    values.theme === "system"
      ? "system contrast"
      : values.theme === "dark"
        ? "dark"
        : "light";

  return (
    <details className="controls" ref={detailsRef} open={!compact || undefined}>
      <summary className="controls__summary">
        <span className="controls__summary-label">Accessibility settings</span>
        <span className="controls__summary-values">
          {themeWord} · {values.textSizePercent}% text · {values.magnify}% zoom
          {reducedMotion ? " · reduced motion" : ""}
        </span>
      </summary>

      <div className="controls__body">
        <fieldset className="control">
          <legend className="control__legend">Contrast</legend>
          <div className="segmented">
            {CONTRAST_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="segmented__option"
                aria-pressed={values.theme === option.value}
                onClick={() => setTheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="control">
          <legend className="control__legend">Magnifier</legend>
          <div className="segmented">
            {MAGNIFY_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                className="segmented__option"
                aria-pressed={values.magnify === step}
                disabled={!zoomSupported}
                onClick={() => setMagnify(step as Magnify)}
                aria-label={`Magnify content to ${step} percent`}
              >
                {step}%
              </button>
            ))}
          </div>
          {!zoomSupported ? (
            <span className="control__value control__value--warn">
              This browser can&apos;t magnify; text size still works.
            </span>
          ) : null}
        </fieldset>

        <fieldset className="control">
          <legend className="control__legend">Motion</legend>
          <div className="segmented">
            {MOTION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="segmented__option"
                aria-pressed={currentMotion === option.value}
                onClick={() => setReducedMotion(option.value === "system" ? null : option.value === "on")}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="control__value">
            {reducedMotion
              ? `Motion reduced${systemReducedMotion ? " (also set by your system)" : ""}`
              : "Full motion"}
          </span>
        </fieldset>

        <div className="control control--range">
          <label className="control__label" htmlFor="text-size">
            Text size <span className="control__value">{values.textSizePercent}%</span>
          </label>
          <input
            id="text-size"
            type="range"
            min={TEXT_SIZE_MIN}
            max={TEXT_SIZE_MAX}
            step={5}
            value={values.textSizePercent}
            onChange={(e) => setTextSizePercent(Number(e.target.value))}
            aria-valuetext={`${values.textSizePercent} percent`}
          />
        </div>
      </div>
    </details>
  );
}
