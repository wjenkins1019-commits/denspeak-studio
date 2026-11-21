// @vitest-environment jsdom
// Queued takes are held per section, not in one slot for the whole app: a send
// to a second section before the first is opened must not drop the first take.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHandoff,
  currentSection,
  returnTake,
  sendHandoff,
  setHandoffStore,
  subscribeHandoff,
  takeHandoff,
  hydrateHandoff,
  pendingCount,
  pendingCounts,
  subscribeQueues,
  HANDOFF_MAX_AGE_MS,
  HANDOFF_MAX_STORED,
  HANDOFF_TARGETS,
  type HandoffItem,
  type HandoffTarget,
} from './handoff';
import type { HandoffRecord, HandoffStore } from './handoffStore';

const item = { name: 'A take', blob: new Blob(['audio']), from: 'convert' as const };

describe('handoff', () => {
  beforeEach(clearHandoff);

  it('gives the queued take to its target once', () => {
    sendHandoff('convert', item);

    expect(takeHandoff('convert')).toEqual(item);
    expect(takeHandoff('convert')).toBeNull();
  });

  it('leaves a take queued for another section alone', () => {
    sendHandoff('transcribe', item);

    expect(takeHandoff('process')).toBeNull();
    expect(takeHandoff('transcribe')).toEqual(item);
  });

  it('returns nothing when nothing is queued', () => {
    expect(takeHandoff('song')).toBeNull();
  });

  it('holds a take for each section, so a second send cannot overwrite the first', () => {
    sendHandoff('convert', item);
    sendHandoff('transcribe', { ...item, name: 'Another take' });

    expect(takeHandoff('transcribe')).toMatchObject({ name: 'Another take' });
    // The take sent first was still waiting for its own section.
    expect(takeHandoff('convert')).toEqual(item);
  });

  it('holds more than one take for the same section, oldest first', () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });

    expect(takeHandoff('convert')).toEqual(item);
    expect(takeHandoff('convert')).toMatchObject({ name: 'Second take' });
    expect(takeHandoff('convert')).toBeNull();
  });

  it('hands a section one queued take per visit, leaving the rest waiting', () => {
    sendHandoff('song', item);
    sendHandoff('song', { ...item, name: 'Second take' });
    const seen: string[] = [];

    const stop = subscribeHandoff('song', (handed) => seen.push(handed.name));
    stop();

    expect(seen).toEqual(['A take']);
    // Not discarded: the next visit still has it rather than an empty section.
    expect(takeHandoff('song')).toMatchObject({ name: 'Second take' });
  });

  it('hands a take straight to the section that is already open', () => {
    const seen: string[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed.name));

    sendHandoff('convert', item);
    stop();

    expect(seen).toEqual(['A take']);
    expect(takeHandoff('convert')).toBeNull();
  });

  it('joins without taking when asked to, and still receives a take sent while open', () => {
    sendHandoff('song', item);
    const seen: string[] = [];

    const stop = subscribeHandoff('song', (handed) => seen.push(handed.name), { take: false });

    // Nothing queued was handed over just by joining.
    expect(seen).toEqual([]);
    expect(pendingCount('song')).toBe(1);

    // A take sent to the open section still arrives, without waiting for a
    // remount.
    sendHandoff('song', { ...item, name: 'Second take' });
    stop();

    expect(seen).toEqual(['Second take']);
    // The queued take is still the next visit's, not a second delivery.
    expect(pendingCount('song')).toBe(1);
    expect(takeHandoff('song')).toEqual(item);
  });

  it('queues again once the section has closed', () => {
    const stop = subscribeHandoff('song', () => {});
    stop();

    sendHandoff('song', item);

    expect(takeHandoff('song')).toEqual(item);
  });

  it('gives a take queued before the section opened to its first subscriber', () => {
    sendHandoff('song', item);
    const seen: string[] = [];

    const stop = subscribeHandoff('song', (handed) => seen.push(handed.name));
    stop();

    expect(seen).toEqual(['A take']);
    expect(takeHandoff('song')).toBeNull();
  });

  it('keeps a section out of another section’s take', () => {
    const seen: string[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed.name));

    sendHandoff('process', item);
    stop();

    expect(seen).toEqual([]);
    expect(takeHandoff('process')).toEqual(item);
  });
});

describe('currentSection', () => {
  it('reads the section off the route', () => {
    window.history.replaceState(null, '', '#/process');

    expect(currentSection()).toBe('process');
  });

  it('answers null for a route that is not a hand-off section', () => {
    window.history.replaceState(null, '', '#/voices');

    expect(currentSection()).toBeNull();
  });
});

describe('returnTake', () => {
  beforeEach(() => {
    clearHandoff();
    window.history.replaceState(null, '', '#/song');
  });

  it('opens the sender with the take it sent', () => {
    returnTake('convert', item);

    expect(window.location.hash).toBe('#/convert');
    // Marked, so the sender's notice can tell a returned take from a new one.
    expect(takeHandoff('convert')).toEqual({ ...item, returned: true });
  });

  it('carries the take back into the Studio, which can receive one', () => {
    returnTake('studio', item);

    expect(window.location.hash).toBe('#/studio');
    expect(takeHandoff('studio')).toEqual({ ...item, returned: true });
  });

  it('only opens a section that keeps its own work', () => {
    returnTake('library', item);

    expect(window.location.hash).toBe('#/library');
    // Library holds its takes in the database, so nothing needs carrying.
    for (const { target } of HANDOFF_TARGETS) expect(takeHandoff(target)).toBeNull();
  });
});

