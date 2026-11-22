import { useEffect, useRef } from 'react';
import { sectionLabel, type QueuedTake } from '../lib/handoff';
import { formatDuration } from '../lib/format';

/** The panel's rows whose delete is in flight, and whether a clear is. */
export interface QueueBusy {
  discards: string[];
  clearing: boolean;
}

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
  busy,
  onDiscard,
  onClear,
  onOpen,
  onClose,
}: {
  label: string;
  takes: QueuedTake[];
  /** Why a take that should have gone is still listed. */
  note?: string | null;
  /**
   * A store can take seconds to answer a delete, so the row or the button says
   * it is working rather than leaving the press looking as though it went
   * nowhere.
   */
  busy: QueueBusy;
  onDiscard: (key: string) => void;
  onClear: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  // The row a removal was asked for, held until the list actually changes, so a
  // delete the store refuses neither moves focus nor banks the request.
  const removal = useRef<{ key: string | null; index: number; count: number } | null>(null);
  const keys = takes.map((take) => take.key).join('|');
  const empty = takes.length === 0;
  // What the panel is in the middle of. Said in the standing region below rather
  // than left to the button's own name: a name that changes under the focus the
  // press put there is not reliably read out again.
  const discarding = takes.filter((take) => busy.discards.includes(take.key));
  const working = [
    discarding.length === 0
      ? ''
      : discarding.length === 1
        ? `Discarding “${discarding[0].name}”`
        : `Discarding ${discarding.length} takes`,
    busy.clearing ? `Clearing ${takes.length === 1 ? '1 take' : `${takes.length} takes`}` : '',
  ]
    .filter(Boolean)
    .join('. ');

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
    if (!asked) return;
    removal.current = null;

    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-discard]') ?? [])];
    // The store would not let the row go: it is still listed, so nothing was
    // lost to focus, and the request is spent rather than left waiting to pull
    // focus back to that row the next time the queue changes for any reason.
    if (asked.key !== null && rows.some((row) => row.dataset.discard === asked.key)) return;
    // The same for a clear the store refused outright.
    if (asked.key === null && rows.length >= asked.count) return;

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
            {/* What cannot be read off a button: work that is under way while
                its button's name changes under the focus the press left there,
                and the empty result once there are no rows to land on. One
                standing region carries both, present from the first render, so
                a change is spoken however focus got where it is. The count sits
                outside it and is still there to be read. */}
            <small className="muted">
              <span>
                {empty
                  ? ''
                  : takes.length === 1
                    ? '1 take queued'
                    : `${takes.length} takes queued`}
              </span>
              <span role="status" aria-atomic="true">
                {working ? `${working}.` : empty ? 'Nothing queued now.' : ''}
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
          {takes.map((take, index) => {
            const discarding = busy.discards.includes(take.key);

            return (
              <li key={take.key}>
                <div className="queue-take">
                  <strong>{take.name}</strong>
                  <small>
                    {take.from ? `from ${sectionLabel(take.from)}` : 'queued'}
                    {take.duration ? ` · ${formatDuration(take.duration)}` : ''}
                  </small>
                </div>
                {/* Left pressable while it waits: disabling the button the press
                    is on would drop focus out of the panel. */}
                <button
                  className="btn ghost small"
                  data-discard={take.key}
                  aria-label={discarding ? `Discarding ${take.name}` : `Discard ${take.name}`}
                  onClick={() => {
                    removal.current = { key: take.key, index, count: takes.length };
                    onDiscard(take.key);
                  }}
                >
                  {discarding ? 'Discarding…' : 'Discard'}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="queue-actions">
          <button className="btn ghost small" onClick={onOpen}>
            Open {label}
          </button>
          {takes.length > 0 && (
            <button
              className="btn ghost small danger"
              onClick={() => {
                removal.current = { key: null, index: 0, count: takes.length };
                onClear();
              }}
            >
              {busy.clearing ? 'Clearing…' : `Clear all ${takes.length}`}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
