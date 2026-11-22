// @vitest-environment jsdom
// Queued takes are held per section, not in one slot for the whole app: a send
// to a second section before the first is opened must not drop the first take.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimHandoff,
  clearHandoff,
  currentSection,
  returnTake,
  sendHandoff,
  setHandoffStore,
  setLockTimeout,
  subscribeHandoff,
  takeHandoff,
  hydrateHandoff,
  pendingCount,
  pendingCounts,
  subscribeQueues,
  queuedTakes,
  discardHandoff,
  discardHandoffQueue,
  flushHandoffWrites,
  HANDOFF_MAX_AGE_MS,
  HANDOFF_MAX_STORED,
  HANDOFF_TARGETS,
  type HandoffItem,
  type HandoffTarget,
} from './handoff';
import type { HandoffRecord, HandoffStore } from './handoffStore';
import { orderListedRows } from './handoffStore';

const item = { name: 'A take', blob: new Blob(['audio']), from: 'convert' as const };

describe('handoff', () => {
  beforeEach(clearHandoff);

  it('gives the queued take to its target once', async () => {
    sendHandoff('convert', item);

    expect(await takeHandoff('convert')).toEqual(item);
    expect(await takeHandoff('convert')).toBeNull();
  });

  it('leaves a take queued for another section alone', async () => {
    sendHandoff('transcribe', item);

    expect(await takeHandoff('process')).toBeNull();
    expect(await takeHandoff('transcribe')).toEqual(item);
  });

  it('returns nothing when nothing is queued', async () => {
    expect(await takeHandoff('song')).toBeNull();
  });

  it('holds a take for each section, so a second send cannot overwrite the first', async () => {
    sendHandoff('convert', item);
    sendHandoff('transcribe', { ...item, name: 'Another take' });

    expect(await takeHandoff('transcribe')).toMatchObject({ name: 'Another take' });
    // The take sent first was still waiting for its own section.
    expect(await takeHandoff('convert')).toEqual(item);
  });

  it('holds more than one take for the same section, oldest first', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });

    expect(await takeHandoff('convert')).toEqual(item);
    expect(await takeHandoff('convert')).toMatchObject({ name: 'Second take' });
    expect(await takeHandoff('convert')).toBeNull();
  });

  it('hands a section one queued take per visit, leaving the rest waiting', async () => {
    sendHandoff('song', item);
    sendHandoff('song', { ...item, name: 'Second take' });
    const seen: string[] = [];

    const stop = subscribeHandoff('song', (handed) => seen.push(handed.name));
    await vi.waitFor(() => expect(seen).toEqual(['A take']));
    stop();

    // Not discarded: the next visit still has it rather than an empty section.
    expect(await takeHandoff('song')).toMatchObject({ name: 'Second take' });
  });

  it('hands a take straight to the section that is already open', async () => {
    const seen: string[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed.name));

    sendHandoff('convert', item);
    stop();

    expect(seen).toEqual(['A take']);
    expect(await takeHandoff('convert')).toBeNull();
  });

  it('joins without taking when asked to, and still receives a take sent while open', async () => {
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
    expect(await takeHandoff('song')).toEqual(item);
  });

  it('queues again once the section has closed', async () => {
    const stop = subscribeHandoff('song', () => {});
    stop();

    sendHandoff('song', item);

    expect(await takeHandoff('song')).toEqual(item);
  });

  it('gives a take queued before the section opened to its first subscriber', async () => {
    sendHandoff('song', item);
    const seen: string[] = [];

    const stop = subscribeHandoff('song', (handed) => seen.push(handed.name));
    await vi.waitFor(() => expect(seen).toEqual(['A take']));
    stop();

    expect(await takeHandoff('song')).toBeNull();
  });

  it('lists a section’s queue oldest first without taking anything', () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take', duration: 9, from: 'studio' });

    expect(queuedTakes('convert').map((take) => take.name)).toEqual(['A take', 'Second take']);
    expect(queuedTakes('convert')[1]).toMatchObject({ duration: 9, from: 'studio' });
    // Looking is not taking: both are still queued for a later visit.
    expect(pendingCount('convert')).toBe(2);
  });

  it('discards one queued take and leaves the rest', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    const [oldest] = queuedTakes('convert');

    expect(await discardHandoff('convert', oldest.key)).toBe(true);

    expect(queuedTakes('convert').map((take) => take.name)).toEqual(['Second take']);
    expect(pendingCount('convert')).toBe(1);
    // A key that is gone is not silently discarded twice.
    expect(await discardHandoff('convert', oldest.key)).toBe(false);
    expect(await takeHandoff('convert')).toMatchObject({ name: 'Second take' });
  });

  it('clears a section’s queue without touching another section', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    sendHandoff('song', { ...item, name: 'Beat take' });

    expect(await discardHandoffQueue('convert')).toBe(2);
    expect(pendingCount('convert')).toBe(0);
    expect(pendingCount('song')).toBe(1);
    expect(await discardHandoffQueue('convert')).toBe(0);
  });

  it('keeps a section out of another section’s take', async () => {
    const seen: string[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed.name));

    sendHandoff('process', item);
    stop();

    expect(seen).toEqual([]);
    expect(await takeHandoff('process')).toEqual(item);
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

  it('opens the sender with the take it sent', async () => {
    returnTake('convert', item);

    expect(window.location.hash).toBe('#/convert');
    // Marked, so the sender's notice can tell a returned take from a new one.
    expect(await takeHandoff('convert')).toEqual({ ...item, returned: true });
  });

  it('carries the take back into the Studio, which can receive one', async () => {
    returnTake('studio', item);

    expect(window.location.hash).toBe('#/studio');
    expect(await takeHandoff('studio')).toEqual({ ...item, returned: true });
  });

  it('only opens a section that keeps its own work', async () => {
    returnTake('library', item);

    expect(window.location.hash).toBe('#/library');
    // Library holds its takes in the database, so nothing needs carrying.
    for (const { target } of HANDOFF_TARGETS) expect(await takeHandoff(target)).toBeNull();
  });
});

