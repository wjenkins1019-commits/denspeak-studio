import { openSection, sectionLabel, type HandoffItem, type HandoffTarget } from '../lib/handoff';

/**
 * Reports a take that arrived from another section. When it landed on top of a
 * take that was already there, the button puts that one back. `here` is the
 * section showing the notice, so a take sent to its own section — where there is
 * nowhere to go back to — offers no way back.
 */
export function HandoffNotice({
  item,
  here,
  replaced,
  onKeep,
}: {
  item: HandoffItem;
  here: HandoffTarget;
  replaced: boolean;
  onKeep: () => void;
}) {
  const back = item.from && item.from !== here ? item.from : null;

  return (
    <div className="row between">
      <small className="muted">
        Arrived from another section: {item.name}
        {replaced ? ' — it replaced the take you had.' : ''}
      </small>
      <div className="row">
        {back && (
          <button className="btn ghost small" onClick={() => openSection(back)}>
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
