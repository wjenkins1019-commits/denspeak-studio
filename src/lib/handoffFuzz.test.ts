// @vitest-environment jsdom
// Interleaving fuzz over the hand-off queue: random sends, takes, discards,
// clears, hydrations and crashes must never deliver the same take twice.
// Delivery is delete-before-handover, so crashes and pruning may lose takes —
// loss is allowed, replay is not. Seeded and fully awaited: deterministic.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimHandoff,
  clearHandoff,
  discardHandoff,
  discardHandoffQueue,
  flushHandoffWrites,
  hydrateHandoff,
  pendingCount,
  queuedTakes,
  sendHandoff,
  setClearTimeout,
  setHandoffStore,
  setLockTimeout,
  takeHandoff,
  type HandoffItem,
  type HandoffTarget,
} from './handoff';
import { orderListedRows } from './handoffStore';
import type { HandoffRecord, HandoffStore } from './handoffStore';

/** In-memory durable double, so a crash can be simulated by dropping memory. */
class MemoryStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();

  async list(): Promise<HandoffRecord[]> {
    return orderListedRows([...this.rows.values()]);
  }

  async put(record: HandoffRecord): Promise<void> {
    this.rows.set(record.key, record);
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

/** Deterministic stream of choices: the same seed replays the same run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const TARGETS: HandoffTarget[] = ['convert', 'song', 'process'];
const STEPS = 250;
const SEEDS = [7, 19, 42];

/**
 * Serializing Web Locks stand-in: holders of the same take name queue behind
 * each other, holders of different names run together — the cross-tab
 * guarantee the real primitive gives claims and discards on one take.
 */
function installSerializingWebLocks(onRequest?: (name: string) => void): () => void {
  const holder = globalThis as unknown as { navigator?: { locks?: unknown } };
  const previous = holder.navigator?.locks;
  const tails = new Map<string, Promise<void>>();
  const locks = {
    request: <T>(name: string, work: () => Promise<T>): Promise<T> => {
      onRequest?.(name);
      const tail = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const mine = tail.then(() => gate);
      tails.set(name, mine);
      const run = tail.then(work);
      const settle = () => {
        release();
        if (tails.get(name) === mine) tails.delete(name);
      };
      void run.then(settle, settle);
      return run;
    },
  };
  if (holder.navigator) holder.navigator.locks = locks;
  else holder.navigator = { locks };
  return () => {
    if (holder.navigator) {
      if (previous === undefined) delete holder.navigator.locks;
      else holder.navigator.locks = previous;
    }
  };
}

describe('handoff fuzz', () => {
  const store = new MemoryStore();

  beforeEach(() => {
    store.rows.clear();
    setHandoffStore(store);
    clearHandoff();
  });

  afterEach(() => {
    setHandoffStore(null);
    clearHandoff();
  });

  it.each(SEEDS)('never delivers the same take twice (seed %i)', async (seed) => {
    const random = mulberry32(seed);
    const pick = <T>(options: readonly T[]): T => options[Math.floor(random() * options.length)];
    const blob = new Blob(['fuzz-audio']);
    const sent = new Set<string>();
    const delivered = new Set<string>();
    let seq = 0;

    /** A delivery is at-most-once and of a take this run actually sent. */
    function recordDelivery(item: HandoffItem): void {
      expect(sent.has(item.name)).toBe(true);
      expect(delivered.has(item.name)).toBe(false);
      delivered.add(item.name);
    }

    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      if (roll < 0.38) {
        // Send a uniquely named take.
        const name = `fuzz-${seed}-${seq}`;
        seq += 1;
        sent.add(name);
        sendHandoff(pick(TARGETS), { name, blob, from: 'studio' });
      } else if (roll < 0.52) {
        const taken = await takeHandoff(pick(TARGETS));
        if (taken) recordDelivery(taken);
      } else if (roll < 0.6) {
        // Claim then release: the section is gone before the delete lands,
        // so the take goes back rather than being lost — still once.
        const claim = await claimHandoff(pick(TARGETS));
        if (claim.status === 'taken') claim.release();
      } else if (roll < 0.7) {
        const target = pick(TARGETS);
        const queued = queuedTakes(target);
        if (queued.length > 0) await discardHandoff(target, pick(queued).key);
      } else if (roll < 0.77) {
        await discardHandoffQueue(pick(TARGETS));
      } else if (roll < 0.85) {
        await hydrateHandoff();
      } else if (roll < 0.92) {
        await flushHandoffWrites();
      } else {
        // Crash: memory is gone, rows remain; the next run hydrates.
        clearHandoff();
        await hydrateHandoff();
      }
    }

    // The run must have exercised real deliveries, not just empty takes.
    expect(delivered.size).toBeGreaterThan(0);

    // Drain whatever survived; leftovers must still arrive at most once.
    await flushHandoffWrites();
    clearHandoff();
    await hydrateHandoff();
    for (const target of TARGETS) {
      for (;;) {
        const taken = await takeHandoff(target);
        if (!taken) break;
        recordDelivery(taken);
      }
    }
  });
});

