import { beforeEach, describe, expect, it } from 'vitest';
import { clearHandoff, sendHandoff, subscribeHandoff, takeHandoff } from './handoff';

const item = { name: 'A take', blob: new Blob(['audio']) };

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
