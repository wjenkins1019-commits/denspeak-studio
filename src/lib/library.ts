// Take library: rendered narrations and converted recordings, stored in
// IndexedDB with the WAV blob alongside its metadata.
export interface Take {
  id: string;
  name: string;
  createdAt: number;
  /** Length in seconds. */
  duration: number;
  kind: 'render' | 'convert' | 'processed' | 'song';
  voiceId?: string;
  voiceName?: string;
  /** Fingerprint of text + settings + voice; lets a reloaded queue recognise
   * the take an interrupted job already saved instead of rendering it twice. */
  sourceHash?: string;
  /**
   * Captions timed from the synthesis itself: exact script words on the real
   * block spans. Absent on older takes and non-render kinds, which fall back
   * to transcribing the audio.
   */
  captions?: { srt: string; vtt: string };
  blob: Blob;
}

export type NewTake = Omit<Take, 'id' | 'createdAt'>;

const DB_NAME = 'chatter-box';
const DB_VERSION = 1;
const STORE = 'takes';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the library'));
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Library request failed'));
  });
}

export async function listTakes(): Promise<Take[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const takes = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<Take[]>);
  return takes.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveTake(input: NewTake): Promise<Take> {
  const db = await openDb();
  const take: Take = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  const tx = db.transaction(STORE, 'readwrite');
  await requestToPromise(tx.objectStore(STORE).put(take));
  return take;
}

/**
 * Attach captions heard later to a take that was saved without them: a
 * successful Whisper fallback in the Player lands here, so the take
 * re-exports SRT/VTT offline from then on. Takes are schemaless rows, so
 * older entries simply gain the field.
 */
export async function updateTakeCaptions(
  id: string,
  captions: { srt: string; vtt: string },
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const take = await requestToPromise(store.get(id) as IDBRequest<Take | undefined>);
  if (!take) return;
  await requestToPromise(store.put({ ...take, captions }));
}

export async function getTake(id: string): Promise<Take | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  return requestToPromise(tx.objectStore(STORE).get(id) as IDBRequest<Take | undefined>);
}

export async function deleteTake(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await requestToPromise(tx.objectStore(STORE).delete(id));
}

export async function clearTakes(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await requestToPromise(tx.objectStore(STORE).clear());
}
