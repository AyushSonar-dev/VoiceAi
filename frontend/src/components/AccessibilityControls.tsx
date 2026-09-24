"use client";

import type { Theme } from "@/lib/a11y";

interface Props {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  fontSizePercent: number;
  onFontSizeChange: (pct: number) => void;
}

export function AccessibilityControls({ theme, onThemeChange, fontSizePercent, onFontSizeChange }: Props) {
  return (
    <div className="card controls" role="group" aria-label="Accessibility settings">
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Contrast</legend>
        <div className="row">
          {(["system", "light", "dark"] as Theme[]).map((value) => (
            <button
              key={value}
              type="button"
              className="btn"
              aria-pressed={theme === value}
              onClick={() => onThemeChange(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="font-size" style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
          Text size: <strong>{fontSizePercent}%</strong>
        </label>
        <input
          id="font-size"
          type="range"
          min={85}
          max={160}
          step={5}
          value={fontSizePercent}
          onChange={(e) => onFontSizeChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}