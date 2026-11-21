// Passing a finished take to another section without exporting a WAV and
// uploading it again. Queued takes are module state, which outlives the view
// that created them: navigating swaps the view, not the page. They are also
// written to a store, so a reload does not take the audio with it.

import { indexedDbHandoffStore, type HandoffStore } from './handoffStore';

export type HandoffTarget = 'studio' | 'convert' | 'transcribe' | 'process' | 'song';

/** Any section that can send a take, including Library, which only ever sends. */
export type HandoffSource = HandoffTarget | 'library';

/** What each section is called in the UI, e.g. 'Shape' for `process`. */
const SECTION_LABELS: Record<HandoffSource, string> = {
  studio: 'Studio',
  convert: 'Convert',
  transcribe: 'Transcribe',
  process: 'Shape',
  song: 'Song',
  library: 'Library',
};

/** Label for a section in prose, as in "Back to Convert". */
export function sectionLabel(section: HandoffSource): string {
  return SECTION_LABELS[section];
}

/**
 * The section the app is showing, read off the route rather than passed in, so
 * nothing can claim to be somewhere it is not. Null when the route names
 * something that is not a hand-off section.
 */
export function currentSection(): HandoffSource | null {
  if (typeof window === 'undefined') return null;

  const section = window.location.hash.replace(/^#\/?/, '');
  return Object.prototype.hasOwnProperty.call(SECTION_LABELS, section)
    ? (section as HandoffSource)
    : null;
}

export interface HandoffItem {
  /** Take name without an extension; the receiving section adds its own. */
  name: string;
  blob: Blob;
  /**
   * Length in seconds when the sender knows it, so a receiver can fill in its
   * own duration instead of decoding the audio again to measure it.
   */
  duration?: number;
  /**
   * Timed captions when the sender has them. A receiver whose output keeps the
   * words (Convert, Shape) passes them on again rather than losing them.
   */
  captions?: { srt: string; vtt: string };
  /**
   * The section that sent it. A hand-off replaces the history entry the user
   * would have used to go back, so the receiver offers that way back itself.
   */
  from?: HandoffSource;
  /**
   * Set when a section sent this take back to its sender rather than passing it
   * on, so the receiving notice can confirm the take is home instead of
   * announcing an arrival from somewhere else.
   */
  returned?: true;
}

/** Sections a take can be sent to, with the label their button shows. */
export const HANDOFF_TARGETS: Array<{ target: HandoffTarget; label: string }> = [
  { target: 'studio', label: 'Studio' },
  { target: 'convert', label: 'Convert' },
  { target: 'transcribe', label: 'Transcribe' },
  { target: 'process', label: 'Shape' },
  { target: 'song', label: 'Beat' },
];

type Listener = (item: HandoffItem) => void;

interface Pending {
  item: HandoffItem;
  /** Row in the durable store, so taking the take deletes it there too. */
  key: string;
}

/**
 * Takes waiting for each section, oldest first. There is a queue per section
 * rather than one slot for the whole app: a send to a second section used to
 * overwrite the take still waiting for the first, dropping its audio with no
 * undo. Nothing is discarded now — a take nobody has taken yet stays queued.
 */
const pending = new Map<HandoffTarget, Pending[]>();

/** Row ids already handed over, so a late hydration cannot deliver them twice. */
const consumed = new Set<string>();

let store: HandoffStore = indexedDbHandoffStore;

/** Replace the backing store; tests hand in an in-memory one. */
export function setHandoffStore(next: HandoffStore | null): void {
  store = next ?? indexedDbHandoffStore;
}

/**
 * Storage work runs in order, never in parallel: a take sent and then taken
 * straight away must not be written after its own delete and come back on the
 * next reload.
 */
let writes: Promise<void> = Promise.resolve();

function write(work: () => Promise<void>): void {
  writes = writes.then(work, work).catch(() => {});
}

let hydration: Promise<void> | null = null;

/**
 * Put takes stored by an earlier run in front of anything queued since: they
 * were sent first, so they are handed over first.
 */
function hydrate(): Promise<void> {
  if (!hydration) {
    hydration = store
      .list()
      .then((rows) => {
        // Keys this run queued itself: every send is written to the store as
        // well as the queue, so a read of the store can return a row for a take
        // that is still waiting in memory. Adding it again would hand the same
        // audio over twice — the second copy on a later visit, unasked.
        const held = new Set<string>();
        for (const queue of pending.values()) {
          for (const entry of queue) held.add(entry.key);
        }

        const byTarget = new Map<HandoffTarget, Pending[]>();
        for (const row of rows) {
          if (consumed.has(row.key) || held.has(row.key)) continue;
          const list = byTarget.get(row.target) ?? [];
          list.push({ item: row.item, key: row.key });
          byTarget.set(row.target, list);
        }
        for (const [target, list] of byTarget) {
          pending.set(target, [...list, ...(pending.get(target) ?? [])]);
        }
      })
      .catch(() => {
        // Storage unavailable: the hand-off still works for this session.
      });
  }
  return hydration;
}

/**
 * The sections that are open right now. A take sent to one of them is handed
 * over immediately: the hash would not change, so nothing would remount to take
 * it, and it would sit until the next visit and land there unasked.
 */
const open = new Map<HandoffTarget, Set<Listener>>();

/** Queue a take for `target`, or hand it straight to that section if it is open. */
export function sendHandoff(target: HandoffTarget, item: HandoffItem): void {
  const listeners = open.get(target);

  if (listeners && listeners.size > 0) {
    for (const listener of [...listeners]) listener(item);
    return;
  }

  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const queue = pending.get(target);
  if (queue) queue.push({ item, key });
  else pending.set(target, [{ item, key }]);

  const at = Date.now();
  write(() => store.put({ key, target, at, item }));
}

/**
 * Listen for takes sent to this section: the oldest one queued before it opened
 * is handed over at once, and one sent while it is open arrives without a
 * remount. Anything else still queued stays queued rather than being thrown
 * away, and is taken by a later visit.
 *
 * When this run has nothing queued yet, the store is asked first, so a take
 * that was waiting when the app reloaded still arrives in the section it was
 * sent to.
 */
export function subscribeHandoff(target: HandoffTarget, listener: Listener): () => void {
  const listeners = open.get(target) ?? new Set<Listener>();
  open.set(target, listeners);
  listeners.add(listener);

  const queued = takeHandoff(target);
  if (queued) listener(queued);
  else {
    void hydrate().then(() => {
      // Unmounted while the store was answering: the next mount takes it.
      if (!listeners.has(listener)) return;
      const stored = takeHandoff(target);
      if (stored) listener(stored);
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) open.delete(target);
  };
}

/**
 * Show `section`, replacing the route rather than pushing one. Assigning a hash
 * would add an entry, and Back would then reopen a section whose take the
 * hand-off already consumed — an empty page that looks like undo. Replacing
 * leaves Back meaning "leave this flow".
 *
 * The History API never fires hashchange (MDN: pushState and replaceState both
 * leave it alone, even when only the fragment changes), so the router — which
 * only watches that event — is told by hand or the view would not swap.
 */
export function openSection(section: HandoffSource): void {
  if (typeof window === 'undefined') return;

  window.history.replaceState(null, '', `#/${section}`);
  window.dispatchEvent(new Event('hashchange'));
}

/** Queue the take, then open its section so it lands there. */
export function sendTake(target: HandoffTarget, item: HandoffItem): void {
  sendHandoff(target, item);
  openSection(target);
}

/** Whether a section can be sent a take; Library only ever sends one. */
function isTarget(section: HandoffSource): section is HandoffTarget {
  return section !== 'library';
}

/**
 * Hand `item` back to the section it came from and open it. The hand-off
 * unmounted that section, so opening its route alone would show it empty; the
 * take travels with it and is that section's source again. Library keeps its
 * takes in the database, so for it opening the section is enough.
 */
export function returnTake(to: HandoffSource, item: HandoffItem): void {
  if (isTarget(to)) sendHandoff(to, { ...item, returned: true });
  openSection(to);
}

/**
 * The oldest item queued for this section, if any. Reading it clears it, so the
 * next visit starts with whatever was sent after it, not the take again, and
 * deletes its row so a reload cannot bring it back.
 */
export function takeHandoff(target: HandoffTarget): HandoffItem | null {
  const queue = pending.get(target);
  const entry = queue?.shift();
  if (!queue || !entry) return null;

  if (queue.length === 0) pending.delete(target);
  consumed.add(entry.key);
  write(() => store.remove(entry.key));
  return entry.item;
}

/** Drop anything queued in memory. Used by tests between cases. */
export function clearHandoff(): void {
  pending.clear();
  consumed.clear();
  hydration = null;
  writes = Promise.resolve();
}
