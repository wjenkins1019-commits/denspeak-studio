// Durable storage for takes that were sent but never opened.
//
// A queued take used to live only in module state, so a reload — or closing the
// app with a take still waiting for a section — dropped its audio with no undo.
// The queue itself stays in `handoff.ts`; this keeps the same takes on disk so
// the next run can put them back in front of anything queued since.
import type { HandoffItem, HandoffTarget } from './handoff';

export interface HandoffRecord {
  /** Row id, kept with the in-memory queue entry so taking a take can delete it. */
  key: string;
  target: HandoffTarget;
  /** When it was sent; the oldest take is handed over first. */
  at: number;
  item: HandoffItem;
}

/**
 * What `handoff.ts` needs from storage. Tests hand in an in-memory one, the
 * same way the project store takes a `StorageLike`.
 */
export interface HandoffStore {
  list(): Promise<HandoffRecord[]>;
  put(record: HandoffRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

const DB_NAME = 'chatter-box-handoff';
const DB_VERSION = 2;
const STORE = 'pending';
/** In-flight takes: written before the main row is deleted, held until after the delivery ack. */
const OUTBOX_STORE = 'outbox';

/**
 * Entries read back may include values no section wrote. Drop what cannot be
 * a row at all, and sort tolerantly, so one malformed entry cannot throw the
 * whole read away and hide every valid take. Finer validation lives with the
 * queue, which quarantines bad rows by key.
 */
export function orderListedRows(rows: HandoffRecord[]): HandoffRecord[] {
  return rows
    .filter((row) => !!row && typeof row === 'object')
    .sort((a, b) => (typeof a.at === 'number' ? a.at : 0) - (typeof b.at === 'number' ? b.at : 0));
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Test-only: drop the cached connection so the next store call re-opens the
 * database. Lets the v1-to-v2 upgrade test start from a closed v1 without
 * sharing the round-trip test's already-open v2 handle.
 */
export function __closeHandoffDbForTests(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return Promise.resolve();
  return pending.then(
    (db) => {
      try {
        db.close();
      } catch {
        // Already closed: the next open still starts fresh.
      }
    },
    () => {},
  );
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the hand-off store'));
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Hand-off store request failed'));
  });
}

/** jsdom and private windows have no IndexedDB; the hand-off still works. */
function hasDatabase(): boolean {
  return typeof indexedDB !== 'undefined';
}

export const indexedDbHandoffStore: HandoffStore = {
  async list(): Promise<HandoffRecord[]> {
    if (!hasDatabase()) return [];
    try {
      const db = await openDb();
      const rows = await requestToPromise(
        db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<HandoffRecord[]>,
      );
      return orderListedRows(rows);
    } catch {
      return [];
    }
  },

  async put(record: HandoffRecord): Promise<void> {
    // Left to throw on purpose: a take counts as stored only once its put
    // lands, so a failure must leave it unmarked — the take stays queued in
    // memory for this run and its row missing proves nothing about another tab.
    if (!hasDatabase()) throw new Error('Hand-off store unavailable');
    const db = await openDb();
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
  },

  async remove(key: string): Promise<void> {
    // No database means no row that could come back.
    if (!hasDatabase()) return;
    // Left to throw on purpose: taking a take waits for this delete, and a
    // failure has to stay queued rather than arrive again on the next run.
    const db = await openDb();
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
  },
};

/**
 * Crash-recovery outbox: an intent written before the main row is deleted and
 * held until after the take's delivery is acked. A crash between the delete
 * and the ack leaves the intent on disk, so the next run can re-queue the
 * take instead of losing it — a crash after the ack can only follow a
 * delivery, never replace it. Replays use the same row id, so reading the
 * outbox twice never queues two copies — and a take whose main row survived
 * needs no replay.
 */
export const indexedDbHandoffOutboxStore: HandoffStore = {
  async list(): Promise<HandoffRecord[]> {
    if (!hasDatabase()) return [];
    try {
      const db = await openDb();
      const rows = await requestToPromise(
        db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).getAll() as IDBRequest<
          HandoffRecord[]
        >,
      );
      return orderListedRows(rows);
    } catch {
      return [];
    }
  },

  async put(record: HandoffRecord): Promise<void> {
    // Best-effort by callers: when the outbox will not take the intent the
    // claim falls back to delete-before-handover rather than wedge the queue.
    if (!hasDatabase()) throw new Error('Hand-off outbox unavailable');
    const db = await openDb();
    await requestToPromise(db.transaction(OUTBOX_STORE, 'readwrite').objectStore(OUTBOX_STORE).put(record));
  },

  async remove(key: string): Promise<void> {
    // No database means no intent that could replay.
    if (!hasDatabase()) return;
    // Left to throw on purpose: a take is delivered only once its intent is
    // gone, so a refusal keeps the take queued for another try instead of
    // risking a replayed duplicate on the next run.
    const db = await openDb();
    await requestToPromise(db.transaction(OUTBOX_STORE, 'readwrite').objectStore(OUTBOX_STORE).delete(key));
  },
};
