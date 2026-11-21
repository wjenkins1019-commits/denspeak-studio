import { HANDOFF_TARGETS, sendTake, type HandoffItem, type HandoffSource } from '../lib/handoff';

/**
 * "Send this take to" strip under a finished result: hands the audio to
 * Convert, Transcribe, Shape or Song without an export/import round-trip.
 * The section you are already in is left out: sending a take to where it
 * already is only reloads it behind a notice announcing an arrival from
 * somewhere else. `from` is this section, and names the one to drop.
 */
export function SendTakeRow({ name, blob, duration, captions, from }: HandoffItem & { from: HandoffSource }) {
  return (
    <div className="row between">
      <small className="muted">Send this take to</small>
      <div className="row">
        {HANDOFF_TARGETS.filter((entry) => entry.target !== from).map((entry) => (
          <button
            key={entry.target}
            className="btn ghost small"
            onClick={() => sendTake(entry.target, { name, blob, duration, captions, from })}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