describe('handoff fuzz with serializing Web Locks', () => {
  const store = new MemoryStore();
  let restoreLocks: (() => void) | null = null;
  const requested: string[] = [];

  beforeEach(() => {
    store.rows.clear();
    requested.length = 0;
    setHandoffStore(store);
    clearHandoff();
    restoreLocks = installSerializingWebLocks((name) => {
      requested.push(name);
    });
  });

  afterEach(() => {
    restoreLocks?.();
    restoreLocks = null;
    setHandoffStore(null);
    clearHandoff();
  });

  it.each(SEEDS)('serializes cross-tab claim-versus-discard races (seed %i)', async (seed) => {
    const random = mulberry32(seed);
    const pick = <T>(options: readonly T[]): T => options[Math.floor(random() * options.length)];
    const blob = new Blob(['fuzz-audio']);
    const sent = new Set<string>();
    const delivered = new Set<string>();
    let seq = 0;

    /** A delivery is at-most-once and of a take this run actually sent. */
    function recordDelivery(item: HandoffItem): void {
      expect(sent.has(item.name)).toBe(true);
      expect(delivered.has(item.name)).toBe(false);
      delivered.add(item.name);
    }

    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      if (roll < 0.3) {
        // Send a uniquely named take.
        const name = `lock-fuzz-${seed}-${seq}`;
        seq += 1;
        sent.add(name);
        sendHandoff(pick(TARGETS), { name, blob, from: 'studio' });
      } else if (roll < 0.4) {
        const taken = await takeHandoff(pick(TARGETS));
        if (taken) recordDelivery(taken);
      } else if (roll < 0.46) {
        // Claim then release: the section is gone before the delete lands,
        // so the take goes back rather than being lost — still once.
        const claim = await claimHandoff(pick(TARGETS));
        if (claim.status === 'taken') claim.release();
      } else if (roll < 0.58) {
        // Cross-tab race: a claim and a discard for one take start together.
        // The per-take lock serializes them — the winner consumes the take
        // and the loser finds nothing to deliver twice.
        const target = pick(TARGETS);
        const queued = queuedTakes(target);
        if (queued.length === 0) {
          const taken = await takeHandoff(target);
          if (taken) recordDelivery(taken);
        } else {
          const victim = pick(queued);
          if (random() < 0.5) {
            const claimPromise = claimHandoff(target);
            const discardPromise = discardHandoff(target, victim.key);
            const [claim, discarded] = await Promise.all([claimPromise, discardPromise]);
            if (claim.status === 'taken') {
              recordDelivery(claim.item);
              // When the raced take itself was claimed, the discard queued
              // behind the same lock must have found it gone.
              if (claim.item.name === victim.name) expect(discarded).toBe(false);
            }
          } else {
            const discardPromise = discardHandoff(target, victim.key);
            const claimPromise = claimHandoff(target);
            const [discarded, claim] = await Promise.all([discardPromise, claimPromise]);
            if (claim.status === 'taken') {
              recordDelivery(claim.item);
              if (claim.item.name === victim.name) expect(discarded).toBe(false);
            }
          }
        }
      } else if (roll < 0.64) {
        // Take racing a whole-queue clear: each take clears under its own
        // per-take lock, so the take either wins its row or finds it gone.
        const target = pick(TARGETS);
        const takePromise = takeHandoff(target);
        const clearPromise = discardHandoffQueue(target);
        const [taken] = await Promise.all([takePromise, clearPromise]);
        if (taken) recordDelivery(taken);
      } else if (roll < 0.7) {
        const target = pick(TARGETS);
        const queued = queuedTakes(target);
        if (queued.length > 0) await discardHandoff(target, pick(queued).key);
      } else if (roll < 0.75) {
        await discardHandoffQueue(pick(TARGETS));
      } else if (roll < 0.8) {
        // The other tab claimed a stored row out from under this one: the
        // row is gone while this tab's copy is still queued. Mark it
        // delivered elsewhere, so replaying the stale copy fails the check.
        const keys = [...store.rows.keys()];
        if (keys.length === 0) {
          await hydrateHandoff();
        } else {
          const key = pick(keys);
          const row = store.rows.get(key);
          if (row) delivered.add(row.item.name);
          await store.remove(key);
        }
      } else if (roll < 0.87) {
        await hydrateHandoff();
      } else if (roll < 0.93) {
        await flushHandoffWrites();
      } else {
        // Crash: memory is gone, rows remain; the next run hydrates.
        clearHandoff();
        await hydrateHandoff();
      }
    }

    // The locked run must have exercised real deliveries and the stub: else
    // the cross-tab races above ran without locks and proved nothing.
    expect(delivered.size).toBeGreaterThan(0);
    expect(requested.length).toBeGreaterThan(0);

    // Drain whatever survived; leftovers must still arrive at most once.
    await flushHandoffWrites();
    clearHandoff();
    await hydrateHandoff();
    for (const target of TARGETS) {
      for (;;) {
        const taken = await takeHandoff(target);
        if (!taken) break;
        recordDelivery(taken);
      }
    }
  });
});

