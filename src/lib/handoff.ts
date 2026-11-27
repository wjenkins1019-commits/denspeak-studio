// Passing a finished take to another section without exporting a WAV and
// uploading it again. Queued takes are module state, which outlives the view
// that created them: navigating swaps the view, not the page. They are also
// written to a store, so a reload does not take the audio with it.

import {
  indexedDbHandoffDeliveredStore,
  indexedDbHandoffOutboxStore,
  indexedDbHandoffStore,
  type DeliveredRecord,
  type DeliveredStore,
  type HandoffRecord,
  type HandoffStore,
} from './handoffStore';

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
  /**
   * Whether this run read the take back from storage. Only those takes are
   * shared with other tabs: the row is the shared truth, so a hydrated take
   * is delivered only while its row is still there. A take this run sent may
   * still be landing in this tab's write queue, so its row missing proves
   * nothing about another tab.
   */
  hydrated: boolean;
  /**
   * Whether the row is known on disk. Hydrated takes were read from there;
   * a take this run sent becomes stored when its queued put lands. Only a
   * stored take verifies its row inside the cross-tab lock — before the put
   * lands the row missing proves nothing, so the take is claimed as before.
   */
  stored: boolean;
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
/** Cap: every taken or discarded take stays consumed, so bound the set. */
const MAX_CONSUMED_KEYS = 500;

function rememberConsumed(key: string): void {
  consumed.delete(key);
  consumed.add(key);
  while (consumed.size > MAX_CONSUMED_KEYS) {
    const oldest = consumed.values().next().value as string | undefined;
    if (oldest === undefined) break;
    consumed.delete(oldest);
  }
}

/** Consecutive failed open attempts per queued take, for retry surfacing. */
interface FailedTake {
  target: HandoffTarget;
  name: string;
  attempts: number;
  lastFailedAt: number;
}
const failedTakes = new Map<string, FailedTake>();
/** Cap: failures are per queued take, so bound the map like the queue. */
const MAX_FAILED_TAKES = 200;

function noteFailed(target: HandoffTarget, entry: Pending): void {
  const previous = failedTakes.get(entry.key);
  failedTakes.delete(entry.key);
  failedTakes.set(entry.key, {
    target,
    name: entry.item.name,
    attempts: (previous?.attempts ?? 0) + 1,
    lastFailedAt: Date.now(),
  });
  while (failedTakes.size > MAX_FAILED_TAKES) {
    const oldest = failedTakes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    failedTakes.delete(oldest);
  }
}

function clearFailed(key: string): void {
  failedTakes.delete(key);
}

let store: HandoffStore = indexedDbHandoffStore;

/** Replace the backing store; tests hand in an in-memory one. */
export function setHandoffStore(next: HandoffStore | null): void {
  store = next ?? indexedDbHandoffStore;
}

let outboxStore: HandoffStore = indexedDbHandoffOutboxStore;

/** Replace the crash-recovery outbox; tests hand in an in-memory one. */
export function setHandoffOutboxStore(next: HandoffStore | null): void {
  outboxStore = next ?? indexedDbHandoffOutboxStore;
}

let deliveredStore: DeliveredStore = indexedDbHandoffDeliveredStore;

/** Replace the delivered-ids store; tests hand in an in-memory one. */
export function setHandoffDeliveredStore(next: DeliveredStore | null): void {
  deliveredStore = next ?? indexedDbHandoffDeliveredStore;
}

function isValidDeliveredRecord(row: unknown): row is DeliveredRecord {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Partial<DeliveredRecord>;
  return (
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    typeof candidate.at === 'number' &&
    Number.isFinite(candidate.at)
  );
}

/**
 * Remember a delivery durably, only after its ack: a crash before the ack
 * replays from the outbox (at-least-once), a restart after the ack finds the
 * id here and never replays even a stale row that still names it. Claim-time
 * `rememberConsumed` stays in-memory only, so a take put back before it was
 * shown can still be delivered. Best-effort: when the store will not take
 * the id the in-memory guard still holds for this run.
 */
function rememberDelivered(key: string): void {
  rememberConsumed(key);
  const work = deliveredStore.put({ key, at: Date.now() }).catch(() => {});
  pendingWork.add(work);
  void work.then(() => {
    pendingWork.delete(work);
  });
  void pruneDelivered();
}

/**
 * Keep delivered ids to the newest `MAX_CONSUMED_KEYS`, so the set cannot
 * grow with the session. Corrupt rows go too. Best-effort and storage-only.
 */
