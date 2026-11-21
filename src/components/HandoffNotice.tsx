import { currentSection, returnTake, sectionLabel, type HandoffItem } from '../lib/handoff';

/**
 * Reports a take that arrived from another section. When it landed on top of a
 * take that was already there, the button puts that one back; the notice also
 * offers the way back to where the take came from, and carries the take with it
 * so that section is not empty on return.
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
  onKeep,
}: {
  item: HandoffItem;
  replaced: boolean;
  onKeep: () => void;
}) {
  const here = currentSection();
  const returning = item.returned === true;
  const back = here && item.from && item.from !== here ? item.from : null;

  return (
    <div className="row between">
      <small className="muted">
        {returning ? 'Your take is back:' : 'Arrived from another section:'} {item.name}
        {replaced ? ' — it replaced the take you had.' : ''}
      </small>
      <div className="row">
        {back && (
          <button className="btn ghost small" onClick={() => returnTake(back, item)}>
            Back to {sectionLabel(back)}
          </button>
        )}
        <button className="btn ghost small" onClick={onKeep}>
          {replaced ? 'Keep the previous take' : 'Got it'}
        </button>
      </div>
    </div>
  );
}
