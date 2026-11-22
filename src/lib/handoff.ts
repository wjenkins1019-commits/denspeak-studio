// Passing a finished take to another section without exporting a WAV and
// uploading it again. Queued takes are module state, which outlives the view
// that created them: navigating swaps the view, not the page. They are also
// written to a store, so a reload does not take the audio with it.

import { indexedDbHandoffStore, type HandoffRecord, type HandoffStore } from './handoffStore';

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

/**
 * What a section may leave waiting on disk: a take nobody opened in a week is
 * stale, and no section needs more than a handful in the queue. Both limits are
 * applied to storage only, so nothing this session is holding disappears from
 * under the user — a take still queued here stays deliverable until it is
 * taken.
 */
export const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_MAX_STORED = 8;

type Listener = (item: HandoffItem) => void;

/** Anything outside a section that watches the queues, namely the rail. */
type QueueListener = () => void;

const queueListeners = new Set<QueueListener>();

/**
 * Told after every change to what is queued. Sections use `subscribeHandoff`;
 * this is for the rail, which counts takes for sections that are not open.
 */
export function subscribeQueues(listener: QueueListener): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

function queuesChanged(): void {
  for (const listener of [...queueListeners]) listener();
}

interface Pending {
  item: HandoffItem;
  /** Row in the durable store, so taking the take deletes it there too. */
  key: string;
  /** When it was sent, kept so putting a claimed take back does not reorder it. */
  at: number;
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

/**
 * Test-only: wait until the storage work queued so far has landed. Sends and
 * put-backs write through `writes`, so after this their rows are on disk and
 * any prune they triggered has run. Deletes are awaited by their own callers
 * instead, so an in-flight delete is not covered — wait for its take.
 */
export function flushHandoffWrites(): Promise<void> {
  write(() => Promise.resolve());
  return writes;
}

/**
 * Delete a row only after earlier storage work has landed. Sends queue their
 * puts through `writes`, so a delete issued straight after a send must wait
 * for that chain: deleting first and putting after leaves an orphan row the
 * next run hydrates back — the take delivered twice.
 */
function removeStored(key: string): Promise<void> {
  return writes.then(() => store.remove(key));
}

/**
 * Delete stored rows that are stale or over a section's limit, newest first so
 * the newest takes are the ones that survive. Storage only: the queues this
 * session holds are untouched.
 */
async function pruneStored(rows?: HandoffRecord[]): Promise<void> {
  try {
    const all = rows ?? (await store.list());
    const cutoff = Date.now() - HANDOFF_MAX_AGE_MS;
    const kept = new Map<HandoffTarget, number>();

    for (const row of [...all].reverse()) {
      const count = kept.get(row.target) ?? 0;
      if (row.at >= cutoff && count < HANDOFF_MAX_STORED) {
        kept.set(row.target, count + 1);
        continue;
      }
      await store.remove(row.key);
    }
  } catch {
    // Storage unavailable: there is nothing to prune.
  }
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

                const cutoff = Date.now() - HANDOFF_MAX_AGE_MS;
        const kept = new Map<HandoffTarget, number>();
        const byTarget = new Map<HandoffTarget, Pending[]>();

        // Newest first, so a section's newest takes are the ones that survive
        // the age and count limits; `unshift` puts them back in send order.
        for (const row of [...rows].reverse()) {
          if (consumed.has(row.key)) continue;

          const count = kept.get(row.target) ?? 0;
          if (row.at < cutoff || count >= HANDOFF_MAX_STORED) continue;
          kept.set(row.target, count + 1);
          if (held.has(row.key)) continue;

          const list = byTarget.get(row.target) ?? [];
          list.unshift({ item: row.item, key: row.key, at: row.at });
          byTarget.set(row.target, list);
        }

        for (const [target, list] of byTarget) {
          pending.set(target, [...list, ...(pending.get(target) ?? [])]);
        }

        if (byTarget.size > 0) queuesChanged();

        // Stale, over-limit and already-taken rows are not coming back.
        void pruneStored(rows);
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

/**
 * Targets with a take currently being claimed. A send to one of them waits
 * behind the claim instead of being handed over it: the claim resolves into
 * an arrival that would otherwise replace — and lose — the direct one, or be
 * replaced by it out of order.
 */
const claimingTargets = new Map<HandoffTarget, number>();

/** Queue a take for `target`, or hand it straight to that section if it is open. */
export function sendHandoff(target: HandoffTarget, item: HandoffItem): void {
  const listeners = open.get(target);

  // Direct only when nothing is being claimed: a send that lands while the
  // visit's take is still being deleted would be replaced by its arrival out
  // of order, so it queues behind the claim instead.
  if (listeners && listeners.size > 0 && !claimingTargets.has(target)) {
    for (const listener of [...listeners]) listener(item);
    return;
  }

  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const at = Date.now();
  const queue = pending.get(target);
  if (queue) queue.push({ item, key, at });
  else pending.set(target, [{ item, key, at }]);

  queuesChanged();

  // Written, then pruned: a section nobody opens must not collect takes on disk
  // for ever.
  write(() => store.put({ key, target, at, item }).then(() => pruneStored()));
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
 *
 * `take: false` joins without taking a queued take, for a listener that only
 * has to stay open — the second subscription React's StrictMode runs in
 * development, after the first has already been handed its take.
 *
 * `onFailed` is told when a take could not be opened because its stored row
 * would not delete. It is still queued, so the section can offer another try.
 */
export function subscribeHandoff(
  target: HandoffTarget,
  listener: Listener,
  options: { take?: boolean; onFailed?: () => void } = {},
): () => void {
  const listeners = open.get(target) ?? new Set<Listener>();
  open.set(target, listeners);
  listeners.add(listener);

  const stop = () => {
    listeners.delete(listener);
    if (listeners.size === 0) open.delete(target);
  };

  // Joining only to stay open. A take sent from here on still arrives through
  // `sendHandoff`; nothing queued is taken from under the listener that just
  // had one.
  if (options.take === false) return stop;

  // The stored row has to be gone before the take can be shown, so this runs
  // asynchronously. Hand it to whoever is listening when the delete lands: in
  // StrictMode the listener above was already replaced by the surviving mount.
  void (async () => {
    let claim = await claimStoredTake(target);

    if (claim.status === 'empty') {
      await hydrate();
      if (!open.get(target)?.size) return;
      claim = await claimStoredTake(target);
    }

    // A failed delete leaves the row on disk; the take stays queued instead of
    // being shown now and replayed on the next run. Say so, so a section left
    // empty can offer another try rather than look as if nothing arrived.
    if (claim.status === 'failed') {
      if (open.get(target)?.size) options.onFailed?.();
      return;
    }

    if (claim.status !== 'taken') return;

    const current = open.get(target);
    if (!current || current.size === 0) {
      // The section closed while the row was being deleted: write it back
      // rather than lose the take with the view.
      putBackHandoff(target, claim.entry);
      return;
    }

    for (const waiting of [...current]) waiting(claim.entry.item);
  })();

  return stop;
}

type Claim =
  | { status: 'taken'; entry: Pending }
  | { status: 'empty' }
  | { status: 'failed' };

/**
 * Claim the oldest queued take and delete its row before it can be handed over.
 * A failed delete puts the take back: the row may survive, and applying a take
 * whose row is still there is exactly what brings it back next run.
 */
/**
 * How long a stored row may take to clear before the take is reported as not
 * opening. A store that never answers would otherwise leave a section silent
 * with the take stuck: neither shown, nor said to be still waiting.
 */
const DEFAULT_CLEAR_TIMEOUT_MS = 5000;

let clearTimeoutMs = DEFAULT_CLEAR_TIMEOUT_MS;

/** Shorten the wait above, so a test does not have to sit through it. */
export function setClearTimeout(ms?: number): void {
  clearTimeoutMs = ms ?? DEFAULT_CLEAR_TIMEOUT_MS;
}

/** `work`, or a rejection once `ms` passes without it settling. */
function withinTimeout(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the row would not clear')), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function claimStoredTake(target: HandoffTarget): Promise<Claim> {
  const entry = claimQueued(target);
  if (!entry) return { status: 'empty' };

  claimingTargets.set(target, (claimingTargets.get(target) ?? 0) + 1);
  try {
    // A delete that never answers is no better than one that refuses: the row
    // is still on disk, so the take stays queued and the section has to say so
    // rather than sit silent with the take caught between queued and shown.
    await withinTimeout(removeStored(entry.key), clearTimeoutMs);
    return { status: 'taken', entry };
  } catch {
    restoreQueued(target, entry);
    return { status: 'failed' };
  } finally {
    const left = (claimingTargets.get(target) ?? 0) - 1;
    if (left <= 0) claimingTargets.delete(target);
    else claimingTargets.set(target, left);
  }
}

/** What came of asking for the next queued take. */
export type HandoffClaim =
  | {
      status: 'taken';
      item: HandoffItem;
      /**
       * Put the take back without showing it, for a section that is gone
       * before the delete lands: navigating away unmounts the view its
       * arrival would have landed in.
       */
      release: () => void;
    }
  | { status: 'empty' }
  | { status: 'failed' };

/**
 * Try to take the next queued take and say what happened. `failed` means the
 * take is still queued: its row survived, so showing it would bring it back on
 * the next run. A section uses this to report the attempt and to try again.
 */
export async function claimHandoff(target: HandoffTarget): Promise<HandoffClaim> {
  const claim = await claimStoredTake(target);
  if (claim.status === 'taken') {
    const entry = claim.entry;
    return { status: 'taken', item: entry.item, release: () => putBackHandoff(target, entry) };
  }
  return claim.status === 'failed' ? { status: 'failed' } : { status: 'empty' };
}

function claimQueued(target: HandoffTarget): Pending | null {
  const queue = pending.get(target);
  const entry = queue?.shift();
  if (!queue || !entry) return null;

  if (queue.length === 0) pending.delete(target);
  // Blocks a late hydration from reading the row back while the delete is in
  // flight.
  consumed.add(entry.key);
  queuesChanged();
  return entry;
}

function restoreQueued(target: HandoffTarget, entry: Pending): void {
  consumed.delete(entry.key);
  const queue = pending.get(target) ?? [];
  queue.unshift(entry);
  pending.set(target, queue);
  queuesChanged();
}

function putBackHandoff(target: HandoffTarget, entry: Pending): void {
  restoreQueued(target, entry);
  // The row went before the listener did; store it again so the take is not
  // left in memory only.
  write(() => store.put({ key: entry.key, target, at: entry.at, item: entry.item }));
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

/** How many takes are waiting for a section, not counting one it has taken. */
export function pendingCount(target: HandoffTarget): number {
  return pending.get(target)?.length ?? 0;
}

/** A take still queued for a section, for showing it before it is thrown away. */
export interface QueuedTake {
  /** Row id, so one take can be discarded without taking the one in front. */
  key: string;
  name: string;
  from?: HandoffSource;
  duration?: number;
}

/** What is queued for a section, oldest first. Reading it takes nothing. */
export function queuedTakes(target: HandoffTarget): QueuedTake[] {
  return (pending.get(target) ?? []).map(({ key, item }) => ({
    key,
    name: item.name,
    from: item.from,
    duration: item.duration,
  }));
}

/**
 * Throw away one queued take without taking it. Only ever user-initiated: a
 * take nobody asked to drop stays queued, as it always has.
 *
 * The row goes before the take leaves the queue, so a delete that fails leaves
 * the take where the user can see it and try again. Dropping it from the queue
 * first is what let a "discarded" take arrive again on the next run.
 *
 * Answers false when the take is no longer queued or its row would not go.
 */
export async function discardHandoff(target: HandoffTarget, key: string): Promise<boolean> {
  const queue = pending.get(target);
  if (!queue?.some((entry) => entry.key === key)) return false;

  try {
    // A delete that never answers counts as one that refused: the row is still
    // there, so the take stays queued and the panel says why it is still listed.
    await withinTimeout(removeStored(key), clearTimeoutMs);
  } catch {
    return false;
  }

  // The delete took a moment; the take may have been claimed while it ran, in
  // which case there is nothing left to take out of the queue.
  const current = pending.get(target);
  const index = current ? current.findIndex((entry) => entry.key === key) : -1;
  consumed.add(key);
  if (current && index >= 0) {
    current.splice(index, 1);
    if (current.length === 0) pending.delete(target);
  }
  queuesChanged();
  return true;
}

/**
 * Throw away everything queued for a section, each row first. Only the takes
 * whose rows actually went leave the queue; the rest stay visible so a failed
 * clear cannot come back as an arrival on the next run.
 *
 * The whole clear holds to one deadline rather than one per row: rows still
 * waiting when it passes are kept unasked, so a store that hangs cannot hold the
 * panel for a wait per take.
 *
 * Answers how many went.
 */
export async function discardHandoffQueue(target: HandoffTarget): Promise<number> {
  const queue = pending.get(target);
  if (!queue || queue.length === 0) return 0;

  const asked = new Set(queue.map((entry) => entry.key));
  const kept = new Set<string>();
  let gone = 0;
  const deadline = Date.now() + clearTimeoutMs;

  for (const key of asked) {
    const left = deadline - Date.now();
    if (left <= 0) {
      // The budget is spent: a delete started now would not be waited for, and
      // the row would be reported kept either way.
      kept.add(key);
      continue;
    }

    try {
      await withinTimeout(removeStored(key), left);
      consumed.add(key);
      gone += 1;
    } catch {
      kept.add(key);
    }
  }

  // Anything queued while this ran was never part of the clear and stays; so
  // does any take whose row would not go.
  const remaining = (pending.get(target) ?? []).filter(
    (entry) => !asked.has(entry.key) || kept.has(entry.key),
  );
  if (remaining.length === 0) pending.delete(target);
  else pending.set(target, remaining);
  queuesChanged();
  return gone;
}

/** How many takes are waiting for each section; a section with none is left out. */
export function pendingCounts(): Partial<Record<HandoffTarget, number>> {
  const counts: Partial<Record<HandoffTarget, number>> = {};
  for (const [target, queue] of pending) {
    if (queue.length > 0) counts[target] = queue.length;
  }
  return counts;
}

/**
 * Read what an earlier run left on disk now rather than on the first visit to a
 * section: the rail counts takes for a section nobody has opened yet.
 */
export function hydrateHandoff(): Promise<void> {
  return hydrate();
}

/** Whether a route names a section that can be handed a take. */
export function isHandoffRoute(route: string): route is HandoffTarget {
  return HANDOFF_TARGETS.some((entry) => entry.target === route);
}

/**
 * The oldest item queued for this section, if any, after its stored row is
 * gone. Reading it clears it, so the next visit starts with whatever was sent
 * after it, and no later run can hand it over again.
 *
 * The delete lands first: a crash in the instant between the delete and the
 * section applying it loses that visit's take, but a take that was applied can
 * never be replayed. A failed delete leaves the take queued for the next
 * attempt instead.
 */
export async function takeHandoff(target: HandoffTarget): Promise<HandoffItem | null> {
  const claim = await claimStoredTake(target);
  return claim.status === 'taken' ? claim.entry.item : null;
}

/** Drop anything queued in memory. Used by tests between cases. */
export function clearHandoff(): void {
  pending.clear();
  consumed.clear();
  claimingTargets.clear();
  hydration = null;
  writes = Promise.resolve();
  queuesChanged();
}