async function pruneDelivered(rows?: DeliveredRecord[]): Promise<void> {
  try {
    const all = rows ?? (await deliveredStore.list());
    const valid: DeliveredRecord[] = [];
    for (const row of all) {
      if (!isValidDeliveredRecord(row)) {
        try {
          const key = (row as { key?: unknown } | null | undefined)?.key;
          if (typeof key === 'string' && key.length > 0) await deliveredStore.remove(key);
        } catch {
          // Keep pruning the rest; hydration quarantines what survives.
        }
        continue;
      }
      valid.push(row);
    }
    if (valid.length <= MAX_CONSUMED_KEYS) return;
    const ordered = [...valid].sort((a, b) => a.at - b.at);
    for (const row of ordered.slice(0, ordered.length - MAX_CONSUMED_KEYS)) {
      try {
        await deliveredStore.remove(row.key);
      } catch {
        // Keep pruning the rest; the next hydrate retries.
      }
    }
  } catch {
    // Storage unavailable: there is nothing to prune.
  }
}

/** Takes with an intent on disk whose delivery has not been acknowledged yet. */
const outboxInflight = new Set<string>();

/**
 * Record the intent to delete `entry` before its row goes: a crash between
 * the row's delete and the delivery ack leaves the intent, so the next run
 * can re-queue the take instead of losing it. Best-effort: when the outbox
 * will not take it the claim falls back to delete-before-handover.
 */
async function writeOutbox(target: HandoffTarget, entry: Pending): Promise<void> {
  outboxInflight.add(entry.key);
  try {
    await withinTimeout(
      outboxStore.put({ key: entry.key, target, at: entry.at, item: entry.item }),
      clearTimeoutMs,
    );
    // Best-effort, off the claim's critical path like the send prune: a run
    // that claims without ever hydrating must not collect intents on disk
    // for ever. The just-written intent is the newest, so the caps keep it.
    void pruneOutbox();
  } catch {
    // Fail open to delete-before-handover: no intent, no replay, no wedge.
    outboxInflight.delete(entry.key);
  }
}

/**
 * Forget a delivered take's intent, after its delivery has been acknowledged.
 * The intent stays on disk through the handover, so a crash after the row's
 * delete but before the ack replays the take instead of losing it — and a
 * crash after the ack can only replay a take that was already delivered
 * (at-least-once). Before delivery, a refusal keeps the take queued for
 * another try rather than risk a duplicate.
 */
async function clearOutbox(key: string): Promise<void> {
  try {
    await withinTimeout(outboxStore.remove(key), clearTimeoutMs);
  } catch {
    throw new Error('the take intent would not clear');
  }
  outboxInflight.delete(key);
  // Acked: even a stale row naming this id must never replay after restart.
  rememberDelivered(key);
}

/** Forget an intent without failing when the take is gone either way. */
function dropOutbox(key: string): void {
  outboxInflight.delete(key);
  void outboxStore.remove(key).catch(() => {});
}

/**
 * Storage puts run per key, never on one global chain: a take sent and then
 * taken straight away must not be written after its own delete and come back
 * on the next reload, but a hung put for one take must not stall deletes for
 * another. Each key's puts stay ordered; different keys run in parallel.
 */
const putTails = new Map<string, Promise<void>>();
const pendingWork = new Set<Promise<void>>();

function queuePut(key: string, put: () => Promise<void>, after?: () => Promise<void>): void {
  const prev = putTails.get(key) ?? Promise.resolve();
  const putDone = prev.catch(() => {}).then(put);
  const tail = putDone.catch(() => {});
  putTails.set(key, tail);
  const cleanup = () => {
    if (putTails.get(key) === tail) putTails.delete(key);
  };
  void tail.then(cleanup, cleanup);
  const tracked: Promise<void> = putDone.then(
    () => after?.(),
    () => after?.(),
  ).then(
    () => {},
    () => {},
  );
  pendingWork.add(tracked);
  void tracked.then(() => {
    pendingWork.delete(tracked);
  });
}

/**
 * Test-only: wait until the storage work queued so far has landed. Sends and
 * put-backs queue through `queuePut`, so after this their rows are on disk
 * and any prune they triggered has run. Deletes are awaited by their own
 * callers instead, so an in-flight delete is not covered — wait for its take.
 * A put that never settles never lets this resolve; tests hold puts only
 * around the delete they are proving non-blocking, never across a flush.
 */
export function flushHandoffWrites(): Promise<void> {
  const snapshot = [...pendingWork];
  if (snapshot.length === 0) return Promise.resolve();
  return Promise.all(snapshot).then(() => {
    if (pendingWork.size > 0) return flushHandoffWrites();
  });
}

