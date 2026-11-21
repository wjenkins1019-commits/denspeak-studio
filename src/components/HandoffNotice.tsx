import type { HandoffItem } from '../lib/handoff';

/**
 * Reports a take that arrived from another section. When it landed on top of a
 * take that was already there, the button puts that one back.
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
  return (
    <div className="row between">
      <small className="muted">
        Arrived from another section: {item.name}
        {replaced ? ' — it replaced the take you had.' : ''}
      </small>
      <button className="btn ghost small" onClick={onKeep}>
        {replaced ? 'Keep the previous take' : 'Got it'}
      </button>
    </div>
  );
}
