import { HANDOFF_TARGETS, sendTake, type HandoffItem } from '../lib/handoff';

/**
 * "Send this take to" strip under a finished result: hands the audio to
 * Convert, Transcribe, Shape or Song without an export/import round-trip.
 * The section you are already in is offered too — the store delivers there
 * directly instead of queueing for a remount.
 */
export function SendTakeRow({
  name,
  blob,
  duration,
  captions,
}: Omit<HandoffItem, 'name' | 'blob'> & { name: string; blob: Blob }) {
  return (
    <div className="row between">
      <small className="muted">Send this take to</small>
      <div className="row">
        {HANDOFF_TARGETS.map((entry) => (
          <button
            key={entry.target}
            className="btn ghost small"
            onClick={() => sendTake(entry.target, { name, blob, duration, captions })}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