/**
 * Delete a row only after its own put has landed. Sends queue their puts per
 * key, so a delete issued straight after a send must wait for that key's
 * chain: deleting first and putting after leaves an orphan row the next run
 * hydrates back — the take delivered twice. Puts for other keys are never
 * waited for, so one hung put cannot stall later deletes for other takes.
 */
function removeStored(key: string): Promise<void> {
  const wait = putTails.get(key) ?? Promise.resolve();
  return wait.catch(() => {}).then(() => store.remove(key));
}

/** Sections a stored row may name; anything else was written by nothing here. */
const HANDOFF_TARGET_SET = new Set<string>(HANDOFF_TARGETS.map((entry) => entry.target));

function isHandoffSource(value: unknown): value is HandoffSource {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SECTION_LABELS, value);
}

/**
 * Whether a stored row is one this app could have written: a keyed take for a
 * real section with a usable item. Anything else is corruption — a foreign
 * write, a half-landed record, tampering — and no section may be handed it.
 */
function isValidHandoffRecord(row: unknown): row is HandoffRecord {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Partial<HandoffRecord>;
  if (typeof candidate.key !== 'string' || candidate.key.length === 0) return false;
  if (typeof candidate.target !== 'string' || !HANDOFF_TARGET_SET.has(candidate.target)) return false;
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return false;
  const item = candidate.item as Partial<HandoffItem> | null | undefined;
  if (!item || typeof item !== 'object') return false;
  if (typeof item.name !== 'string' || item.name.length === 0) return false;
  if (typeof Blob !== 'undefined' && !(item.blob instanceof Blob)) return false;
  if (item.duration !== undefined && (typeof item.duration !== 'number' || !Number.isFinite(item.duration)))
    return false;
  if (item.captions !== undefined) {
    const captions = item.captions as { srt?: unknown; vtt?: unknown } | null;
    if (
      !captions ||
      typeof captions !== 'object' ||
      typeof captions.srt !== 'string' ||
      typeof captions.vtt !== 'string'
    )
      return false;
  }
  if (item.from !== undefined && !isHandoffSource(item.from)) return false;
  if (item.returned !== undefined && item.returned !== true) return false;
  return true;
}

