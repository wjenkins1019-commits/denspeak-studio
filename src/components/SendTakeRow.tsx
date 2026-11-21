import { HANDOFF_TARGETS, sendTake } from '../lib/handoff';

/**
 * "Send this take to" strip under a finished result: hands the audio to
 * Convert, Transcribe, Shape or Song without an export/import round-trip.
 */
export function SendTakeRow({ name, blob }: { name: string; blob: Blob }) {
  return (
    <div className="row between">
      <small className="muted">Send this take to</small>
      <div className="row">
        {HANDOFF_TARGETS.map((entry) => (
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
