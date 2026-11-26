import { currentSection, returnTake, sectionLabel, type HandoffItem } from '../lib/handoff';
import type { HandoffTake } from '../lib/useHandoffTake';

/**
 * Everything a receiving section says about its take and its queue, in one
 * place so the order is decided once: the notice for the take on screen, then a
 * take that would not open, then — only when neither is talking — what is still
 * waiting. A failed next take therefore sits under the notice instead of taking
 * away the way back to the take on screen.
 *
 * Both live regions are on screen from the section's first render and only
 * their contents change with it: a status region added to the page already
 * holding its news is not reliably announced, while filling one that is already
 * there is.
 */
export function HandoffStatus<S>({ handoff }: { handoff: HandoffTake<S> }) {
  return (
    <>
      <div role="status" aria-atomic="true">
        {handoff.arrival && (
          <HandoffNotice
            item={handoff.arrival.item}
            replaced={handoff.arrival.before !== null}
            waiting={handoff.waiting}
            onNext={handoff.next}
            onKeep={handoff.keep}
          />
        )}
      </div>

      <div role="status" aria-atomic="true">
        {handoff.failed && <HandoffFailed onRetry={handoff.retry} attempts={handoff.failedAttempts} />}
      </div>

      {!handoff.arrival && !handoff.failed && (
        <WaitingTakes waiting={handoff.waiting} onNext={handoff.next} />
      )}
    </>
  );
}

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
    // No live-region role of its own: it is placed inside the section's standing
    // status region, so filling that region is what gets read aloud.
    <div className="row between">
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

/**
 * A take that is still queued but could not be opened: its stored row would not
 * delete, and showing it anyway would bring it back on the next run. Saying so,
 * with another try, beats an empty section that looks like a lost take.
 */
export function HandoffFailed({ onRetry, attempts }: { onRetry: () => void; attempts?: number }) {
  const tries = typeof attempts === 'number' && attempts > 1 ? ` (${attempts} tries)` : '';
  return (
    // No live-region role of its own: it is placed inside the section's standing
    // status region, so filling that region is what gets read aloud.
    <div className="row between">
      <small className="muted">
        Couldn’t open your take — its saved copy wouldn’t clear, so it is still waiting{tries}.
      </small>
      <button className="btn ghost small" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
