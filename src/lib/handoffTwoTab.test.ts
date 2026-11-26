// @vitest-environment node
// Two real tabs sharing one store through real Web Locks: two isolated copies
// of the hand-off module (separate in-memory queues, like two tabs) race
// takeHandoff against the same IndexedDB rows under the platform's own
// navigator.locks — no serializing stand-in. Each take must arrive exactly
// once across both tabs, and a crash between delete and ack must replay
// exactly once in the surviving tab.
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type HandoffTab = typeof import('./handoff');
type HandoffStoreModule = typeof import('./handoffStore');

async function loadTab(): Promise<{ handoff: HandoffTab; store: HandoffStoreModule }> {
  vi.resetModules();
  const handoff = (await import('./handoff')) as HandoffTab;
  const store = (await import('./handoffStore')) as HandoffStoreModule;
  return { handoff, store };
}

async function cleanStores(stores: HandoffStoreModule[]): Promise<void> {
  for (const store of stores) {
    for (const row of await store.indexedDbHandoffStore.list()) {
      await store.indexedDbHandoffStore.remove(row.key);
    }
    for (const row of await store.indexedDbHandoffOutboxStore.list()) {
      await store.indexedDbHandoffOutboxStore.remove(row.key);
    }
  }
}

async function closeStores(stores: HandoffStoreModule[]): Promise<void> {
  for (const store of stores) {
    await store.__closeHandoffDbForTests();
  }
}

describe('handoff two real tabs', () => {
  let tabA: HandoffTab;
  let tabB: HandoffTab;
  let stores: HandoffStoreModule[];

  beforeEach(async () => {
    // The whole point: the platform primitive must really be there. If a
    // future runner loses navigator.locks this test fails loudly instead of
    // silently proving the unlocked path.
    expect(typeof (globalThis as unknown as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks?.request).toBe(
      'function',
    );
    const first = await loadTab();
    const second = await loadTab();
    tabA = first.handoff;
    tabB = second.handoff;
    stores = [first.store, second.store];
    tabA.clearHandoff();
    tabB.clearHandoff();
    await cleanStores(stores);
    tabA.clearHandoff();
    tabB.clearHandoff();
  }, 20000);

  afterEach(async () => {
    tabA?.clearHandoff();
    tabB?.clearHandoff();
    if (stores) {
      await cleanStores(stores);
      await closeStores(stores);
    }
  }, 20000);

  it('races takeHandoff across tabs without delivering twice or losing', async () => {
    const blob = new Blob(['two-tab-audio']);
    const names = ['two-tab-0', 'two-tab-1', 'two-tab-2', 'two-tab-3', 'two-tab-4', 'two-tab-5'];
    for (const name of names) {
      tabA.sendHandoff('convert', { name, blob, from: 'studio' });
    }
    await tabA.flushHandoffWrites();

    // Fresh tabs, like two windows opened after the sends: both hydrate the
    // same rows from the same database.
    tabA.clearHandoff();
    tabB.clearHandoff();
    await tabA.hydrateHandoff();
    await tabB.hydrateHandoff();
    expect(tabA.pendingCount('convert')).toBe(names.length);
    expect(tabB.pendingCount('convert')).toBe(names.length);

    // Drain from both tabs at once, one take at a time per tab like the
    // real subscribers. The per-take Web Lock makes the check-then-delete
    // atomic: the loser finds the row gone and drops its stale copy
    // instead of delivering it again.
    const drain = async (tab: HandoffTab): Promise<string[]> => {
      const got: string[] = [];
      for (;;) {
        const taken = await tab.takeHandoff('convert');
        if (!taken) break;
        got.push(taken.name);
      }
      return got;
    };
    const [fromA, fromB] = await Promise.all([drain(tabA), drain(tabB)]);
    const delivered = [...fromA, ...fromB];

    expect(delivered).toHaveLength(names.length);
    expect([...delivered].sort()).toEqual([...names].sort());

    // Clean-run acks land in the background; flush both tabs before proving
    // nothing replays.
    await tabA.flushHandoffWrites();
    await tabB.flushHandoffWrites();

    tabA.clearHandoff();
    tabB.clearHandoff();
    await tabA.hydrateHandoff();
    await tabB.hydrateHandoff();
    expect(await tabA.takeHandoff('convert')).toBeNull();
    expect(await tabB.takeHandoff('convert')).toBeNull();
    await tabA.flushHandoffWrites();
    await tabB.flushHandoffWrites();
  }, 20000);

  it('replays a take crashed between delete and ack exactly once in the other tab', async () => {
    const blob = new Blob(['two-tab-crash-audio']);
    tabA.sendHandoff('convert', { name: 'two-tab-crash', blob, from: 'studio' });
    await tabA.flushHandoffWrites();

    tabA.clearHandoff();
    tabB.clearHandoff();
    await tabA.hydrateHandoff();
    await tabB.hydrateHandoff();

    // Tab A claims and crashes before observing or acking: the main row is
    // deleted, the outbox intent survives. Dropping the claim without acking
    // or releasing is the crash — the take was never observed.
    const claim = await tabA.claimHandoff('convert');
    expect(claim.status).toBe('taken');
    tabA.clearHandoff();

    // The survivor replays the intent as its only delivery.
    tabB.clearHandoff();
    await tabB.hydrateHandoff();
    const taken = await tabB.takeHandoff('convert');
    expect(taken?.name).toBe('two-tab-crash');
    await tabB.flushHandoffWrites();

    // Acked replays never come back.
    tabA.clearHandoff();
    tabB.clearHandoff();
    await tabA.hydrateHandoff();
    await tabB.hydrateHandoff();
    expect(await tabA.takeHandoff('convert')).toBeNull();
    expect(await tabB.takeHandoff('convert')).toBeNull();
    await tabA.flushHandoffWrites();
    await tabB.flushHandoffWrites();
  }, 20000);
});
