// @vitest-environment node
// The MemoryStore double holds Blob references, so only a real IndexedDB
// proves stored audio survives byte-identical. fake-indexeddb stands in for
// the browser; the reload path (send, flush, drop memory, hydrate, take) is
// the production one. Node, not jsdom: its separate realm breaks the shim's
// binary cloning (Blob/ArrayBuffer come back as plain objects), while node
// exercises the same structured-clone semantics as a real browser.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHandoff,
  flushHandoffWrites,
  hydrateHandoff,
  sendHandoff,
  takeHandoff,
  type HandoffItem,
} from './handoff';
import {
  __closeHandoffDbForTests,
  indexedDbHandoffOutboxStore,
  indexedDbHandoffStore,
} from './handoffStore';
import type { HandoffRecord } from './handoffStore';

/** Deterministic pseudo-audio covering every byte value. */
function audioBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (state >>> 16) & 0xff;
  }
  return bytes;
}

describe('indexeddb v1 to v2 upgrade', () => {
  beforeEach(clearHandoff);

  afterEach(async () => {
    clearHandoff();
    await __closeHandoffDbForTests();
    for (const row of await indexedDbHandoffStore.list()) {
      await indexedDbHandoffStore.remove(row.key);
    }
    for (const row of await indexedDbHandoffOutboxStore.list()) {
      await indexedDbHandoffOutboxStore.remove(row.key);
    }
    await __closeHandoffDbForTests();
  });

  it('creates the outbox store without losing v1 pending rows', async () => {
    const bytes = audioBytes(256);
    const pending: HandoffRecord = {
      key: 'upgrade-pending-1',
      target: 'convert',
      at: Date.now(),
      item: { name: 'V1 take', blob: new Blob([bytes as unknown as BlobPart]), from: 'studio' },
    };

    // Start closed, drop whatever the round-trip test left, and build a v1
    // database with only the pending store — the shape before the outbox.
    await __closeHandoffDbForTests();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('chatter-box-handoff');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Could not delete the hand-off database'));
      request.onblocked = () => reject(new Error('Could not delete the hand-off database: blocked'));
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('chatter-box-handoff', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          try {
            db.close();
          } catch {
            // Already closed: the v2 open below still starts fresh.
          }
          resolve();
        };
        try {
          const put = db.transaction('pending', 'readwrite').objectStore('pending').put(pending);
          put.onsuccess = () => done();
          put.onerror = () => reject(put.error ?? new Error('Could not seed the v1 pending row'));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open the v1 hand-off database'));
      request.onblocked = () => reject(new Error('Could not open the v1 hand-off database: blocked'));
    });

    // Opening through the app upgrades to v2: the pending row survives and
    // the new outbox store exists and starts empty.
    const listed = await indexedDbHandoffStore.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: pending.key, target: pending.target });
    expect(listed[0].item.name).toBe('V1 take');
    expect(await indexedDbHandoffOutboxStore.list()).toEqual([]);

    // The upgraded database really has a writable outbox.
    const intent: HandoffRecord = {
      key: 'upgrade-intent-1',
      target: 'convert',
      at: Date.now(),
      item: { name: 'Intent take', blob: new Blob(['intent']) },
    };
    await indexedDbHandoffOutboxStore.put(intent);
    const intents = await indexedDbHandoffOutboxStore.list();
    expect(intents.map((row) => row.key)).toEqual([intent.key]);
    await indexedDbHandoffOutboxStore.remove(intent.key);
    expect(await indexedDbHandoffOutboxStore.list()).toEqual([]);

    // The v1 take is still there afterwards, not upgraded away.
    expect((await indexedDbHandoffStore.list()).map((row) => row.key)).toEqual([pending.key]);
  });
});

describe('indexeddb blob round-trip', () => {
  beforeEach(clearHandoff);

  afterEach(async () => {
    clearHandoff();
    for (const row of await indexedDbHandoffStore.list()) {
      await indexedDbHandoffStore.remove(row.key);
    }
  });

  it('returns stored Blob audio byte-identical with captions and duration intact', async () => {
    const bytes = audioBytes(8192);
    const item: HandoffItem = {
      name: 'Round-trip take',
      blob: new Blob([bytes as unknown as BlobPart], { type: 'audio/wav' }),
      duration: 12.5,
      captions: {
        srt: '1\n00:00:00,000 --> 00:00:01,000\nhello\n',
        vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n',
      },
      from: 'studio',
    };

    sendHandoff('convert', item);
    await flushHandoffWrites();

    // A reload: the in-memory queue is gone, the stored take is not.
    clearHandoff();
    await hydrateHandoff();

    const taken = await takeHandoff('convert');
    expect(taken).not.toBeNull();
    expect(taken!.name).toBe(item.name);
    expect(taken!.duration).toBe(item.duration);
    expect(taken!.captions).toEqual(item.captions);
    expect(taken!.from).toBe(item.from);
    expect(taken!.blob).toBeInstanceOf(Blob);
    expect(taken!.blob.type).toBe('audio/wav');
    expect(taken!.blob.size).toBe(bytes.length);
    const roundTripped = new Uint8Array(await taken!.blob.arrayBuffer());
    expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
  });
});