/** A stored row's key when it has one; corrupt rows without a key can only be skipped. */
function corruptRowKey(row: unknown): string | null {
  const key = (row as { key?: unknown } | null | undefined)?.key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Delete stored rows that are stale or over a section's limit, newest first so
 * the newest takes are the ones that survive. Storage only: the queues this
 * session holds are untouched. Rows no section could have written are deleted
 * too, so they cannot sit on disk wedging every future hydration.
 */
async function pruneStored(rows?: HandoffRecord[]): Promise<void> {
  try {
    const all = rows ?? (await store.list());
    const cutoff = Date.now() - HANDOFF_MAX_AGE_MS;
    const kept = new Map<HandoffTarget, number>();

    for (const row of [...all].reverse()) {
      if (!isValidHandoffRecord(row)) {
        try {
          const key = corruptRowKey(row);
          if (key) await store.remove(key);
        } catch {
          // Keep pruning the rest; hydration quarantines what survives.
        }
        continue;
      }
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

/**
 * Delete outbox intents that are stale or over a section's limit, newest
 * first so the newest intents are the ones that survive — the same caps as
 * pending takes. A pruned intent falls back to delete-before-handover: a
 * crash after its row's delete loses the take instead of replaying one the
 * limits already dropped. Corrupt intents go too, so they cannot sit on disk
 * wedging every future hydration. Best-effort and storage-only.
 */
async function pruneOutbox(rows?: HandoffRecord[]): Promise<void> {
  try {
    const all = rows ?? (await outboxStore.list());
    const cutoff = Date.now() - HANDOFF_MAX_AGE_MS;
    const kept = new Map<HandoffTarget, number>();

    for (const row of [...all].reverse()) {
      if (!isValidHandoffRecord(row)) {
        try {
          const key = corruptRowKey(row);
          if (key) await outboxStore.remove(key);
          if (key) outboxInflight.delete(key);
        } catch {
          // Keep pruning the rest; hydration quarantines what survives.
        }
        continue;
      }
      const count = kept.get(row.target) ?? 0;
      if (row.at >= cutoff && count < HANDOFF_MAX_STORED) {
        kept.set(row.target, count + 1);
        continue;
      }
      try {
        await outboxStore.remove(row.key);
      } catch {
        // Keep pruning the rest; the next hydrate retries.
      }
      outboxInflight.delete(row.key);
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
      .then(async (rows) => {
        if (!Array.isArray(rows)) rows = [];
        // Delivered ids survive restarts: even a stale row or intent naming
        // one must never queue again. Loaded first so every check below sees
        // them. Claim-time `consumed` stays in-memory only — a take put back
        // before it was shown is not delivered yet.
        try {
          const delivered = await deliveredStore.list();
          const validDelivered: DeliveredRecord[] = [];
          const deliveredQuarantine: string[] = [];
          for (const row of Array.isArray(delivered) ? delivered : []) {
            if (!isValidDeliveredRecord(row)) {
              const key = (row as { key?: unknown } | null | undefined)?.key;
              if (typeof key === 'string' && key.length > 0) deliveredQuarantine.push(key);
              continue;
            }
            validDelivered.push(row);
          }
          if (deliveredQuarantine.length > 0) {
            await Promise.all(deliveredQuarantine.map((key) => deliveredStore.remove(key).catch(() => {})));
          }
          validDelivered.sort((a, b) => a.at - b.at);
          for (const row of validDelivered.slice(-MAX_CONSUMED_KEYS)) rememberConsumed(row.key);
          void pruneDelivered(validDelivered);
        } catch {
          // Storage unavailable: the in-memory guard still holds this run.
        }
        let outboxRows: HandoffRecord[] = [];
        try {
          const listed = await outboxStore.list();
          if (Array.isArray(listed)) outboxRows = listed;
        } catch {
          outboxRows = [];
        }

        // Keys this run queued itself: every send is written to the store as
        // well as the queue, so a read of the store can return a row for a take
        // that is still waiting in memory. Adding it again would hand the same
        // audio over twice — the second copy on a later visit, unasked.
        const held = new Set<string>();
        for (const queue of pending.values()) {
          for (const entry of queue) held.add(entry.key);
        }

        // Validate each row on its own: one corrupt row must neither throw the
        // rest away nor surface as a take. Bad rows with a key are deleted so
        // they cannot wedge the next run either; rows without a key can only
        // be skipped. In-memory takes this run sent are always valid.
        const valid: HandoffRecord[] = [];
        const quarantine: string[] = [];
        for (const row of rows) {
          if (!isValidHandoffRecord(row)) {
            const key = corruptRowKey(row);
            if (key) quarantine.push(key);
            continue;
          }
          valid.push(row);
        }
        if (quarantine.length > 0) {
          await Promise.all(quarantine.map((key) => removeStored(key).catch(() => {})));
        }

                const cutoff = Date.now() - HANDOFF_MAX_AGE_MS;
        const kept = new Map<HandoffTarget, number>();
        const byTarget = new Map<HandoffTarget, Pending[]>();

        // Newest first, so a section's newest takes are the ones that survive
        // the age and count limits; `unshift` puts them back in send order.
        for (const row of [...valid].reverse()) {
          if (consumed.has(row.key)) continue;

          const count = kept.get(row.target) ?? 0;
          if (row.at < cutoff || count >= HANDOFF_MAX_STORED) continue;
          kept.set(row.target, count + 1);
          if (held.has(row.key)) continue;

          const list = byTarget.get(row.target) ?? [];
          list.unshift({ item: row.item, key: row.key, at: row.at, hydrated: true, stored: true });
          byTarget.set(row.target, list);
        }

        // Crash recovery: intents left by a claim whose row delete landed but
        // whose intent clear did not are re-queued under the same row id, so a
        // second hydrate never queues a second copy. Takes whose main row
        // survived need no replay; stale or over-limit intents are dropped
        // rather than resurrected. Replayed takes restore their main row and
        // queue unstored, so the next claim deletes the restored row first.
        const replayed = new Map<HandoffTarget, Pending[]>();
        const queuedKeys = new Set<string>(held);
        for (const list of byTarget.values()) {
          for (const entry of list) queuedKeys.add(entry.key);
        }
        const outboxQuarantine: string[] = [];
        const outboxValid: HandoffRecord[] = [];
        for (const row of outboxRows) {
          if (!isValidHandoffRecord(row)) {
            const key = corruptRowKey(row);
            if (key) outboxQuarantine.push(key);
            continue;
          }
          outboxValid.push(row);
        }
        if (outboxQuarantine.length > 0) {
          await Promise.all(outboxQuarantine.map((key) => outboxStore.remove(key).catch(() => {})));
        }
        for (const row of [...outboxValid].reverse()) {
          if (consumed.has(row.key) || queuedKeys.has(row.key)) continue;
          const count = kept.get(row.target) ?? 0;
          if (row.at < cutoff || count >= HANDOFF_MAX_STORED) {
            // Never resurrect what the age and count limits already dropped.
            void outboxStore.remove(row.key).catch(() => {});
            continue;
          }
          kept.set(row.target, count + 1);
          queuedKeys.add(row.key);
          const entry: Pending = {
            item: row.item,
            key: row.key,
            at: row.at,
            hydrated: true,
            stored: false,
          };
          const list = replayed.get(row.target) ?? [];
          list.unshift(entry);
          replayed.set(row.target, list);
          // Restore the main row the crash deleted: the next claim waits for
          // this put before deleting, so it cannot orphan or double-deliver.
          queuePut(row.key, () =>
            store.put({ key: row.key, target: row.target, at: row.at, item: row.item }).then(() => {
              entry.stored = true;
            }),
          );
        }
        for (const [target, list] of replayed) {
          const existing = byTarget.get(target) ?? [];
          byTarget.set(target, [...existing, ...list]);
        }

        for (const [target, list] of byTarget) {
          pending.set(target, [...list, ...(pending.get(target) ?? [])]);
        }

        if (byTarget.size > 0) queuesChanged();

        // Stale, over-limit and already-taken rows are not coming back.
        // The outbox gets the same caps: stale or over-limit intents must
        // never sit on disk waiting to resurrect a take the limits dropped.
        void pruneStored(valid);
        void pruneOutbox();
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

      // Random UUIDs, not timestamps: two tabs sending in the same millisecond
      // must never mint the same row id and delete each other's takes.
      const key = crypto.randomUUID();
  const at = Date.now();
  const entry: Pending = { item, key, at, hydrated: false, stored: false };
  const queue = pending.get(target);
  if (queue) queue.push(entry);
  else pending.set(target, [entry]);

  queuesChanged();

  // Written, then pruned: a section nobody opens must not collect takes on disk
  // for ever. The take counts as stored only once its put lands — only then
  // can a missing row mean another tab claimed it rather than this tab's
  // write queue not having caught up yet.
  queuePut(
    key,
    () =>
      store.put({ key, target, at, item }).then(() => {
        entry.stored = true;
      }),
    () => pruneStored(),
  );
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
      // rather than lose the take with the view. The intent is kept for
      // the next delivery, so no ack here.
      putBackHandoff(target, claim.entry);
      return;
    }

    for (const waiting of [...current]) waiting(claim.entry.item);
    // The take is shown: only now is the intent cleared. A crash between
    // delivery and this ack replays an already-delivered take rather than
    // losing one that crashed after cleanup but before it was shown. A
    // refusal leaves the intent for replay; the take stays delivered.
    try {
      await clearOutbox(claim.entry.key);
    } catch {
      // Already delivered: keep the intent so the next run replays instead
      // of losing the take.
    }
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

/**
 * How long a cross-tab lock may take to grant before the waiter gives up. A
 * tab holding a take lock while stuck — a delete that never settles inside
 * the lock — would otherwise hang every other tab's claim or discard on that
 * take for ever. Long enough for a tab finishing its own delete, short
 * enough that the panel never sits silent.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 2000;

let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;

/** Shorten the wait above, so a test does not have to sit through it. */
export function setLockTimeout(ms?: number): void {
  lockTimeoutMs = ms ?? DEFAULT_LOCK_TIMEOUT_MS;
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

interface ClaimLock {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * The cross-tab lock, when the browser has one. Web Locks serialize tabs
 * holding the same name, which is what makes the check-then-delete below
 * atomic across tabs; without it there is no shared primitive to hold.
 */
function claimLock(): ClaimLock | null {
  const locks = (globalThis as unknown as { navigator?: { locks?: ClaimLock } }).navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Hold the cross-tab lock for `key` while claiming or discarding it, so two
 * tabs acting on the same stored take serialize: the loser finds the row gone
 * instead of deleting nothing and delivering its stale copy — or delivering
 * a take the other tab just discarded. Without Web Locks the take is handled
 * as before. Only the grant times out, so a stuck holder cannot hang the
 * waiter for ever; once granted, the work runs to its own delete deadline
 * with no lock timer racing it. A grant arriving after the timeout finds
 * timed-out work that refuses to run.
 */
function withClaimLock<T>(key: string, work: () => Promise<T>, ms: number = lockTimeoutMs): Promise<T> {
  const locks = claimLock();
  if (!locks) return work();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let grantResolve!: () => void;
  let grantReject!: (error: unknown) => void;
  const grantedInTime = new Promise<void>((resolve, reject) => {
    grantResolve = resolve;
    grantReject = reject;
  });
  // Prevent an unhandled rejection when the late grant refuses after we
  // already timed out waiting for it.
  void grantedInTime.catch(() => {});
  timer = setTimeout(() => {
    timedOut = true;
    grantReject(new Error('the take lock would not grant'));
  }, ms);
  const granted = locks.request(`chatter-box-handoff-take-${key}`, () => {
    if (timedOut) return Promise.reject(new Error('the take lock would not grant'));
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    grantResolve();
    return work();
  });
  // Silence a late refusal after the grant already timed out.
  void granted.catch(() => {});
  return grantedInTime.then(() => granted);
}

async function claimStoredTake(target: HandoffTarget): Promise<Claim> {
  for (;;) {
    const head = pending.get(target)?.[0];
    if (!head) return { status: 'empty' };

    // A stored take may have been claimed by another tab since: only the tab
    // that deletes the row may deliver it, so the row is checked inside the
    // cross-tab lock. The loser drops its stale copy and tries whatever is
    // queued behind it. A take whose put has not landed yet skips the check
    // — its row missing proves nothing about another tab — and is claimed
    // as before. A lock that will not grant reports failed and keeps the
    // take queued for retry rather than falling back to an unlocked claim
    // that could deliver the same row in two tabs at once.
    if (head.stored && claimLock()) {
      try {
        const outcome = await claimHydratedHead(target, head);
        if (outcome.status !== 'stolen') return outcome;
      } catch {
        noteFailed(target, head);
        return { status: 'failed' };
      }
      continue;
    }

    return claimHead(target);
  }
}

async function claimHead(target: HandoffTarget): Promise<Claim> {
  const entry = claimQueued(target);
  if (!entry) return { status: 'empty' };

  claimingTargets.set(target, (claimingTargets.get(target) ?? 0) + 1);
  try {
    // The intent lands first and is held until after the delivery ack: a
    // crash between the row's delete and the ack leaves the outbox, so the
    // next run re-queues the take instead of losing it. Clearing before
    // handover is what lost takes that crashed after cleanup but before
    // delivery — the intent is now cleared only once the take is shown.
    // Replays use the same row id and dedupe.
    await writeOutbox(target, entry);
    // A delete that never answers is no better than one that refuses: the row
    // is still on disk, so the take stays queued and the section has to say so
    // rather than sit silent with the take caught between queued and shown.
    await withinTimeout(removeStored(entry.key), clearTimeoutMs);
    clearFailed(entry.key);
    return { status: 'taken', entry };
  } catch {
    noteFailed(target, entry);
    restoreQueued(target, entry);
    return { status: 'failed' };
  } finally {
    const left = (claimingTargets.get(target) ?? 0) - 1;
    if (left <= 0) claimingTargets.delete(target);
    else claimingTargets.set(target, left);
  }
}

/**
 * Claim a take known on disk, holding its cross-tab lock. Answers `stolen`
 * when the row is already gone — another tab claimed or discarded it, or it
 * was pruned — after dropping this tab's stale copy so it can never be
 * replayed. Storage that will not answer leaves the take to the normal
 * claim, since its absence then proves nothing.
 */
async function claimHydratedHead(
  target: HandoffTarget,
  head: Pending,
): Promise<Claim | { status: 'stolen' }> {
  return withClaimLock(head.key, async () => {
    // Gone from this tab while the lock was waited for — discarded, or taken
    // by a claim that got there first — so there is nothing for this one.
    const queued = pending.get(target)?.some((entry) => entry.key === head.key);
    if (!queued) return { status: 'empty' };

    let rows: HandoffRecord[] | null = null;
    try {
      rows = await store.list();
    } catch {
      rows = null;
    }
    if (rows && !rows.some((row) => row?.key === head.key)) {
      dropStolen(target, head.key);
      return { status: 'stolen' };
    }

    const entry = takeQueuedByKey(target, head.key);
    if (!entry) return { status: 'empty' };

    claimingTargets.set(target, (claimingTargets.get(target) ?? 0) + 1);
    try {
      await writeOutbox(target, entry);
      await withinTimeout(removeStored(entry.key), clearTimeoutMs);
      clearFailed(entry.key);
      return { status: 'taken', entry };
    } catch {
      noteFailed(target, entry);
      restoreQueued(target, entry);
      return { status: 'failed' };
    } finally {
      const left = (claimingTargets.get(target) ?? 0) - 1;
      if (left <= 0) claimingTargets.delete(target);
      else claimingTargets.set(target, left);
    }
  });
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
      /**
       * Clear the crash-recovery intent after the take is shown. The claim
       * holds the intent through delivery; only this ack forgets it, so a
       * crash before the ack replays instead of losing the take. Call it
       * once the item is applied; never call it after `release`.
       */
      acknowledge: () => Promise<void>;
    }
  | { status: 'empty' }
  | { status: 'failed' };

/**
 * Clear a delivered take's crash-recovery intent. Call after the take is
 * shown; a crash before this ack replays the take, a crash after it cannot
 * lose a take that was never shown. Failures leave the intent for replay
 * rather than risk losing an already-delivered take.
 */
export function acknowledgeHandoffDelivery(key: string): Promise<void> {
  return clearOutbox(key);
}

/**
 * Try to take the next queued take and say what happened. `failed` means the
 * take is still queued: its row survived, so showing it would bring it back on
 * the next run. A section uses this to report the attempt and to try again.
 * A `taken` claim holds its outbox intent until `acknowledge` runs — call it
 * after applying the item, never after `release`.
 */
export async function claimHandoff(target: HandoffTarget): Promise<HandoffClaim> {
  const claim = await claimStoredTake(target);
  if (claim.status === 'taken') {
    const entry = claim.entry;
    return {
      status: 'taken',
      item: entry.item,
      release: () => putBackHandoff(target, entry),
      acknowledge: () => acknowledgeHandoffDelivery(entry.key),
    };
  }
  return claim.status === 'failed' ? { status: 'failed' } : { status: 'empty' };
}

/**
 * Clear a delivered take's intent in the background, tracked so tests can
 * flush it. A refusal keeps the intent for replay; the take stays delivered.
 */
function scheduleOutboxClear(key: string): void {
  const work = clearOutbox(key).catch(() => {});
  pendingWork.add(work);
  void work.then(() => {
    pendingWork.delete(work);
  });
}

function claimQueued(target: HandoffTarget): Pending | null {
  const queue = pending.get(target);
  const entry = queue?.shift();
  if (!queue || !entry) return null;

  if (queue.length === 0) pending.delete(target);
  // Blocks a late hydration from reading the row back while the delete is in
  // flight.
  rememberConsumed(entry.key);
  queuesChanged();
  return entry;
}

/** Take one entry out of the queue by key, wherever it sits in it. */
function takeQueuedByKey(target: HandoffTarget, key: string): Pending | null {
  const queue = pending.get(target);
  if (!queue) return null;
  const index = queue.findIndex((entry) => entry.key === key);
  if (index < 0) return null;
  const [entry] = queue.splice(index, 1);
  if (queue.length === 0) pending.delete(target);
  // Blocks a late hydration from reading the row back while the delete is in
  // flight.
  rememberConsumed(entry.key);
  queuesChanged();
  return entry;
}

/**
 * Drop a hydrated take whose row is already gone — claimed or discarded by
 * another tab, or pruned — so this tab never replays its stale copy. The key
 * stays consumed so a late hydration cannot read it back.
 */
function dropStolen(target: HandoffTarget, key: string): void {
  const queue = pending.get(target);
  if (queue) {
    const index = queue.findIndex((entry) => entry.key === key);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) pending.delete(target);
  }
  // Gone elsewhere: remember durably so a stale row naming it never replays.
  rememberDelivered(key);
  clearFailed(key);
  dropOutbox(key);
  queuesChanged();
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
  // left in memory only. Until that put lands the row missing proves nothing,
  // so the take is unmarked as stored and claimed as before. The intent is
  // kept until the next delivery, so a crash before the put lands replays.
  entry.stored = false;
  void writeOutbox(target, entry);
  queuePut(entry.key, () =>
    store.put({ key: entry.key, target, at: entry.at, item: entry.item }).then(() => {
      entry.stored = true;
    }),
  );
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

  // Serialize with claims on the same take: a claim that verified the row
  // first must finish its delete before this discard deletes underneath it
  // (or vice versa), or the claim delivers a take the user just discarded.
  // A lock that will not grant leaves the take queued rather than race a
  // claim on its delete, so the panel can say why it is still listed.
  try {
    return await withClaimLock(key, async () => {
      const entry = pending.get(target)?.find((candidate) => candidate.key === key);
      // Claimed or discarded while the lock was waited for: nothing left.
      if (!entry) return false;

      // A stored take whose row is already gone was claimed or discarded by
      // another tab, or pruned: drop this tab's stale copy. The take is gone
      // either way, so the discard still counts — nothing here could deliver it.
      if (entry.stored) {
        let rows: HandoffRecord[] | null = null;
        try {
          rows = await store.list();
        } catch {
          rows = null;
        }
        if (rows && !rows.some((row) => row?.key === key)) {
          dropStolen(target, key);
          return true;
        }
      }

      try {
        // A delete that never answers counts as one that refused: the row is still
        // there, so the take stays queued and the panel says why it is still listed.
        await withinTimeout(removeStored(key), clearTimeoutMs);
        // The intent goes with the row: a stale outbox must never resurrect a
        // take the user just threw away. A refusal keeps the take queued.
        await clearOutbox(key);
      } catch {
        return false;
      }

      // The delete took a moment; the take may have been claimed while it ran, in
      // which case there is nothing left to take out of the queue.
      const current = pending.get(target);
      const index = current ? current.findIndex((entry) => entry.key === key) : -1;
      rememberDelivered(key);
      clearFailed(key);
      if (current && index >= 0) {
        current.splice(index, 1);
        if (current.length === 0) pending.delete(target);
      }
      queuesChanged();
      return true;
    });
  } catch {
    return false;
  }
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

    // Each take is deleted under its own cross-tab lock, like a single
    // discard: a concurrent claim on the same take serializes instead of
    // racing the delete, and the loser finds the row gone. The wait is capped
    // by what is left of the clear budget, so one stuck take cannot spend the
    // whole deadline — let alone hang the panel past it.
    let cleared: boolean;
    try {
      cleared = await withClaimLock(key, async () => {
        const entry = pending.get(target)?.find((candidate) => candidate.key === key);
        // Taken or discarded while the lock was waited for: nothing left.
        if (!entry) return true;

        // A stored take whose row is already gone was claimed or discarded
        // by another tab, or pruned: nothing to delete, and the sweep below
        // drops this tab's stale copy.
        if (entry.stored) {
          let rows: HandoffRecord[] | null = null;
          try {
            rows = await store.list();
          } catch {
            rows = null;
          }
          if (rows && !rows.some((row) => row?.key === key)) {
            dropOutbox(key);
            return true;
          }
        }

        const innerLeft = deadline - Date.now();
        if (innerLeft <= 0) return false;
        try {
          await withinTimeout(removeStored(key), innerLeft);
          await withinTimeout(outboxStore.remove(key), innerLeft);
          outboxInflight.delete(key);
        } catch {
          return false;
        }
        return true;
      }, Math.min(lockTimeoutMs, left));
    } catch {
      // The lock would not grant: leave the take queued rather than race a
      // claim on its delete, so the panel can say why it is still listed.
      cleared = false;
    }

    if (cleared) {
      rememberDelivered(key);
      clearFailed(key);
      dropOutbox(key);
      gone += 1;
    } else {
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
 * after it, and no later run hands it over again once its delivery is acked.
 *
 * The intent lands before the delete and is held until after delivery: a
 * crash between the row's delete and the ack replays the take on the next
 * run under the same row id (at-least-once), while a clean run acks and
 * never replays. A failed delete leaves the take queued for the next
 * attempt instead. The ack runs in the background once the item is handed
 * back, so a crash after cleanup can only follow a delivery — never replace
 * it. Flush writes to wait for a clean run's ack before reloading.
 */
export async function takeHandoff(target: HandoffTarget): Promise<HandoffItem | null> {
  const claim = await claimStoredTake(target);
  if (claim.status !== 'taken') return null;
  scheduleOutboxClear(claim.entry.key);
  return claim.entry.item;
}

/** Drop anything queued in memory. Used by tests between cases. */
export function clearHandoff(): void {
  pending.clear();
  consumed.clear();
  failedTakes.clear();
  outboxInflight.clear();
  claimingTargets.clear();
  hydration = null;
  putTails.clear();
  pendingWork.clear();
  queuesChanged();
}

/** A queued take that failed to open, for retry surfacing. */
export interface HandoffFailure {
  key: string;
  name: string;
  target: HandoffTarget;
  attempts: number;
  lastFailedAt: number;
}

/** Takes still queued after a failed open, oldest-failed first. */
export function handoffFailures(target?: HandoffTarget): HandoffFailure[] {
  const failures: HandoffFailure[] = [];
  for (const [key, failure] of failedTakes) {
    if (target && failure.target !== target) continue;
    if (!pending.get(failure.target)?.some((entry) => entry.key === key)) continue;
    failures.push({ key, ...failure });
  }
  return failures.sort((a, b) => a.lastFailedAt - b.lastFailedAt);
}

/** Bounded bookkeeping counts, for stuck-queue observability. */
export function handoffDiagnostics(): {
  queued: number;
  failed: number;
  consumed: number;
  pendingWrites: number;
  pendingKeys: number;
  outbox: number;
} {
  let queued = 0;
  for (const queue of pending.values()) queued += queue.length;
  return {
    queued,
    failed: failedTakes.size,
    consumed: consumed.size,
    pendingWrites: pendingWork.size,
    pendingKeys: putTails.size,
    outbox: outboxInflight.size,
  };
}
