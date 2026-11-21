// @vitest-environment jsdom
// Queued takes are held per section, not in one slot for the whole app: a send
// to a second section before the first is opened must not drop the first take.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHandoff,
  currentSection,
  returnTake,
  sendHandoff,
  subscribeHandoff,
  takeHandoff,
  HANDOFF_TARGETS,
} from './handoff';

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
