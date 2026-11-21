// Crash-safe persistence for the render queue.
//
// Two kinds of state survive a reload here, both in one IndexedDB database:
//   - job descriptors (small records with the full text, so a reloaded job
//     renders exactly what it was rendering, not the current script draft),
//   - per-block PCM checkpoints for the working job, so a reloaded job skips
//     paragraphs it already finished instead of rendering from zero,
//   - the audiobook behind the card, so chapter state restores with the jobs.
//
// Everything is keyed by stable job ids (`job-<time>-<random>`), so ids never
// collide across sessions. All writes are write-through and best-effort: if
// storage is unavailable the queue simply behaves as before, memory-only.
import type { NarrationSettings } from './narrate';
import type { ParsedBook } from './ebook';

/**
 * Bump whenever the render chain changes the audio it produces. The
 * fingerprint is what lets a finished take (or a checkpointed paragraph) be
 * adopted instead of re-rendered, so without this a take saved by an older
 * chain would be handed back as "this exact render" and the change would never
 * be heard. Version 2: the per-phrase shaping resamples instead of running the
 * phase vocoder twice.
 */
export const RENDER_CHAIN_VERSION = 2;

/** FNV-1a over chain version + text + settings + voice: one exact render. */
export function jobFingerprint(input: {
  text: string;
  settings: NarrationSettings;
  voiceId: string;
}): string {
  const payload = `${RENDER_CHAIN_VERSION}\n${input.voiceId}\n${JSON.stringify(input.settings)}\n${input.text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface PersistedJob {
  id: string;
  group: string;
  chapterIndex: number;
  label: string;
  takeName: string;
  text: string;
  settings: NarrationSettings;
  voiceId: string;
  voiceName?: string;
  /** Fingerprint of text + settings + voice, for matching takes and blocks. */
  sourceHash: string;
  state: 'queued' | 'working' | 'failed' | 'done';
  /** Library id of the saved take, so a restored 'done' rehydrates exactly it. */
  takeId?: string;
  error?: string;
  block: number;
  blocks: number;
  status: string;
  cancelRequested: boolean;
}

export interface CheckpointRecord {
  key: string;
  jobId: string;
  index: number;
  fingerprint: string;
  samples: Float32Array;
  sampleRate: number;
}

export interface PersistedAudiobook {
  key: 'current';
  title: string;
  book: ParsedBook;
}

const DB_NAME = 'denspeak-render-queue';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openQueueDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('checkpoints')) {
        const store = db.createObjectStore('checkpoints', { keyPath: 'key' });
        store.createIndex('jobId', 'jobId');
      }
      if (!db.objectStoreNames.contains('audiobook')) {
        db.createObjectStore('audiobook', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the render queue'));
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Queue storage request failed'));
  });
}

/** Persistence is best-effort: storage failure must never break rendering. */
async function attempt(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Memory-only fallback; the queue keeps working for this session.
  }
}

export function checkpointKey(jobId: string, index: number): string {
  return `${jobId}:${index}`;
}

export function saveJob(job: PersistedJob): Promise<void> {
  return attempt(async () => {
    const db = await openQueueDb();
    const tx = db.transaction('jobs', 'readwrite');
    await requestToPromise(tx.objectStore('jobs').put(job));
  });
}

export function deleteJob(id: string): Promise<void> {
  return attempt(async () => {
    const db = await openQueueDb();
    const tx = db.transaction('jobs', 'readwrite');
    await requestToPromise(tx.objectStore('jobs').delete(id));
  });
}

export function loadJobs(): Promise<PersistedJob[]> {
  return openQueueDb().then(async (db) => {
    const tx = db.transaction('jobs', 'readonly');
    return requestToPromise(tx.objectStore('jobs').getAll() as IDBRequest<PersistedJob[]>);
  });
}

export function saveCheckpoint(record: CheckpointRecord): Promise<void> {
  return attempt(async () => {
    const db = await openQueueDb();
    const tx = db.transaction('checkpoints', 'readwrite');
    await requestToPromise(tx.objectStore('checkpoints').put(record));
  });
}

export function loadCheckpoints(jobId: string): Promise<CheckpointRecord[]> {
  return openQueueDb().then(async (db) => {
    const tx = db.transaction('checkpoints', 'readonly');
    const index = tx.objectStore('checkpoints').index('jobId');
    return requestToPromise(index.getAll(jobId) as IDBRequest<CheckpointRecord[]>);
  });
}

/** Drop checkpoints for jobs that are no longer around to claim them. */
export function deleteCheckpointsNotIn(live: Set<string>): Promise<void> {
  return attempt(async () => {
    const db = await openQueueDb();
    const tx = db.transaction('checkpoints', 'readwrite');
    const store = tx.objectStore('checkpoints');
    const jobIds = await requestToPromise(store.index('jobId').getAllKeys());
    const seen = new Set<string>();
    for (const jobId of jobIds) {
      const id = String(jobId);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!live.has(id)) {
        const keys = await requestToPromise(store.index('jobId').getAllKeys(id));
        for (const key of keys) await requestToPromise(store.delete(key));
      }
    }
  });
}

export function deleteCheckpoints(jobId: string): Promise<void> {
  return attempt(async () => {
    const db = await openQueueDb();
    const tx = db.transaction('checkpoints', 'readwrite');
    const store = tx.objectStore('checkpoints');
    const keys = await requestToPromise(store.index('jobId').getAllKeys(jobId));
    for (const key of keys) await requestToPromise(store.delete(key));
  });
}

export function saveAudiobook(next: { title: string; book: ParsedBook } | null): Promise<void> {
  return attempt(async () => {
    const db = await openQueueDb();
    const tx = db.transaction('audiobook', 'readwrite');
    const store = tx.objectStore('audiobook');
    if (next) {
      const record: PersistedAudiobook = { key: 'current', title: next.title, book: next.book };
      await requestToPromise(store.put(record));
    } else {
      await requestToPromise(store.delete('current'));
    }
  });
}

export function loadAudiobook(): Promise<{ title: string; book: ParsedBook } | null> {
  return openQueueDb()
    .then(async (db) => {
      const tx = db.transaction('audiobook', 'readonly');
      const record = await requestToPromise(
        tx.objectStore('audiobook').get('current') as IDBRequest<PersistedAudiobook | undefined>,
      );
      return record ? { title: record.title, book: record.book } : null;
    })
    .catch(() => null);
}
