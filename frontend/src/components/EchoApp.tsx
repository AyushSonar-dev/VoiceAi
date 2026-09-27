"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Capabilities, EchoState } from "@/types";
import { callTool, getCapabilities, getState, getVoiceSetup, newSession, postTurn } from "@/lib/api";
import { ensureSessionId } from "@/lib/session";
import { fallbackSpeak, startRecording, type RecordingHandle } from "@/lib/audio";
import { VoiceAgentSession, type AgentStatus } from "@/lib/voiceAgent";
import { usePrefs } from "@/lib/prefs";
import { usePhaseView, useSmoothedLevel } from "@/lib/agentState";
import { useTranscript } from "@/lib/transcript";
import { LiveRegion } from "./LiveRegion";
import { ConnectScreen } from "./ConnectScreen";
import { AgentOrb } from "./AgentOrb";
import { Transcript } from "./Transcript";
import { VoicePanel } from "./VoicePanel";
import { ProductList } from "./ProductList";
import { CartPanel } from "./CartPanel";
import { CheckoutPanel } from "./CheckoutPanel";
import { AccessibilityControls } from "./AccessibilityControls";

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

/** Tool results worth hearing about, even though the transcript also has them. */
const ANNOUNCED_TOOLS = new Set(["addToCart", "removeFromCart", "applyCoupon", "checkout", "checkout_preview"]);

const EMPTY_CART: EchoState["cart"] = {
  isEmpty: true,
  lines: [],
  subtotal: 0,
  discountPercent: 0,
  discount: 0,
  total: 0,
  linesText: "",
  couponCode: null,
};

