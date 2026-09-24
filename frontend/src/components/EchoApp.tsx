"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Capabilities, EchoState } from "@/types";
import { getCapabilities, getState, newSession, postTurn } from "@/lib/api";
import { ensureSessionId } from "@/lib/session";
import { fallbackSpeak, startRecording, type RecordingHandle } from "@/lib/audio";
import { usePrefersReducedMotion, type Theme } from "@/lib/a11y";
import { LiveRegion } from "./LiveRegion";
import { VoicePanel } from "./VoicePanel";
import { ProductList } from "./ProductList";
import { CartPanel } from "./CartPanel";
import { CheckoutPanel } from "./CheckoutPanel";
import { AccessibilityControls } from "./AccessibilityControls";

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];
const THEME_KEY = "echolabs.theme";
const FONT_KEY = "echolabs.fontSizePercent";

export function EchoApp() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [echoState, setEchoState] = useState<EchoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [lastUserText, setLastUserText] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [fillerText, setFillerText] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [fontSizePercent, setFontSizePercent] = useState(100);
  const recordingHandle = useRef<RecordingHandle | null>(null);
  const replyCounter = useRef(0);
  const reducedMotion = usePrefersReducedMotion();

  // ---- boot: settings, capabilities, session, state ----
  useEffect(() => {
    const storedTheme = (localStorage.getItem(THEME_KEY) as Theme | null) ?? "system";
    const storedFont = Number(localStorage.getItem(FONT_KEY) ?? "100");
    setTheme(storedTheme);
    setFontSizePercent(Number.isFinite(storedFont) && storedFont >= 85 && storedFont <= 160 ? storedFont : 100);

    let cancelled = false;
    (async () => {
      try {
        const [capabilities, id] = await Promise.all([
          getCapabilities().catch(() => null),
          ensureSessionId(newSession),
        ]);
        if (cancelled) return;
        setCaps(capabilities);
        setSessionId(id);
        const s = await getState(id);
        if (!cancelled) setEchoState(s);
      } catch {
        if (!cancelled) setLastReply("I couldn't reach the shopping service. Make sure the backend is running.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSizePercent}%`;
    localStorage.setItem(FONT_KEY, String(fontSizePercent));
  }, [fontSizePercent]);

  const playReply = useCallback(
    (reply: string, audioUrl: string | null) => {
      const speakFallback = () => fallbackSpeak(reply, { rate: 1, pitch: 1 });
      if (audioUrl) {
        const audio = new Audio(audioUrl);
        audio.play().catch(speakFallback);
      } else {
        speakFallback();
      }
    },
    []
  );

  const runTurn = useCallback(
    async (input: { text?: string; audioBase64?: string }) => {
      if (!sessionId || busy) return;
      setBusy(true);
      setLastReply("");
      setFillerText("");
      replyCounter.current += 1;
      try {
        const events = await postTurn({ sessionId, ...input });
        if (events.userText) setLastUserText(events.userText);
        if (events.filler) setFillerText(events.filler.text);
        setLastReply(events.reply);
        if (events.state) setEchoState(events.state);
        playReply(events.reply, events.audioUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setLastReply(`I couldn't finish that — ${message}. Nothing was changed.`);
      } finally {
        setBusy(false);
        setFillerText("");
      }
    },
    [sessionId, busy, playReply]
  );

  const toggleMic = useCallback(async () => {
    if (busy) return;
    if (recording) {
      const handle = recordingHandle.current;
      recordingHandle.current = null;
      setRecording(false);
      const audioBase64 = await handle?.stop();
      if (audioBase64) await runTurn({ audioBase64 });
      else setLastReply("I didn't capture any audio. Try again, or type your request.");
      return;
    }
    try {
      recordingHandle.current = await startRecording();
      setRecording(true);
    } catch {
      setLastReply(
        "I can't reach the microphone here — type your request instead, or allow mic access and reload."
      );
    }
  }, [busy, recording, runTurn]);

  const lastActionType =
    echoState?.lastAction && typeof echoState.lastAction === "object"
      ? (echoState.lastAction as { type?: string }).type
      : undefined;
  const awaitingCheckoutConfirmation = lastActionType === "checkout_preview";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Echo — voice shopping</h1>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            {caps
              ? `STT ${caps.stt ? "AssemblyAI" : "demo text"} · TTS ${caps.tts ? "ElevenLabs" : "browser"} · DB ${caps.db} · ${caps.currency}`
              : "connecting…"}
          </p>
        </div>
        <AccessibilityControls
          theme={theme}
          onThemeChange={setTheme}
          fontSizePercent={fontSizePercent}
          onFontSizeChange={setFontSizePercent}
        />
      </header>

      <LiveRegion text={busy && fillerText ? fillerText : lastReply} label="What Echo says" />

      <VoicePanel
        sttAvailable={caps?.stt ?? false}
        ttsAvailable={caps?.tts ?? false}
        busy={busy}
        recording={recording}
        onMicToggle={() => void toggleMic()}
        onSubmitText={(text) => void runTurn({ text })}
        lastUserText={lastUserText}
      />

      <ProductList
        products={echoState?.recentProducts ?? []}
        currency={caps?.currency ?? "₹"}
        busy={busy}
        onAdd={(optionIndex) =>
          void runTurn({ text: `add the ${ORDINALS[optionIndex] ?? `option ${optionIndex + 1}`} one to my cart` })
        }
      />

      <CartPanel
        cart={
          echoState?.cart ?? {
            isEmpty: true,
            lines: [],
            subtotal: 0,
            discountPercent: 0,
            discount: 0,
            total: 0,
            linesText: "",
            couponCode: null,
          }
        }
        currency={caps?.currency ?? "₹"}
        busy={busy}
        onRemove={(name) => void runTurn({ text: `remove the ${name} from my cart` })}
        onApplyCoupon={(code) => void runTurn({ text: `apply ${code}` })}
        onCheckout={() => void runTurn({ text: "check out" })}
      />

      {awaitingCheckoutConfirmation && (
        <div className="card" role="group" aria-label="Confirm checkout">
          <p style={{ marginTop: 0 }}>
            Echo previewed your order. Nothing is placed until you confirm.
          </p>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void runTurn({ text: "yes, place the order" })}
          >
            Yes, place the order
          </button>
        </div>
      )}

      {echoState?.lastOrder && (
        <CheckoutPanel order={echoState.lastOrder} currency={caps?.currency ?? "₹"} />
      )}

      <footer style={{ color: "var(--muted)", fontSize: "0.85rem" }} data-reduced-motion={reducedMotion}>
        {reducedMotion ? "Reduced motion respected. " : ""}
        Every action above runs through the backend tool gateway first — Echo only speaks
        what the server confirmed.
      </footer>
    </div>
  );
}