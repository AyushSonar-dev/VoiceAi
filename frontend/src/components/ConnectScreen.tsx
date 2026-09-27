"use client";

interface Props {
  /** blocks double submits and reflects the connect attempt */
  busy: boolean;
  /** capabilities have not loaded yet, so nothing may be claimed about them */
  ready: boolean;
  /** the real AssemblyAI voice agent is configured */
  voiceAgent: boolean;
  /** this browser cannot capture audio, so the text box is the only route */
  micUnsupported: boolean;
  onConnect: () => void;
}

/**
 * The first screen. One job: make it unmistakable that starting the
 * conversation is the primary action, and that everything else is secondary.
 */
export function ConnectScreen({ busy, ready, voiceAgent, micUnsupported, onConnect }: Props) {
  const label = busy ? "Connecting…" : "Connect agent";

  return (
    <section className="connect" aria-labelledby="connect-title">
      <p className="section-title">Echo</p>

      <h1 id="connect-title" className="connect__title">
        Shop by talking.
      </h1>

      <p className="connect__lede">
        Tell Echo what you&apos;re looking for in your own words. It searches the catalog, reads
        product details back to you, and handles your cart.
      </p>

      <div className="connect__action">
        <button
          type="button"
          className="connect__button"
          onClick={onConnect}
          disabled={busy}
          aria-label={
            busy
              ? "Connecting to the voice agent"
              : "Connect agent and start shopping by voice"
          }
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
            <path
              d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <span>{label}</span>
        </button>
      </div>

      <p className="connect__hint">
        {busy
          ? "Opening a private voice connection…"
          : micUnsupported
            ? "Your browser can't capture audio, so Echo will listen through the text box after connecting."
            : "Echo will ask for microphone access so it can hear you. You can type instead at any time."}
      </p>

      {/* Nothing about the service is claimed until capabilities have actually
          loaded, so the page never briefly asserts "demo mode" and then
          contradicts itself. */}
      <p className="connect__note">
        {!ready
          ? "Checking which services are available…"
          : voiceAgent
            ? "Voice is handled by a live speech agent. Product details always come from this app's own server."
            : "Running in demo mode: speech-to-text and text-to-speech keys are not configured, so you can type what you would say."}
      </p>
    </section>
  );
}