export function EchoApp() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [echoState, setEchoState] = useState<EchoState | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [lastUserText, setLastUserText] = useState("");
  const [fillerText, setFillerText] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [micUnsupported, setMicUnsupported] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [audioLevel, setAudioLevel] = useState<{ value: number; source: "in" | "out" } | null>(null);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);

  const prefs = usePrefs();
  const { reducedMotion } = prefs;
  const transcript = useTranscript();
  const demoRecordingHandle = useRef<RecordingHandle | null>(null);
  const voiceSession = useRef<VoiceAgentSession | null>(null);
  // The long-lived voice session closes over this once, so it must read the
  // latest state through a ref rather than a stale render closure.
  const stateRef = useRef<EchoState | null>(null);
  stateRef.current = echoState;

  const voiceAgent = caps?.voiceAgent ?? false;
  const effectiveBusy = voiceAgent
    ? agentStatus === "connecting" || agentStatus === "thinking"
    : busy;

  const phaseView = usePhaseView({
    connected,
    agentStatus,
    recording,
    busy: effectiveBusy,
    speaking,
    filler: Boolean(fillerText),
  });

  const levelForOrb = useSmoothedLevel(audioLevel?.value ?? 0, reducedMotion);
  // `null` means "no audio exists to react to" — the orb must not fake a meter.
  const orbLevel = speaking || recording ? levelForOrb : null;

  // The orb is sized from the box it actually sits in, not from the window.
  // Magnification shrinks that box, so measuring the window would let the orb
  // overflow at 200% zoom. `clientWidth` is a layout value in the element's own
  // coordinate space, which is the same space the canvas is sized in.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(768);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [connected]);

  useEffect(() => {
    const read = () => setViewportHeight(window.innerHeight);
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);

  // Results introduce themselves below the agent, which then steps back.
  const hasResults = (echoState?.recentProducts.length ?? 0) > 0;
  // Before the stage has been measured, fall back to a size that cannot overflow
  // on any real screen; the effect corrects it on the first frame.
  const available = stageWidth > 0 ? stageWidth : 320;
  const orbSize = hasResults
    ? Math.max(104, Math.min(168, available * 0.28))
    : Math.max(128, Math.min(340, available * 0.78, viewportHeight * 0.42));

  useEffect(() => {
    setMicUnsupported(typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia);
  }, []);

  // ---- boot: capabilities, session, state ----
  useEffect(() => {
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
        if (!cancelled) {
          stateRef.current = s;
          setEchoState(s);
          // A returning shopper who already has results goes straight to the
          // shopping view rather than the empty landing.
          if (s.recentProducts.length > 0) setConnected(true);
        }
      } catch {
        if (!cancelled)
          setNotice({
            text: "I couldn't reach the shopping service. Start the backend with npm run dev:backend, then reload this page.",
            tone: "error",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => voiceSession.current?.end(), []);

  const refreshState = useCallback(async () => {
    if (!sessionId) return;
    const s = await getState(sessionId).catch(() => null);
    if (s) {
      stateRef.current = s;
      setEchoState(s);
    }
  }, [sessionId]);

  /**
   * Highlight whichever product the agent is currently talking about. Matching
   * is done on the agent's own words, because that is the only signal available
   * without changing the agent or the backend: whichever product name it just
   * said is the one it is describing. An explicit tool result takes precedence,
   * since that is a direct statement of which product was acted on.
   */
  const spotlightFromText = useCallback((text: string): string | null => {
    const products = stateRef.current?.recentProducts ?? [];
    if (products.length === 0) return null;
    const said = text.toLowerCase();
    let best: { id: string; score: number } | null = null;
    for (const p of products) {
      const name = p.name.toLowerCase();
      if (!name || !said.includes(name)) continue;
      // Prefer the most specific (longest) name mentioned, so "Cotton Ankle
      // Socks" wins over a shorter product that happens to be a substring.
      if (!best || name.length > best.score) best = { id: p.id, score: name.length };
    }
    return best ? best.id : null;
  }, []);

  const focusSpotlight = useCallback(
    (name: string | undefined) => {
      if (!name) return;
      const needle = name.toLowerCase();
      const match = (stateRef.current?.recentProducts ?? []).find(
        (p) => p.name.toLowerCase() === needle
      );
      if (match) setSpotlightId(match.id);
    },
    []
  );

  const ensureVoice = useCallback(async (): Promise<VoiceAgentSession> => {
    const existing = voiceSession.current;
    if (existing && existing.isReady) return existing;
    if (existing) existing.end();
    if (!sessionId) throw new Error("no app session yet");

    const setup = await getVoiceSetup();
    const session = new VoiceAgentSession(
      setup,
      async (name, args) => callTool(name, args, sessionId),
      {
        onStatus: (status) => setAgentStatus(status),
        onUserTurnStart: () => transcript.sealOpen("user"),
        onUserTranscript: (text, final, mode) => {
          const clean = text.trim();
          if (!clean) return;
          if (final) {
            setLastUserText(clean);
            transcript.commit("user", clean);
          } else if (mode === "cumulative") {
            transcript.setPartial("user", clean);
          } else {
            transcript.appendPartial("user", clean);
          }
        },
        onAgentTranscript: (text, final, _interrupted, mode) => {
          const clean = text.trim();
          if (!clean) return;
          if (final) transcript.commit("agent", clean);
          else if (mode === "cumulative") transcript.setPartial("agent", clean);
          else transcript.appendPartial("agent", clean);
          // Track the product as it is being described, not only at the end, so
          // the card lights up while Echo is still talking about it.
          setSpotlightId(spotlightFromText(clean));
        },
        onToolCall: ({ name, result }) => {
          if (result.success && ANNOUNCED_TOOLS.has(name)) {
            // The server already words these for speech; reuse it verbatim
            // rather than inventing a second description of what happened.
            setAnnouncement(result.message ?? "Done.");
          }
          focusSpotlight(typeof result.data?.productName === "string" ? result.data.productName : undefined);
          void refreshState();
        },
        onReplyDone: ({ interrupted }) => {
          transcript.closeAgentReply(interrupted);
          if (interrupted) setAnnouncement("You interrupted Echo.");
          // The spotlight belongs to the utterance, so it clears when the
          // reply ends rather than leaving a stale card ringed forever.
          if (!interrupted) setSpotlightId(null);
        },
        onSpeakingChange: setSpeaking,
        onAudioLevel: (level, source) => {
          setAudioLevel(level > 0 ? { value: level, source } : null);
        },
        onError: (message) => setNotice({ text: `Voice agent: ${message}`, tone: "error" }),
      }
    );
    voiceSession.current = session;
    await session.connect();
    return session;
    // NOTE: `transcript` is a stable object of useCallback functions, and the
    // spotlight helpers read through refs, so this is created once per session.
  }, [sessionId, refreshState, transcript, focusSpotlight, spotlightFromText]);

  const playReply = useCallback((reply: string, audioUrl: string | null) => {
    const speakFallback = () => fallbackSpeak(reply, { rate: 1, pitch: 1 });
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.play().catch(speakFallback);
    } else {
      speakFallback();
    }
  }, []);

  const runTurn = useCallback(
    async (input: { text?: string; audioBase64?: string }) => {
      if (!sessionId || !caps) return;

      // ---- real mode: one AssemblyAI Voice Agent session ----
      if (caps.voiceAgent) {
        if (effectiveBusy) return;
        const text = input.text?.trim();
        if (!text) return;
        // A new turn supersedes whatever the last failure was warning about.
        setNotice(null);
        setLastUserText(text);
        try {
          setConnected(true);
          const session = await ensureVoice();
          await session.input(text);
        } catch (err) {
          setNotice({
            text: `I couldn't reach the voice agent — ${
              err instanceof Error ? err.message : "unknown error"
            }. Try again.`,
            tone: "error",
          });
        }
        return;
      }

      // ---- demo mode: text / recorded audio through the plain tool loop ----
      if (effectiveBusy) return;
      setNotice(null);
      setBusy(true);
      setFillerText("");
      try {
        const events = await postTurn({ sessionId, ...input });
        if (events.userText) {
          setLastUserText(events.userText);
          transcript.commit("user", events.userText);
        }
        if (events.filler) setFillerText(events.filler.text);
        if (events.reply) transcript.commit("agent", events.reply);
        if (events.state) {
          stateRef.current = events.state;
          setEchoState(events.state);
        }
        // The reply is NOT pushed to the live region here: the transcript already
        // announces the newest finished agent message, and two live regions
        // carrying the same sentence would read it out twice.
        if (events.reply) playReply(events.reply, events.audioUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setNotice({
          text: `I couldn't finish that — ${message}. Nothing was changed.`,
          tone: "error",
        });
      } finally {
        setBusy(false);
        setFillerText("");
      }
    },
    [sessionId, caps, effectiveBusy, ensureVoice, playReply, transcript]
  );

  /**
   * The primary action on the landing screen. In the live-agent configuration
   * this opens the voice session and starts the microphone. Without those keys
   * there is nothing to open, so it says so plainly rather than flipping the
   * interface into a "listening" state that is not actually capturing audio.
   */
  const handleConnect = useCallback(async () => {
    if (connected) return;
    setConnected(true);
    if (!voiceAgent) {
      setNotice({
        text: "There's no live voice agent configured, so nothing is listening yet. Use the microphone button to record a request, or type it below.",
        tone: "info",
      });
      return;
    }
    try {
      const session = await ensureVoice();
      await session.startMic();
      setRecording(true);
    } catch (err) {
      // Mic blocked or unavailable: the text box is the fallback, and the
      // interface must say so instead of appearing broken.
      setRecording(false);
      setNotice({
        text:
          err instanceof Error
            ? `I can't reach the microphone here — ${err.message}. Type your request instead.`
            : "I can't reach the microphone here. Type your request instead.",
        tone: "error",
      });
    }
  }, [connected, voiceAgent, ensureVoice]);

  const toggleMic = useCallback(async () => {
    if (effectiveBusy) return;
    if (recording) {
      setRecording(false);
      if (voiceAgent) {
        voiceSession.current?.stopMic();
      } else {
        const handle = demoRecordingHandle.current;
        demoRecordingHandle.current = null;
        const audioBase64 = await handle?.stop();
        if (audioBase64) await runTurn({ audioBase64 });
        else
          setNotice({
            text: "I didn't capture any audio. Try again, or type your request.",
            tone: "info",
          });
      }
      return;
    }
    try {
      if (voiceAgent) {
        const session = await ensureVoice();
        await session.startMic();
        setRecording(true);
      } else {
        demoRecordingHandle.current = await startRecording();
        setRecording(true);
      }
    } catch {
      setNotice({
        text: "I can't reach the microphone here — type your request instead, or allow mic access and reload.",
        tone: "error",
      });
    }
  }, [effectiveBusy, recording, voiceAgent, ensureVoice, runTurn]);

  const lastActionType =
    echoState?.lastAction && typeof echoState.lastAction === "object"
      ? (echoState.lastAction as { type?: string }).type
      : undefined;
  const awaitingCheckoutConfirmation = lastActionType === "checkout_preview";

  const statusLine = useMemo(() => {
    if (!caps) return "connecting…";
    return `${voiceAgent ? "Live voice agent" : `Speech ${caps.stt ? "ready" : "off"}`} · Database ${
      caps.db === "mongodb" ? "connected" : caps.db === "memory" ? "in memory" : caps.db
    } · ${caps.currency}`;
  }, [caps, voiceAgent]);

  const transcriptAnnouncement = useMemo(() => {
    const last = [...transcript.messages].reverse().find((m) => m.speaker === "agent" && !m.partial);
    return last ? last.text : "";
  }, [transcript.messages]);

  if (!connected) {
    return (
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to the voice controls
        </a>
        <header className="app__bar">
          <div className="brand">
            <p className="brand__mark">Echo</p>
            <p className="brand__meta">{statusLine}</p>
          </div>
        </header>

        <main id="main" className="app__content">
          <div className="zoom-region connect-region">
            <ConnectScreen
              busy={agentStatus === "connecting"}
              ready={caps !== null}
              voiceAgent={voiceAgent}
              micUnsupported={micUnsupported}
              onConnect={() => void handleConnect()}
            />
          </div>
        </main>

        <div className="app__foot">
          {notice ? (
            <p className={`notice${notice.tone === "error" ? " notice--error" : ""}`}>{notice.text}</p>
          ) : null}
          <AccessibilityControls prefs={prefs} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to the voice controls
      </a>

      <LiveRegion text={`${announcement}${notice ? ` ${notice.text}` : ""}`} label="Action result" busy={effectiveBusy} />

      <header className="app__bar">
        <div className="brand">
          <p className="brand__mark">Echo</p>
          <p className="brand__meta">{statusLine}</p>
        </div>
        <div className="cluster">
          {voiceAgent ? (
            <span className="badge badge--live">
              <span className="dot dot--pulse" aria-hidden="true" />
              Live
            </span>
          ) : null}
          <AccessibilityControls prefs={prefs} compact />
        </div>
      </header>

      <main id="main" className="app__content">
        <div className="app__inner zoom-region">
          {/* The agent is the dominant element at first, and eases back as
              results arrive. The same node animates between the two sizes so the
              transition is continuous rather than a swap. */}
          <motion.section
            className="agent"
            aria-labelledby="agent-heading"
            layout={!reducedMotion}
            transition={{ duration: reducedMotion ? 0 : 0.55, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <h2 id="agent-heading" className="sr-only">
              Voice agent
            </h2>

            <div className="agent__stage" ref={stageRef}>
              <AgentOrb
                phase={phaseView.phase}
                level={orbLevel}
                reducedMotion={reducedMotion}
                size={orbSize}
                className="agent__orb"
              />
            </div>

            <div className="agent__state">
              {/* The single authoritative statement of what the agent is doing.
                  It is the one place the phase is announced, so a screen reader
                  hears each state exactly once, and it is real text rather than
                  anything the orb conveys. */}
              <p
                className="agent__label"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-phase={phaseView.phase}
              >
                {phaseView.label}
              </p>
              <p className="agent__detail">{phaseView.detail}</p>
            </div>
          </motion.section>

          <div className="grid-2">
            <div className="stack">
              <Transcript
                messages={transcript.messages}
                reducedMotion={reducedMotion}
                announcement={transcriptAnnouncement}
              />
              <VoicePanel
                sttAvailable={caps?.stt ?? false}
                ttsAvailable={caps?.tts ?? false}
                voiceAgent={voiceAgent}
                busy={effectiveBusy}
                recording={recording}
                onMicToggle={() => void toggleMic()}
                onSubmitText={(text) => void runTurn({ text })}
                lastUserText={lastUserText}
              />
            </div>

            <CartPanel
              cart={echoState?.cart ?? EMPTY_CART}
              currency={caps?.currency ?? "₹"}
              busy={effectiveBusy}
              reducedMotion={reducedMotion}
              onRemove={(name) => void runTurn({ text: `remove the ${name} from my cart` })}
              onApplyCoupon={(code) => void runTurn({ text: `apply ${code}` })}
              onCheckout={() => void runTurn({ text: "check out" })}
            />
          </div>

          {/* Failures and guidance must be visible, not only announced: the
              live region is invisible by design, so anything that needs the user
              to act on it also gets a real, dismissible-free banner. The banner
              is not itself a live region, because the announcement above already
              read it out — two live regions would say it twice. */}
          {notice ? (
            <p
              className={`notice${notice.tone === "error" ? " notice--error" : ""}`}
              data-tone={notice.tone}
            >
              {notice.text}
            </p>
          ) : null}

          <AnimatePresence>
            {awaitingCheckoutConfirmation ? (
              <motion.div
                className="panel checkout-confirm"
                role="group"
                aria-label="Confirm checkout"
                initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={{ duration: reducedMotion ? 0 : 0.3 }}
              >
                <p style={{ marginTop: 0 }}>
                  Echo previewed your order. Nothing is placed until you confirm.
                </p>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={effectiveBusy}
                  onClick={() => void runTurn({ text: "yes, place the order" })}
                >
                  Yes, place the order
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {echoState?.lastOrder ? (
            <CheckoutPanel
              order={echoState.lastOrder}
              currency={caps?.currency ?? "₹"}
              reducedMotion={reducedMotion}
            />
          ) : null}

          <ProductList
            products={echoState?.recentProducts ?? []}
            currency={caps?.currency ?? "₹"}
            busy={effectiveBusy}
            reducedMotion={reducedMotion}
            spotlightId={spotlightId}
            onAdd={(optionIndex) =>
              void runTurn({ text: `add the ${ORDINALS[optionIndex] ?? `option ${optionIndex + 1}`} one to my cart` })
            }
          />
        </div>
      </main>

      <footer className="app__foot">
        <p style={{ margin: 0 }}>
          {reducedMotion ? "Reduced motion is on. " : ""}
          Every action runs through the app&apos;s own tool gateway first — Echo only ever speaks
          what the server confirmed.
        </p>
      </footer>
    </div>
  );
}
