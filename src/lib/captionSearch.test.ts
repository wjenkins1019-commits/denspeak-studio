import { describe, expect, it } from 'vitest';
import { formatSRT, type Cue } from './captions';
import {
  SEARCH_MAX_PER_TAKE,
  SEARCH_MAX_TOTAL,
  searchCaptions,
  searchTakeCaptions,
  searchTokens,
  splitHighlight,
} from './captionSearch';
import type { Take } from './library';

function take(overrides: Partial<Take> & { name: string; cues?: Cue[] }): Take {
  const { cues, ...rest } = overrides;
  return {
    id: overrides.name,
    createdAt: 0,
    duration: 10,
    kind: 'render',
    blob: new Blob(['audio'], { type: 'audio/wav' }),
    ...(cues ? { captions: { srt: formatSRT(cues), vtt: '' } } : {}),
    ...rest,
  } as Take;
}

const CUES: Cue[] = [
  { start: 0, end: 2, text: 'the quick brown fox' },
  { start: 2, end: 4, text: 'jumps over the lazy dog' },
  { start: 5, end: 7, text: 'Leah: the fox returns at dawn', speaker: 'Leah' },
];

describe('searchTokens', () => {
  it('lowercases and drops blanks', () => {
    expect(searchTokens('  Fox  DAWN ')).toEqual(['fox', 'dawn']);
    expect(searchTokens('   ')).toEqual([]);
  });
});

describe('searchTakeCaptions', () => {
  it('matches every token in one cue, not across cues', () => {
    const row = take({ name: 'a', cues: CUES });
    expect(searchTakeCaptions(row, ['fox']).map((hit) => hit.start)).toEqual([0, 5]);
    // "quick" and "lazy" never share a cue — no hit.
    expect(searchTakeCaptions(row, ['quick', 'lazy'])).toEqual([]);
    expect(searchTakeCaptions(row, ['fox', 'dawn']).map((hit) => hit.start)).toEqual([5]);
  });

  it('matches speaker names too', () => {
    const row = take({ name: 'a', cues: CUES });
    const hits = searchTakeCaptions(row, ['leah']);
    expect(hits).toHaveLength(1);
    expect(hits[0].speaker).toBe('Leah');
  });

  it('skips takes without captions and caps per-take hits', () => {
    expect(searchTakeCaptions(take({ name: 'bare' }), ['fox'])).toEqual([]);
    const many: Cue[] = Array.from({ length: SEARCH_MAX_PER_TAKE + 5 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: 'fox runs again',
    }));
    expect(searchTakeCaptions(take({ name: 'long', cues: many }), ['fox'])).toHaveLength(
      SEARCH_MAX_PER_TAKE,
    );
  });
});

describe('searchCaptions', () => {
  it('searches nothing on an empty query and caps the total', () => {
    const rows = [take({ name: 'a', cues: CUES })];
    expect(searchCaptions(rows, '   ')).toEqual([]);
    const many = Array.from({ length: SEARCH_MAX_TOTAL + 10 }, (_, i) =>
      take({ name: `take-${i}`, cues: [{ start: 0, end: 1, text: 'fox den' }] }),
    );
    expect(searchCaptions(many, 'fox')).toHaveLength(SEARCH_MAX_TOTAL);
  });

  it('keeps newest takes first', () => {
    const rows = [
      take({ name: 'new', cues: [{ start: 0, end: 1, text: 'fox den' }] }),
      take({ name: 'old', cues: [{ start: 0, end: 1, text: 'fox den' }] }),
    ];
    expect(searchCaptions(rows, 'fox').map((hit) => hit.takeName)).toEqual(['new', 'old']);
  });
});

describe('splitHighlight', () => {
  it('marks query words case-insensitively', () => {
    const parts = splitHighlight('The quick FOX', ['fox']);
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['FOX']);
    expect(parts.map((part) => part.text).join('')).toBe('The quick FOX');
  });

  it('leaves plain text alone without tokens', () => {
    expect(splitHighlight('hello', [])).toEqual([{ text: 'hello', hit: false }]);
  });
});
