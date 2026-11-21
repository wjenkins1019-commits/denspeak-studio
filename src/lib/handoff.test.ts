import { beforeEach, describe, expect, it } from 'vitest';
import { clearHandoff, sendHandoff, takeHandoff } from './handoff';

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
});
