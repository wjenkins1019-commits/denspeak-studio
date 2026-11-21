import { useEffect, useRef, useState } from 'react';
import {
  pendingCount,
  subscribeHandoff,
  takeHandoff,
  type HandoffItem,
  type HandoffTarget,
} from './handoff';

export interface HandoffArrival<S> {
  item: HandoffItem;
  /** What the section held when the item landed; null when it held nothing. */
  before: S | null;
}

/**
 * Take a hand-off for `target` — one queued before the section opened, or one
 * sent while it is open. `current` is what the section holds right now, kept so
 * the arrival can say what it replaced and hand that back.
 *
 * A section is handed one take per visit, so `waiting` reports how many are
 * still queued behind it and `next` takes them without leaving the section.
 */
export function useHandoffTake<S>(
  target: HandoffTarget,
  current: S | null,
  apply: (item: HandoffItem) => void,
  restore: (before: S) => void,
) {
  const [arrival, setArrival] = useState<HandoffArrival<S> | null>(null);
  const [waiting, setWaiting] = useState(0);

  // Subscribed once; the view's latest values are read through the ref, so a
  // new callback identity does not re-subscribe and double-take.
  const latest = useRef({ current, apply, restore });
  latest.current = { current, apply, restore };

  /** Land `item`, then take stock of what is still queued behind it. */
  function deliver(item: HandoffItem) {
    const before = latest.current.current;
    latest.current.apply(item);
    setArrival({ item, before });
    setWaiting(pendingCount(target));
  }

  useEffect(() => subscribeHandoff(target, deliver), [target]);

  return {
    arrival,
    /** How many takes are still waiting behind the one on screen. */
    waiting,
    /** Take the next queued take without leaving the section. */
    next: () => {
      const item = takeHandoff(target);
      if (item) deliver(item);
      else setWaiting(0);
    },
    /** Put back what the section had before the arrival, and close the notice. */
    keep: () => {
      if (arrival && arrival.before !== null) latest.current.restore(arrival.before);
      setArrival(null);
    },
  };
}
