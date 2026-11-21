import { useEffect, useRef, useState } from 'react';
import { subscribeHandoff, type HandoffItem, type HandoffTarget } from './handoff';

export interface HandoffArrival<S> {
  item: HandoffItem;
  /** What the section held when the item landed; null when it held nothing. */
  before: S | null;
}

/**
 * Take a hand-off for `target` — one queued before the section opened, or one
 * sent while it is open. `current` is what the section holds right now, kept so
 * the arrival can say what it replaced and hand that back.
 */
export function useHandoffTake<S>(
  target: HandoffTarget,
  current: S | null,
  apply: (item: HandoffItem) => void,
  restore: (before: S) => void,
) {
  const [arrival, setArrival] = useState<HandoffArrival<S> | null>(null);

  // Subscribed once; the view's latest values are read through the ref, so a
  // new callback identity does not re-subscribe and double-take.
  const latest = useRef({ current, apply, restore });
  latest.current = { current, apply, restore };

  useEffect(
    () =>
      subscribeHandoff(target, (item) => {
        const before = latest.current.current;
        latest.current.apply(item);
        setArrival({ item, before });
      }),
    [target],
  );

  return {
    arrival,
    /** Put back what the section had before the arrival, and close the notice. */
    keep: () => {
      if (arrival && arrival.before !== null) latest.current.restore(arrival.before);
      setArrival(null);
    },
  };
}
