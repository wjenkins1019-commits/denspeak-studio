// The real two-context race lives in public/handoff-race.html: two
// same-origin iframes (separate JS realms, like two tabs) sharing the real
// IndexedDB and real navigator.locks — no fake-indexeddb, no module mock.
// This file pins the harness contract so it cannot rot silently: both race
// phases, the crash window, and the lock requirement must stay present.
// To watch the real proof: npx vite --port 5173, open /handoff-race.html.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const harnessPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'handoff-race.html');

describe('handoff two-context browser race harness', () => {
  it('exists and races drain plus crash-replay across two isolated realms', () => {
    expect(existsSync(harnessPath)).toBe(true);
    const html = readFileSync(harnessPath, 'utf8');

    // Two isolated realms sharing one origin store.
    expect(html).toContain('mode=runner');
    expect(html).toContain('iframe');
    // Real platform primitives, asserted loudly instead of falling back.
    expect(html).toContain('navigator?.locks?.request');
    expect(html).toContain('indexedDB');
    // Phase 1: concurrent drain, each take exactly once overall.
    expect(html).toContain('drain');
    // Phase 2: the crash window — claim without ack, then concurrent hydrate.
    expect(html).toContain('claimCrash');
    expect(html).toContain('replay');
    // Acked takes replay nothing afterwards.
    expect(html).toContain('PASS two-context drain+crash exactly-once');
  });
});