/** The durable half of the queue, in memory so a reload can be simulated. */
class MemoryStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();
  /** How many times the queue has been read back, for the duplicate check. */
  lists = 0;

  async list(): Promise<HandoffRecord[]> {
    this.lists += 1;
    // Mirrors the real store's contract: entries no section wrote cannot
    // throw the whole read away.
    return orderListedRows([...this.rows.values()]);
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
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    // A reload: the in-memory queue is gone, the stored take is not.
    clearHandoff();
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stop();

    expect(seen[0]).toEqual(item);
    // Taken once, so the next load starts empty instead of replaying it: the
    // take is delivered only after its row is gone.
    expect(store.rows.size).toBe(0);
  });

  it('does not bring back a take that was discarded', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const [queued] = queuedTakes('convert');
    expect(await discardHandoff('convert', queued.key)).toBe(true);
    expect(store.rows.size).toBe(0);

    // A reload starts with nothing, not with the discarded audio.
    clearHandoff();
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    await hydrateHandoff();
    stop();

    expect(seen).toEqual([]);
  });

  it('does not bring back a queue that was cleared', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    await flushHandoffWrites();
    expect(store.rows.size).toBe(2);

    expect(await discardHandoffQueue('convert')).toBe(2);
    expect(store.rows.size).toBe(0);

    clearHandoff();
    await hydrateHandoff();

    expect(queuedTakes('convert')).toEqual([]);
  });

  it('keeps a discarded take queued when its row will not go', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);
    const [queued] = queuedTakes('convert');

    const remove = store.remove.bind(store);
    store.remove = vi.fn(async () => {
      throw new Error('delete failed');
    });

    // Not discarded: the row would bring it back next run, so it stays visible.
    expect(await discardHandoff('convert', queued.key)).toBe(false);
    expect(queuedTakes('convert').map((take) => take.name)).toEqual(['A take']);
    expect(store.rows.size).toBe(1);

    store.remove = remove;
    expect(await discardHandoff('convert', queued.key)).toBe(true);
    expect(pendingCount('convert')).toBe(0);
    expect(store.rows.size).toBe(0);

    // Nothing left for a reload to bring back.
    clearHandoff();
    await hydrateHandoff();
    expect(queuedTakes('convert')).toEqual([]);
  });

  it('clears only the takes whose rows went', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    await flushHandoffWrites();
    expect(store.rows.size).toBe(2);

    const [first] = queuedTakes('convert');
    const remove = store.remove.bind(store);
    store.remove = vi.fn(async (key: string) => {
      if (key === first.key) throw new Error('delete failed');
      await remove(key);
    });

    expect(await discardHandoffQueue('convert')).toBe(1);
    // The one that would not go is still queued and still stored, so the clear
    // cannot report it gone and let it arrive on the next run.
    expect(queuedTakes('convert').map((take) => take.name)).toEqual(['A take']);
    expect(store.rows.size).toBe(1);

    store.remove = remove;
    expect(await discardHandoffQueue('convert')).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  it('does not orphan a row when a take is claimed before its put lands', async () => {
    // Hold the send's put so the claim's delete wins the race outright.
    let releasePut = () => {};
    const put = store.put.bind(store);
    store.put = (record: HandoffRecord) =>
      new Promise<void>((resolve) => {
        releasePut = () => {
          void put(record).then(() => resolve());
        };
      });

    sendHandoff('convert', item);
    const taken = takeHandoff('convert');
    // Let the in-flight delete win against the queued put.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePut();
    expect(await taken).toEqual(item);
    store.put = put;

    // No orphan row survived the race...
    expect(store.rows.size).toBe(0);
    // ...so a reload never delivers it twice.
    clearHandoff();
    await hydrateHandoff();
    expect(pendingCount('convert')).toBe(0);
    expect(await takeHandoff('convert')).toBeNull();
  });

  it('does not deliver a stored take another tab claimed first', async () => {
    // Two tabs open on the same section share the row, not the queue: this
    // tab hydrated it, then the other tab took it — the row is gone while
    // this tab's copy is still queued. Only the winner may deliver it.
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    holder.locks = {
      request: (_name: string, work: () => Promise<unknown>) => work(),
    };
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();
      expect(store.rows.size).toBe(1);

      // A reload in this tab hydrates the stored row...
      clearHandoff();
      await hydrateHandoff();
      expect(pendingCount('convert')).toBe(1);

      // ...then the other tab takes it: the row is gone, this copy is stale.
      const [row] = [...store.rows.keys()];
      await store.remove(row);
      expect(store.rows.size).toBe(0);

      // Exactly once means the loser hands over nothing and drops its stale
      // copy instead of replaying it on a later visit.
      expect(await takeHandoff('convert')).toBeNull();
      expect(pendingCount('convert')).toBe(0);

      clearHandoff();
      await hydrateHandoff();
      expect(pendingCount('convert')).toBe(0);
      expect(await takeHandoff('convert')).toBeNull();
    } finally {
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('delivers a stored take no other tab claimed', async () => {
    // The guard above must not swallow a take nobody else took: the row is
    // still there, so this tab hands it over as before.
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    holder.locks = {
      request: (_name: string, work: () => Promise<unknown>) => work(),
    };
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();

      clearHandoff();
      await hydrateHandoff();

      expect(await takeHandoff('convert')).toEqual(item);
      expect(store.rows.size).toBe(0);
    } finally {
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('does not deliver a locally-sent take another tab claimed first, once its put landed', async () => {
    // The sender-tab residual: this tab sent the take (not hydrated), its
    // put landed, then the other tab took it — the row is gone while this
    // tab's copy is still queued. Once the put is known on disk the sender
    // can verify the row inside the claim lock like a hydrated take, so
    // only the winner delivers it.
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    holder.locks = {
      request: (_name: string, work: () => Promise<unknown>) => work(),
    };
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();
      expect(store.rows.size).toBe(1);

      // The other tab takes it: the row is gone, this copy is stale.
      const [row] = [...store.rows.keys()];
      await store.remove(row);
      expect(store.rows.size).toBe(0);

      expect(await takeHandoff('convert')).toBeNull();
      expect(pendingCount('convert')).toBe(0);
    } finally {
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('holds the per-take lock when discarding one take', async () => {
    // Discards must serialize with claims on the same take: a claim that
    // verified the row first must finish its delete before a discard deletes
    // underneath it, or the claim delivers a take the user just discarded.
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    const requested: string[] = [];
    holder.locks = {
      request: (name: string, work: () => Promise<unknown>) => {
        requested.push(name);
        return work();
      },
    };
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();
      const [queued] = queuedTakes('convert');

      expect(await discardHandoff('convert', queued.key)).toBe(true);
      expect(requested).toContain(`chatter-box-handoff-take-${queued.key}`);
    } finally {
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('holds the per-take lock for every take a clear removes', async () => {
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    const requested: string[] = [];
    holder.locks = {
      request: (name: string, work: () => Promise<unknown>) => {
        requested.push(name);
        return work();
      },
    };
    try {
      sendHandoff('convert', item);
      sendHandoff('convert', { ...item, name: 'Second take' });
      await flushHandoffWrites();
      const keys = queuedTakes('convert').map((take) => take.key);

      expect(await discardHandoffQueue('convert')).toBe(2);
      for (const key of keys) {
        expect(requested).toContain(`chatter-box-handoff-take-${key}`);
      }
    } finally {
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('does not hang a claim on a lock that never grants', async () => {
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    holder.locks = {
      request: () => new Promise<never>(() => {}),
    };
    setLockTimeout(20);
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();
      expect(await takeHandoff('convert')).toEqual(item);
      expect(store.rows.size).toBe(0);
    } finally {
      setLockTimeout();
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('leaves the take queued when its lock never grants a discard', async () => {
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    holder.locks = {
      request: () => new Promise<never>(() => {}),
    };
    setLockTimeout(20);
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();
      const [queued] = queuedTakes('convert');
      expect(await discardHandoff('convert', queued.key)).toBe(false);
      expect(pendingCount('convert')).toBe(1);
      expect(await discardHandoffQueue('convert')).toBe(0);
      expect(pendingCount('convert')).toBe(1);
    } finally {
      setLockTimeout();
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('still runs the work when the lock grants inside the timeout', async () => {
    const holder = navigator as unknown as { locks?: unknown };
    const previous = holder.locks;
    holder.locks = {
      request: (_name: string, work: () => Promise<unknown>) =>
        new Promise<unknown>((resolve, reject) => {
          setTimeout(() => work().then(resolve, reject), 5);
        }),
    };
    setLockTimeout(200);
    try {
      sendHandoff('convert', item);
      await flushHandoffWrites();
      expect(await takeHandoff('convert')).toEqual(item);
      expect(store.rows.size).toBe(0);
    } finally {
      setLockTimeout();
      if (previous === undefined) delete holder.locks;
      else holder.locks = previous;
    }
  });

  it('quarantines corrupt rows without losing the valid takes around them', async () => {
    // Rows no section wrote must neither wedge hydration nor surface as
    // takes: each is validated on its own, deleted by key, and skipped.
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    store.rows.set('corrupt-null', null as unknown as HandoffRecord);
    store.rows.set('corrupt-target', {
      key: 'corrupt-target',
      target: 'nowhere',
      at: Date.now(),
      item,
    } as unknown as HandoffRecord);
    store.rows.set('corrupt-item', {
      key: 'corrupt-item',
      target: 'convert',
      at: Date.now(),
      item: null,
    } as unknown as HandoffRecord);
    store.rows.set('corrupt-blob', {
      key: 'corrupt-blob',
      target: 'convert',
      at: Date.now(),
      item: { name: 'Bad blob' },
    } as unknown as HandoffRecord);

    clearHandoff();
    await hydrateHandoff();

    // The valid take hydrates alone; garbage targets never surface as takes.
    expect(pendingCounts()).toEqual({ convert: 1 });
    expect(queuedTakes('convert').map((take) => take.name)).toEqual(['A take']);
    expect(await takeHandoff('convert')).toEqual(item);

    // Keyed garbage is quarantined and the taken row went with its take.
    // The keyless null cannot exist in the real store (its keyPath rejects
    // keyless puts) and can only be skipped — never wedging hydration.
    expect([...store.rows.keys()].sort()).toEqual(['corrupt-null']);
    clearHandoff();
    await hydrateHandoff();
    expect(pendingCounts()).toEqual({});
  });

  it('deletes the row before handing the take over, so a take is never replayed', async () => {
    // The crash tradeoff, pinned. The loss window runs from the row's delete
    // resolving to the caller applying the take, with no awaits in between
    // on any claim path — microtasks inside one task, unobservable except by
    // killing the process inside it. A crash there loses that visit's take.
    // The alternative (hand over first, delete after) would replay an
    // already-applied take on every failed delete — the common, observable
    // case a hung store produces — and unshowing it would need a rollback in
    // every section. Loss on crash, never replay: this pins the ordering
    // that choice rests on.
    let releaseRemove: (() => void) | undefined;
    const remove = store.remove.bind(store);
    store.remove = (key: string) =>
      new Promise<void>((resolve) => {
        releaseRemove = () => {
          void remove(key).then(() => resolve());
        };
      });

    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const taken = takeHandoff('convert');
    // The delete is under way but has not landed: the row is still there
    // and the take is not handed over yet.
    await vi.waitFor(() => expect(releaseRemove).toBeDefined());
    let settled: HandoffItem | null | undefined;
    void taken.then((value) => {
      settled = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBeUndefined();
    expect(store.rows.size).toBe(1);

    releaseRemove!();
    expect(await taken).toEqual(item);
    store.remove = remove;

    // The row went before the handover: from here on a crash loses the take
    // rather than replaying it, and a reload starts empty.
    expect(store.rows.size).toBe(0);
    clearHandoff();
    await hydrateHandoff();
    expect(pendingCount('convert')).toBe(0);
    expect(await takeHandoff('convert')).toBeNull();
  });

  it('reports a take that would not open, and opens it on another try', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const remove = store.remove.bind(store);
    store.remove = vi.fn(async () => {
      throw new Error('delete failed');
    });

    expect(await claimHandoff('convert')).toEqual({ status: 'failed' });
    // Still queued, so the section can say so and offer the retry.
    expect(pendingCount('convert')).toBe(1);

    store.remove = remove;
    // The taken claim carries its way back: a section gone before the delete
    // lands puts the take back with it instead of losing it.
    expect(await claimHandoff('convert')).toMatchObject({ status: 'taken', item });
    expect(await claimHandoff('convert')).toEqual({ status: 'empty' });
    expect(store.rows.size).toBe(0);
  });

  it('tells a section its take failed to open, and not once it opens', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const remove = store.remove.bind(store);
    store.remove = vi.fn(async () => {
      throw new Error('delete failed');
    });

    const failed = vi.fn();
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed), { onFailed: failed });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    // Nothing applied: the row survived, so showing it would replay it.
    expect(seen).toEqual([]);
    stop();

    store.remove = remove;
    const failedAgain = vi.fn();
    const stopNext = subscribeHandoff('convert', (handed) => seen.push(handed), {
      onFailed: failedAgain,
    });
    await vi.waitFor(() => expect(seen).toEqual([item]));
    expect(failedAgain).not.toHaveBeenCalled();
    stopNext();
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
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    // Sending also prunes storage, which reads it back once: the prune runs
    // inside the queued write, so the flush covers it too.
    expect(store.lists).toBe(1);

    // Another section opening reads the store back. Convert's take has only
    // been sent, not taken, so its row is still there and must be recognised
    // as the take already waiting in memory.
    const stopEmpty = subscribeHandoff('process', () => {});
    await vi.waitFor(() => expect(store.lists).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopEmpty();

    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    await vi.waitFor(() => expect(seen).toEqual([item]));
    stop();

    // A duplicate would sit here and arrive again on the next visit.
    expect(await takeHandoff('convert')).toBeNull();
  });

  it('hands stored takes over oldest first, one per visit', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    await flushHandoffWrites();
    expect(store.rows.size).toBe(2);

    clearHandoff();
    const names: string[] = [];
    const stop = subscribeHandoff('convert', (handed) => names.push(handed.name));

    await vi.waitFor(() => expect(names).toHaveLength(1));
    stop();

    expect(names).toEqual(['A take']);
  });

  it('counts how many takes are still waiting for a section', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });

    expect(pendingCount('convert')).toBe(2);
    await takeHandoff('convert');
    expect(pendingCount('convert')).toBe(1);
    expect(pendingCount('song')).toBe(0);
  });

  it('drops a stored take nobody opened within the week', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    for (const row of store.rows.values()) row.at = Date.now() - HANDOFF_MAX_AGE_MS - 1000;

    clearHandoff();
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    // Stays wall-clock: this prune runs unobserved inside hydration, after
    // the read, so no queued write covers it.
    await vi.waitFor(() => expect(store.rows.size).toBe(0));
    stop();

    // Stale audio is not handed over a week late; the row is gone with it.
    expect(seen).toEqual([]);
  });

  it('waits for the delete before handing the take over', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const remove = store.remove.bind(store);
    const releases: Array<() => void> = [];
    store.remove = vi.fn(
      (key: string) =>
        new Promise<void>((resolve, reject) => {
          releases.push(() => {
            remove(key).then(resolve, reject);
          });
        }),
    );

    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The decision this makes: nothing is applied while the row is still on
    // disk, so a crash cannot leave a shown take queued for the next run.
    expect(releases).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(store.rows.size).toBe(1);

    releases[0]();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stop();
    store.remove = remove;
    expect(store.rows.size).toBe(0);
  });

  it('keeps a take queued when its stored row cannot be deleted', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const remove = store.remove.bind(store);
    store.remove = vi.fn(async () => {
      throw new Error('delete failed');
    });

    // No apply: the row survived, and handing the take over would replay it.
    expect(await takeHandoff('convert')).toBeNull();
    expect(pendingCount('convert')).toBe(1);
    expect(store.rows.size).toBe(1);

    // The take was never applied, so a working delete can still hand it over.
    store.remove = remove;
    expect(await takeHandoff('convert')).toEqual(item);
    expect(store.rows.size).toBe(0);
  });

  it('does not show a take whose row survived a failed delete', async () => {
    sendHandoff('convert', item);
    await flushHandoffWrites();
    expect(store.rows.size).toBe(1);

    const remove = store.remove.bind(store);
    store.remove = vi.fn(async () => {
      throw new Error('delete failed');
    });

    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('convert', (handed) => seen.push(handed));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(seen).toEqual([]);
    // Still waiting, not lost: the section can retry on a later visit.
    expect(pendingCount('convert')).toBe(1);

    store.remove = remove;
    clearHandoff();
    const nextRun: HandoffItem[] = [];
    const stopNext = subscribeHandoff('convert', (handed) => nextRun.push(handed));
    await vi.waitFor(() => expect(nextRun).toHaveLength(1));
    stopNext();

    expect(nextRun[0]).toEqual(item);
    // Delivered only after the row is gone.
    expect(store.rows.size).toBe(0);
  });

  it('keeps only a section’s newest takes on disk', async () => {
    for (let index = 0; index <= HANDOFF_MAX_STORED + 2; index += 1) {
      sendHandoff('convert', { ...item, name: `Take ${index}` });
    }
    await flushHandoffWrites();
    expect(store.rows.size).toBe(HANDOFF_MAX_STORED);

    const names = [...store.rows.values()]
      .sort((a, b) => a.at - b.at)
      .map((row) => row.item.name);
    expect(names[0]).toBe('Take 3');
    expect(names[names.length - 1]).toBe(`Take ${HANDOFF_MAX_STORED + 2}`);
    // Only storage is bounded: the session still holds every take it queued.
    expect(pendingCount('convert')).toBe(HANDOFF_MAX_STORED + 3);
  });

  it('counts the takes waiting for each section', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    sendHandoff('song', { ...item, name: 'Beat take' });

    expect(pendingCounts()).toEqual({ convert: 2, song: 1 });

    await takeHandoff('convert');
    expect(pendingCounts()).toEqual({ convert: 1, song: 1 });
  });

  it('tells the rail after every change, so its count never lags', async () => {
    const seen: Array<Partial<Record<HandoffTarget, number>>> = [];
    const stop = subscribeQueues(() => seen.push(pendingCounts()));

    sendHandoff('song', item);
    await takeHandoff('song');
    stop();

    expect(seen).toEqual([{ song: 1 }, {}]);
  });

  it('counts takes an earlier run left before that section is opened', async () => {
    sendHandoff('convert', item);
    sendHandoff('convert', { ...item, name: 'Second take' });
    await flushHandoffWrites();
    expect(store.rows.size).toBe(2);

    // A reload: the queues are empty until the store is asked.
    clearHandoff();
    expect(pendingCounts()).toEqual({});

    await hydrateHandoff();

    expect(pendingCounts()).toEqual({ convert: 2 });
  });
});
