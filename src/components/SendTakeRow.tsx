import { HANDOFF_TARGETS, sendTake } from '../lib/handoff';

/** The section on screen, from the hash route ('' outside the browser or on an unlisted route). */
function currentSection(): string {
  return typeof window === 'undefined' ? '' : window.location.hash.replace(/^#\/?/, '');
}

/**
 * "Send this take to" strip under a finished result: hands the audio to
 * Convert, Transcribe, Shape or Song without an export/import round-trip.
 */
export function SendTakeRow({ name, blob }: { name: string; blob: Blob }) {
  // The section you are already in is left out: sending there sets a hash that
  // is already set, so nothing remounts to take the item and it would sit until
  // the next visit, silently replacing that section's source.
  const here = currentSection();

  return (
    <div className="row between">
      <small className="muted">Send this take to</small>
      <div className="row">
        {HANDOFF_TARGETS.filter((entry) => entry.target !== here).map((entry) => (
          <button
            key={entry.target}
            className="btn ghost small"
            onClick={() => sendTake(entry.target, { name, blob })}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