describe('handoff fuzz with hanging locks and failing storage', () => {
  const backing = new MemoryStore();
  let restoreLocks: (() => void) | null = null;

  beforeEach(() => {
    backing.rows.clear();
    setHandoffStore(backing);
    clearHandoff();
    setLockTimeout(8);
    setClearTimeout(12);
  });

  afterEach(() => {
    restoreLocks?.();
    restoreLocks = null;
    setLockTimeout();
    setClearTimeout();
    setHandoffStore(null);
    clearHandoff();
  });

  it.each(SEEDS)('timeouts fail without taking, retry delivers once (seed %i)', async (seed) => {
    const random = mulberry32(seed ^ 0x9e3779b9);
    const pick = <T>(options: readonly T[]): T => options[Math.floor(random() * options.length)];
    const blob = new Blob(['fuzz-hang-audio']);
    const sent = new Set<string>();
    const delivered = new Set<string>();
    let seq = 0;
    let failedClaims = 0;
    let lockHangs = 0;
    let lockGrants = 0;
    let deleteHangs = 0;
    let deleteThrows = 0;
    let listFailures = 0;
    let healthy = false;

    function recordDelivery(item: HandoffItem): void {
      expect(sent.has(item.name)).toBe(true);
      expect(delivered.has(item.name)).toBe(false);
      delivered.add(item.name);
    }

    // Faulting locks: sometimes never grant (timeout), sometimes grant late
    // but inside the timeout, otherwise grant at once. Fully awaited per
    // claim, so the run stays deterministic.
    const holder = globalThis as unknown as { navigator: { locks?: unknown } };
    const nav = holder.navigator;
    const previous = nav?.locks;
    const faultingLocks = {
      request: <T>(name: string, work: () => Promise<T>): Promise<T> => {
        void name;
        if (healthy) {
          lockGrants += 1;
          return work();
        }
        const roll = random();
        if (roll < 0.35) {
          lockHangs += 1;
          return new Promise<never>(() => {});
        }
                  if (roll < 0.5) {
            lockGrants += 1;
            return new Promise<T>((resolve, reject) => {
              setTimeout(() => work().then(resolve, reject), 1);
            });
          }
        lockGrants += 1;
        return work();
      },
    };
    if (nav) nav.locks = faultingLocks;
    else holder.navigator = { locks: faultingLocks } as unknown as { locks?: unknown } as never;
    restoreLocks = () => {
      if (holder.navigator) {
        if (previous === undefined) delete holder.navigator.locks;
        else holder.navigator.locks = previous;
      }
    };

    // Faulting store: deletes hang or throw, lists throw. Puts always land
    // so a flush never hangs and a retry always has a row to delete.
    const faulting: HandoffStore = {
      async list(): Promise<HandoffRecord[]> {
        if (!healthy && random() < 0.15) {
          listFailures += 1;
          throw new Error('list failed');
        }
        return backing.list();
      },
      async put(record: HandoffRecord): Promise<void> {
        return backing.put(record);
      },
      async remove(key: string): Promise<void> {
        if (!healthy) {
          const roll = random();
          if (roll < 0.2) {
            deleteHangs += 1;
            return new Promise<never>(() => {});
          }
          if (roll < 0.3) {
            deleteThrows += 1;
            throw new Error('delete failed');
          }
        }
        return backing.remove(key);
      },
    };
    setHandoffStore(faulting);

    for (let step = 0; step < 80; step += 1) {
      const roll = random();
      if (roll < 0.32) {
        const name = `hang-fuzz-${seed}-${seq}`;
        seq += 1;
        sent.add(name);
        sendHandoff(pick(TARGETS), { name, blob, from: 'studio' });
      } else if (roll < 0.58) {
        // claimHandoff distinguishes failed (kept queued) from empty.
        const target = pick(TARGETS);
        const before = pendingCount(target);
        const claim = await claimHandoff(target);
        if (claim.status === 'taken') recordDelivery(claim.item);
        else if (claim.status === 'failed') {
          failedClaims += 1;
          // Failed-not-taken: nothing delivered and the failed take stays
          // queued for retry. Takes stolen ahead of it may have dropped,
          // so the count can shrink but never to empty or above before.
          expect(before).toBeGreaterThan(0);
          expect(pendingCount(target)).toBeGreaterThanOrEqual(1);
          expect(pendingCount(target)).toBeLessThanOrEqual(before);
        }
      } else if (roll < 0.68) {
        const target = pick(TARGETS);
        const queued = queuedTakes(target);
        if (queued.length > 0) await discardHandoff(target, pick(queued).key);
      } else if (roll < 0.74) {
        await discardHandoffQueue(pick(TARGETS));
      } else if (roll < 0.8) {
        await hydrateHandoff();
      } else if (roll < 0.88) {
        await flushHandoffWrites();
      } else {
        clearHandoff();
        await hydrateHandoff();
      }
    }

    // Every fault branch must have fired, else the timeouts proved nothing.
    expect(lockHangs).toBeGreaterThan(0);
    expect(lockGrants).toBeGreaterThan(0);
    expect(deleteHangs + deleteThrows).toBeGreaterThan(0);
    expect(listFailures).toBeGreaterThan(0);
    expect(failedClaims).toBeGreaterThan(0);
    expect(delivered.size).toBeGreaterThan(0);

    // Exactly-once retry: faults clear, every survivor drains at most once.
    healthy = true;
    setLockTimeout();
    setClearTimeout();
    await flushHandoffWrites();
    clearHandoff();
    await hydrateHandoff();
    for (const target of TARGETS) {
      for (;;) {
        const taken = await takeHandoff(target);
        if (!taken) break;
        recordDelivery(taken);
      }
    }
  }, 20000);
});
