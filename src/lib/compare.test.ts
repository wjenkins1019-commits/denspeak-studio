// Tests for the A/B compare helpers: sample defaulting and job-side matching.
import { describe, expect, it } from 'vitest';
import { compareSideOf, COMPARE_GROUP, defaultSample } from './compare';

describe('defaultSample', () => {
  it('returns empty for an empty script', () => {
    expect(defaultSample('')).toBe('');
    expect(defaultSample('   \n  ')).toBe('');
  });

  it('takes the first paragraph and caps it around 600 chars', () => {
    const first = `First paragraph, short and sweet.`;
    const second = `Second paragraph that must not appear.`;
    expect(defaultSample(`${first}\n\n${second}`)).toBe(first);
    const long = `Word `.repeat(200).trim();
    const sample = defaultSample(long);
    expect(sample.length).toBeLessThanOrEqual(600);
    expect(sample.startsWith('Word')).toBe(true);
  });
});

describe('compareSideOf', () => {
  it('maps chapter 0/1 of the compare group to sides', () => {
    expect(compareSideOf({ group: COMPARE_GROUP, chapterIndex: 0 })).toBe(0);
    expect(compareSideOf({ group: COMPARE_GROUP, chapterIndex: 1 })).toBe(1);
  });

  it('rejects other groups and chapters', () => {
    expect(compareSideOf({ group: 'studio', chapterIndex: 0 })).toBe(null);
    expect(compareSideOf({ group: COMPARE_GROUP, chapterIndex: 2 })).toBe(null);
  });
});
