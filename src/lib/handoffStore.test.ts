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
import { indexedDbHandoffStore } from './handoffStore';

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
