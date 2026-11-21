import { currentSection, returnTake, sectionLabel, type HandoffItem } from '../lib/handoff';

/**
 * Reports a take that arrived from another section. When it landed on top of a
 * take that was already there, the button puts that one back; the notice also
 * offers the way back to where the take came from, and carries the take with it
 * so that section is not empty on return.
 *
 * A section is handed one take per visit, so a queue behind the one on screen is
 * reported as "N more waiting" and "Next take" moves through it without leaving
 * the section.
 *
 * A take sent back arrives marked as returned, so the section that gets it back
 * reads a confirmation that the take is home rather than an arrival from
 * elsewhere — the forward hand-off keeps its own wording.
 *
 * Where the notice is comes from the route, not from a prop: a section that
 * misnamed itself would otherwise offer a "Back" button pointing at itself.
 */
export function HandoffNotice({
  item,
  replaced,
  waiting = 0,
  onNext,
  onKeep,
}: {
  item: HandoffItem;
  replaced: boolean;
  /** Takes still queued behind this one for the section showing it. */
  waiting?: number;
  onNext?: () => void;
  onKeep: () => void;
}) {
  const here = currentSection();
  const returning = item.returned === true;
  const back = here && item.from && item.from !== here ? item.from : null;
  const notes = [
    replaced ? 'it replaced the take you had' : '',
    waiting > 0 ? `${waiting} more waiting` : '',
  ].filter(Boolean);

  return (
    // A status message: the arrival is news, and nothing else on screen may
    // have moved focus to it.
    <div className="row between" role="status" aria-atomic="true">
      <small className="muted">
        {returning ? 'Your take is back:' : 'Arrived from another section:'} {item.name}
        {notes.length > 0 ? ` — ${notes.join(' · ')}` : ''}
      </small>
      <div className="row">
        {back && (
          <button className="btn ghost small" onClick={() => returnTake(back, item)}>
            Back to {sectionLabel(back)}
          </button>
        )}
        {waiting > 0 && onNext && (
          <button className="btn ghost small" onClick={onNext}>
            Next take
          </button>
        )}
        <button className="btn ghost small" onClick={onKeep}>
          {replaced ? 'Keep the previous take' : 'Got it'}
        </button>
      </div>
    </div>
  );
}

/**
 * What is left of a queue once the arrival notice is dismissed. Dismissing a
 * take says "this one is welcome", not "forget the rest", so the count and the
 * step to the next take stay on screen while anything is still waiting.
 */
export function WaitingTakes({ waiting, onNext }: { waiting: number; onNext: () => void }) {
  if (waiting <= 0) return null;

  return (
    <div className="row between">
      <small className="muted">{waiting} more waiting</small>
      <button className="btn ghost small" onClick={onNext}>
        Next take
      </button>
    </div>
  );
}
