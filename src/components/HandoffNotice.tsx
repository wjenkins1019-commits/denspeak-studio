import { currentSection, returnTake, sectionLabel, type HandoffItem } from '../lib/handoff';

/**
 * Reports a take that arrived from another section. When it landed on top of a
 * take that was already there, the button puts that one back; the notice also
 * offers the way back to where the take came from, and carries the take with it
 * so that section is not empty on return.
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
  const back = here && item.from && item.from !== here ? item.from : null;

  return (
    <div className="row between">
      <small className="muted">
        Arrived from another section: {item.name}
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
