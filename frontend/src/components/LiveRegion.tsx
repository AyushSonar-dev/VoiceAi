interface LiveRegionProps {
  /** The single most important thing to hear right now. */
  text?: string;
  label?: string;
  /** true while a turn is in flight, so "checking…" is not read as an answer */
  busy?: boolean;
}

/**
 * Screen-reader announcer for action outcomes: a product added, a coupon
 * applied, a checkout confirmed. Deliberately separate from the transcript,
 * which has its own polite log, so a short confirmation never interleaves with
 * the conversation being read aloud.
 *
 * The text is always derived from what the server actually confirmed.
 */
export function LiveRegion({ text, label = "Action result", busy = false }: LiveRegionProps) {
  const value = text && text.trim().length > 0 ? text : "";
  return (
    <section aria-label={label} className="sr-only">
      <p aria-live="polite" aria-atomic="true" role="status" aria-busy={busy}>
        {value}
      </p>
    </section>
  );
}
