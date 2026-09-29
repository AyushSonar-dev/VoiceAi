"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrefersReducedMotion } from "./a11y";

/**
 * Visual preferences. These are deliberately frontend-only: they are never sent
 * to the backend, because they change how the interface is presented, not what
 * it does. They persist in localStorage so a reload keeps the user's choices.
 */
export type Theme = "system" | "light" | "dark";
export type Magnify = 100 | 125 | 150 | 200;

export interface Prefs {
  theme: Theme;
  /** Base text size as a percentage of the browser default. */
  textSizePercent: number;
  /** Visual scale applied to the content region. */
  magnify: Magnify;
  /** null = follow the operating system. true/false = the user chose. */
  reducedMotion: boolean | null;
}

const KEYS = {
  theme: "echolabs.theme",
  textSize: "echolabs.fontSizePercent",
  magnify: "echolabs.magnify",
  reducedMotion: "echolabs.reducedMotion",
} as const;

export const TEXT_SIZE_MIN = 85;
export const TEXT_SIZE_MAX = 160;
export const MAGNIFY_STEPS: Magnify[] = [100, 125, 150, 200];

export const DEFAULTS: Prefs = {
  theme: "dark",
  textSizePercent: 100,
  magnify: 100,
  reducedMotion: null,
};

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readNumber(key: string): number | null {
  const raw = readString(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function readBool(key: string): boolean | null {
  const raw = readString(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readPrefs(): Prefs {
  const theme = readString(KEYS.theme);
  const textSize = readNumber(KEYS.textSize);
  const magnify = readNumber(KEYS.magnify);
  return {
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULTS.theme,
    textSizePercent:
      textSize === null
        ? DEFAULTS.textSizePercent
        : clamp(textSize, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    magnify: MAGNIFY_STEPS.includes(magnify as Magnify) ? (magnify as Magnify) : DEFAULTS.magnify,
    reducedMotion: readBool(KEYS.reducedMotion),
  };
}

export function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — preferences just won't persist */
  }
}

/**
 * `zoom` keeps magnification accessible because it re-lays-out the content
 * (unlike `transform: scale`, which overlaps, clips and breaks hit targets).
 * Browsers without it fall back to a font-size scale, which still enlarges
 * text and spacing. The UI reports support so the control never lies.
 */
export function detectZoomSupport(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  return CSS.supports("zoom", "1.5");
}

export function usePrefs() {
  const systemReducedMotion = usePrefersReducedMotion();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [zoomSupported, setZoomSupported] = useState(true);

  // Read after mount so the server-rendered markup and the first client render
  // match; applying storage during render would trip hydration.
  useEffect(() => {
    setPrefs(readPrefs());
    setZoomSupported(detectZoomSupport());
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    setPrefs((p) => ({ ...p, theme }));
    write(KEYS.theme, theme);
  }, []);

  const setTextSizePercent = useCallback((percent: number) => {
    const next = clamp(Math.round(percent), TEXT_SIZE_MIN, TEXT_SIZE_MAX);
    setPrefs((p) => ({ ...p, textSizePercent: next }));
    write(KEYS.textSize, String(next));
  }, []);

  const setMagnify = useCallback((magnify: Magnify) => {
    setPrefs((p) => ({ ...p, magnify }));
    write(KEYS.magnify, String(magnify));
  }, []);

  const setReducedMotion = useCallback((reducedMotion: boolean | null) => {
    setPrefs((p) => ({ ...p, reducedMotion }));
    if (reducedMotion === null) {
      try {
        localStorage.removeItem(KEYS.reducedMotion);
      } catch {
        /* ignore */
      }
    } else {
      write(KEYS.reducedMotion, String(reducedMotion));
    }
  }, []);

  // The user's choice always wins over the OS setting.
  const reducedMotion = prefs.reducedMotion ?? systemReducedMotion;

  // Applies the preferences to the document so CSS can respond declaratively.
  // "system" is resolved to a concrete palette here so the CSS only ever has to
  // reason about two themes.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      if (prefs.theme !== "system") {
        root.dataset.theme = prefs.theme;
        return;
      }
      const dark =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (prefs.theme !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [prefs.theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${prefs.textSizePercent}%`;
  }, [prefs.textSizePercent]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.magnify = String(prefs.magnify);
    root.dataset.reducedMotion = reducedMotion ? "on" : "off";
    root.style.setProperty("--content-scale", String(prefs.magnify / 100));
  }, [prefs.magnify, reducedMotion]);

  return useMemo(
    () => ({
      prefs,
      systemReducedMotion,
      reducedMotion,
      zoomSupported,
      setTheme,
      setTextSizePercent,
      setMagnify,
      setReducedMotion,
    }),
    [
      prefs,
      systemReducedMotion,
      reducedMotion,
      zoomSupported,
      setTheme,
      setTextSizePercent,
      setMagnify,
      setReducedMotion,
    ]
  );
}

export type PrefsController = ReturnType<typeof usePrefs>;
