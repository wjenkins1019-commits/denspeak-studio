// Tests for the pronunciation rewrite and its preview segments. The preview
// must mirror the render path exactly: joining the segments always equals the
// rewritten text, so what the user checks is what the voice reads.
import { describe, expect, it } from 'vitest';
import { applyPronunciations, segmentPronunciations, type Pronunciation } from './pronounce';

function entry(match: string, sayAs: string): Pronunciation {
  return { id: match, match, sayAs };
}

function joined(text: string, list: Pronunciation[]): string {
  return segmentPronunciations(text, list)
    .map((segment) => segment.text)
    .join('');
}

describe('applyPronunciations', () => {
  const list = [entry('NGO', 'N G O'), entry('Dr.', 'Doctor')];

  it('rewrites whole words case-insensitively', () => {
    expect(applyPronunciations('The ngo and NGO met Dr. Smith', list)).toBe(
      'The N G O and N G O met Doctor Smith',
    );
  });

  it('never rewrites inside a longer word', () => {
    expect(applyPronunciations('Sting sang', [entry('St', 'Saint')])).toBe('Sting sang');
  });

  it('lets the longest match win', () => {
    expect(applyPronunciations('St. Mary', [entry('St', 'Saint'), entry('St. Mary', 'Saint Mary')])).toBe(
      'Saint Mary',
    );
  });

  it('leaves text alone with no rules or no text', () => {
    expect(applyPronunciations('Hello', [])).toBe('Hello');
    expect(applyPronunciations('', list)).toBe('');
  });
});

describe('segmentPronunciations', () => {
  const list = [entry('NGO', 'N G O'), entry('Dr.', 'Doctor')];

  it('joins back to exactly the rewritten text', () => {
    const texts = [
      'The ngo and NGO met Dr. Smith',
      'Nothing to change here.',
      '',
      'NGO NGO NGO',
      'Dr.Sting and St. NGO-Dr.',
    ];
    for (const text of texts) {
      expect(joined(text, list)).toBe(applyPronunciations(text, list));
    }
  });

  it('marks only the replacements', () => {
    const segments = segmentPronunciations('Call the NGO now', list);
    expect(segments).toEqual([
      { text: 'Call the ', changed: false },
      { text: 'N G O', changed: true },
      { text: ' now', changed: false },
    ]);
  });

  it('returns one unchanged span with no rules', () => {
    expect(segmentPronunciations('Hello world', [])).toEqual([{ text: 'Hello world', changed: false }]);
  });

  it('marks every span of adjacent matches', () => {
    const segments = segmentPronunciations('NGO NGO', list);
    expect(segments.filter((segment) => segment.changed)).toHaveLength(2);
  });
});