/** The durable half of the queue, in memory so a reload can be simulated. */
class MemoryStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();
  /** How many times the queue has been read back, for the duplicate check. */
  lists = 0;

  async list(): Promise<HandoffRecord[]> {
    this.lists += 1;
    return [...this.rows.values()].sort((a, b) => a.at - b.at);
  }

  async put(record: HandoffRecord): Promise<void> {
    this.rows.set(record.key, record);
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

describe('durable queue', () => {
  const store = new MemoryStore();

  beforeEach(() => {
    store.rows.clear();
    store.lists = 0;
    setHandoffStore(store);
    clearHandoff();
  });

  afterEach(() => {
    setHandoffStore(null);
    clearHandoff();
  });

  it('brings back a take that was still waiting when the app reloaded', async () => {
    sendHandoff('convert', item);
    await vi.waitFor(() => expect(store.rows.size).toBe(1));

    // A reload: the in-memory queue is gone, the stored take is not.
    clearHandoff();
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stop();

    expect(seen[0]).toEqual(item);
    // Taken once, so the next load starts empty instead of replaying it.
    await vi.waitFor(() => expect(store.rows.size).toBe(0));
  });

  it('stores nothing for a section that is open, which takes the take directly', async () => {
    const stop = subscribeHandoff('song', () => {});

    sendHandoff('song', item);
    await Promise.resolve();
    stop();

    expect(store.rows.size).toBe(0);
  });

  it('does not add a stored row for a take that is still queued in memory', async () => {
    sendHandoff('convert', item);
    await vi.waitFor(() => expect(store.rows.size).toBe(1));

    // Sending also prunes storage, which reads it back once.
    await vi.waitFor(() => expect(store.lists).toBe(1));

    // Another section opening reads the store back. Convert's take has only
    // been sent, not taken, so its row is still there and must be recognised
    // as the take already waiting in memory.
    const stopEmpty = subscribeHandoff('process', () => {});
    await vi.waitFor(() => expect(store.lists).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopEmpty();

    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    stop();

    expect(seen).toEqual([item]);
    // A duplicate would sit here and arrive again on the next visit.
    expect(takeHandoff('convert')).toBeNull();
  });

  it('hands stored takes over oldest first, one per visit', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    await vi.waitFor(() => expect(store.rows.size).toBe(2));

    clearHandoff();
    const names: string[] = [];
    const stop = subscribeHandoff('convert', (handed) => names.push(handed.name));

    await vi.waitFor(() => expect(names).toHaveLength(1));
    stop();

    expect(names).toEqual(['A take']);
  });

  it('counts how many takes are still waiting for a section', () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });

    expect(pendingCount('convert')).toBe(2);
    takeHandoff('convert');
    expect(pendingCount('convert')).toBe(1);
    expect(pendingCount('song')).toBe(0);
  });

  it('drops a stored take nobody opened within the week', async () => {
    sendHandoff('convert', item);
    await vi.waitFor(() => expect(store.rows.size).toBe(1));

    for (const row of store.rows.values()) row.at = Date.now() - HANDOFF_MAX_AGE_MS - 1000;

    clearHandoff();
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    await vi.waitFor(() => expect(store.rows.size).toBe(0));
    stop();

    // Stale audio is not handed over a week late; the row is gone with it.
    expect(seen).toEqual([]);
  });

  it('keeps only a section’s newest takes on disk', async () => {
    for (let index = 0; index <= HANDOFF_MAX_STORED + 2; index += 1) {
      sendHandoff('convert', { ...item, name: `Take ${index}` });
    }
    await vi.waitFor(() => expect(store.rows.size).toBe(HANDOFF_MAX_STORED));

    const names = [...store.rows.values()]
      .sort((a, b) => a.at - b.at)
      .map((row) => row.item.name);
    expect(names[0]).toBe('Take 3');
    expect(names[names.length - 1]).toBe(`Take ${HANDOFF_MAX_STORED + 2}`);
    // Only storage is bounded: the session still holds every take it queued.
    expect(pendingCount('convert')).toBe(HANDOFF_MAX_STORED + 3);
  });

  it('counts the takes waiting for each section', () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    sendHandoff('song', { ...item, name: 'Beat take' });

    expect(pendingCounts()).toEqual({ convert: 2, song: 1 });

    takeHandoff('convert');
    expect(pendingCounts()).toEqual({ convert: 1, song: 1 });
  });

  it('tells the rail after every change, so its count never lags', () => {
    const seen: Array<Partial<Record<HandoffTarget, number>>> = [];
    const stop = subscribeQueues(() => seen.push(pendingCounts()));

    sendHandoff('song', item);
    takeHandoff('song');
    stop();

    expect(seen).toEqual([{ song: 1 }, {}]);
  });

  it('counts takes an earlier run left before that section is opened', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    await vi.waitFor(() => expect(store.rows.size).toBe(2));

    // A reload: the queues are empty until the store is asked.
    clearHandoff();
    expect(pendingCounts()).toEqual({});

    await hydrateHandoff();

    expect(pendingCounts()).toEqual({ convert: 2 });
  });
});
