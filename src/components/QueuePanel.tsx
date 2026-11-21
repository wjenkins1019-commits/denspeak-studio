import { useEffect, useRef } from 'react';
import { sectionLabel, type QueuedTake } from '../lib/handoff';
import { formatDuration } from '../lib/format';

/**
 * The takes waiting for one section, shown from its rail count. Naming each
 * take before anything is thrown away is the point: "Clear all" is only offered
 * after the list it would empty is on screen.
 *
 * Discarding is always a click here, never automatic — a queued take otherwise
 * waits until it is taken or expires.
 */
export function QueuePanel({
  label,
  takes,
  note,
  onDiscard,
  onClear,
  onOpen,
  onClose,
}: {
  label: string;
  takes: QueuedTake[];
  /** Why a take that should have gone is still listed. */
  note?: string | null;
  onDiscard: (key: string) => void;
  onClear: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    heading.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Keep focus in the panel while it is up; the rail and page behind it
      // are not reachable until it closes.
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input, select, textarea',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="queue-scrim" onMouseDown={onClose}>
      <section
        ref={panel}
        className="queue-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-panel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="queue-head">
          <div>
            <span className="eyebrow">Hand-off queue</span>
            <h2 id="queue-panel-title" ref={heading} tabIndex={-1}>
              Waiting for {label}
            </h2>
            <small className="muted">
              {takes.length === 0
                ? 'Nothing queued now.'
                : takes.length === 1
                  ? '1 take queued'
                  : `${takes.length} takes queued`}
            </small>
          </div>
          <button className="btn ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        {note && (
          <p className="muted" role="status">
            {note}
          </p>
        )}

        <ul className="queue-list">
          {takes.map((take) => (
            <li key={take.key}>
              <div className="queue-take">
                <strong>{take.name}</strong>
                <small>
                  {take.from ? `from ${sectionLabel(take.from)}` : 'queued'}
                  {take.duration ? ` · ${formatDuration(take.duration)}` : ''}
                </small>
              </div>
              <button
                className="btn ghost small"
                aria-label={`Discard ${take.name}`}
                onClick={() => onDiscard(take.key)}
              >
                Discard
              </button>
            </li>
          ))}
        </ul>

        <div className="queue-actions">
          <button className="btn ghost small" onClick={onOpen}>
            Open {label}
          </button>
          {takes.length > 0 && (
            <button className="btn ghost small danger" onClick={onClear}>
              Clear all {takes.length}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
