import { useEffect, useRef, useState } from 'react';
import {
  hydrateHandoff,
  pendingCount,
  pendingCounts,
  subscribeHandoff,
  subscribeQueues,
  takeHandoff,
  type HandoffItem,
  type HandoffTarget,
} from './handoff';

/**
 * Focus the section's heading when a hand-off lands in it, so the view that
 * swapped in under the user announces itself instead of leaving them with
 * nothing focused.
 *
 * Focus is only taken when nothing already has it: a take that arrives while
 * the section is open, or one stepped to from the notice, must not pull the
 * caret out of what the user is doing.
 */
export function useHandoffFocus(arrival: unknown) {
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!arrival) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    heading.current?.focus();
  }, [arrival]);

  return heading;
}

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

  // Whether this visit has asked for its take. StrictMode mounts the view,
  // cleans up and mounts it again in development; a second subscription that
  // asked again would drain the next take and replace the arrival, losing one
  // without a word.
  const asked = useRef(false);

  /** Land `item`, then take stock of what is still queued behind it. */
  function deliver(item: HandoffItem) {
    const before = latest.current.current;
    latest.current.apply(item);
    setArrival({ item, before });
    setWaiting(pendingCount(target));
  }

  useEffect(() => {
    const take = !asked.current;
    asked.current = true;
    return subscribeHandoff(target, deliver, { take });
  }, [target]);

  // A queued take can be discarded from the rail while this section is open;
  // keep "N more waiting" honest rather than leaving a count for audio that is
  // already gone.
  useEffect(() => subscribeQueues(() => setWaiting(pendingCount(target))), [target]);

  return {
    arrival,
    /** How many takes are still waiting behind the one on screen. */
    waiting,
    /** Take the next queued take without leaving the section. */
    next: () => {
      void takeHandoff(target).then((item) => {
        if (item) deliver(item);
        else setWaiting(pendingCount(target));
      });
    },
    /** Put back what the section had before the arrival, and close the notice. */
    keep: () => {
      if (arrival && arrival.before !== null) latest.current.restore(arrival.before);
      setArrival(null);
    },
  };
}

/**
 * What is queued for every section, for the rail: a take waiting in a section
 * nobody has opened can be seen without opening it. Takes an earlier run left
 * on disk are counted from the start rather than on that section's first visit.
 */
export function usePendingCounts(): Partial<Record<HandoffTarget, number>> {
  const [counts, setCounts] = useState<Partial<Record<HandoffTarget, number>>>({});

  useEffect(() => {
    let alive = true;
    const sync = () => {
      if (alive) setCounts(pendingCounts());
    };

    const stop = subscribeQueues(sync);
    sync();
    void hydrateHandoff().then(sync);

    return () => {
      alive = false;
      stop();
    };
  }, []);

  return counts;
}
