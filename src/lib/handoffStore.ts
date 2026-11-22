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
const DB_VERSION = 1;
const STORE = 'pending';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
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
      return rows.sort((a, b) => a.at - b.at);
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
