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
  const list = useRef<HTMLUListElement | null>(null);
  // The row index that had focus when a removal was asked for, with the queue as
  // it was then, so focus only moves if the list actually changed.
  const removal = useRef<{ index: number; keys: string } | null>(null);
  const keys = takes.map((take) => take.key).join('|');
  const empty = takes.length === 0;

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

  // A row's Discard button leaves with its row, and a clear takes every row at
  // once, so focus would otherwise fall back to the page behind the dialog. It
  // goes to the take that took the row's place, else the last take left, and
  // with the queue empty to the heading: that reads the section the panel is
  // for and sits above the line saying nothing is queued now.
  useEffect(() => {
    const asked = removal.current;
    // The store would not let the row go, so the list still reads the same: no
    // focus was lost, and it must not be pulled away from wherever the reader
    // has moved on to since.
    if (!asked || asked.keys === keys) return;
    removal.current = null;

    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-discard]') ?? [])];
    const next = rows[Math.min(asked.index, rows.length - 1)];
    (next ?? heading.current)?.focus();
  }, [keys]);

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
            {/* What a discard or a clear can leave unsaid: once no rows are left
                there is no button to land on and no row name to read. The
                region stands here from the first render and only the empty
                result fills it, so the count is not read out after every
                discard on top of the row that just took the focus. The count
                sits outside the region and is still there to be read. */}
            <small className="muted">
              <span>
                {empty
                  ? ''
                  : takes.length === 1
                    ? '1 take queued'
                    : `${takes.length} takes queued`}
              </span>
              <span role="status" aria-atomic="true">
                {empty ? 'Nothing queued now.' : ''}
              </span>
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

        <ul className="queue-list" ref={list}>
          {takes.map((take, index) => (
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
                data-discard
                aria-label={`Discard ${take.name}`}
                onClick={() => {
                  removal.current = { index, keys };
                  onDiscard(take.key);
                }}
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
            <button
              className="btn ghost small danger"
              onClick={() => {
                removal.current = { index: 0, keys };
                onClear();
              }}
            >
              Clear all {takes.length}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
