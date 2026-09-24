interface LiveRegionProps {
  text?: string;
  label?: string;
}

/**
 * Accessible announcer for everything the assistant says, so screen readers
 * narrate status even when no audio is playing. `aria-busy` conveys streaming.
 */
export function LiveRegion({ text, label = "Assistant status" }: LiveRegionProps) {
  return (
    <section aria-label={label} className="live-region">
      <p aria-live="polite" aria-atomic="true" role="status" className="sr-status">
        {text && text.trim().length > 0 ? text : "Idle."}
      </p>
    </section>
  );
}