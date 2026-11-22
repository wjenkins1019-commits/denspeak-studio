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
  queuedTakes,
  sendHandoff,
  setHandoffStore,
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
