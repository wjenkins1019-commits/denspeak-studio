import { describe, expect, it, vi } from 'vitest';
import { backfillMissingCaptions, needsCaptions, type StoredCaptions } from './backfill';
import type { Take } from './library';

function take(overrides: Partial<Take> & { name: string }): Take {
  return {
    id: overrides.name,
    createdAt: 0,
    duration: 1,
    kind: 'convert',
    blob: new Blob(['audio'], { type: 'audio/wav' }),
    ...overrides,
  } as Take;
}

const CAPTIONED = { srt: 'srt', vtt: 'vtt' };

describe('needsCaptions', () => {
  it('skips songs and takes that already have cues', () => {
    expect(needsCaptions(take({ name: 'plain' }))).toBe(true);
    expect(needsCaptions(take({ name: 'done', captions: CAPTIONED }))).toBe(false);
    expect(needsCaptions(take({ name: 'song', kind: 'song' }))).toBe(false);
  });
});

describe('backfillMissingCaptions', () => {
  it('captions the missing takes and skips the rest', async () => {
    const takes = [
      take({ name: 'old-1' }),
      take({ name: 'song', kind: 'song' }),
      take({ name: 'done', captions: CAPTIONED }),
      take({ name: 'old-2' }),
    ];
    const saved = new Map<string, StoredCaptions>();
    const result = await backfillMissingCaptions(takes, 'model', {
      transcribeTimed: async () => [{ text: 'hello world', timestamp: [0, 1] }],
      saveCaptions: async (id, captions) => {
        saved.set(id, captions);
      },
    });
    expect(result).toEqual({ captioned: 2, failed: [], cancelled: false });
    expect([...saved.keys()].sort()).toEqual(['old-1', 'old-2']);
    expect(saved.get('old-1')?.srt).toContain('hello world');
    expect(saved.get('old-1')?.vtt).toContain('WEBVTT');
  });

  it('keeps going when one take fails and reports it', async () => {
    const takes = [take({ name: 'bad' }), take({ name: 'good' })];
    const saved: string[] = [];
    let calls = 0;
    const result = await backfillMissingCaptions(takes, 'model', {
      transcribeTimed: async (_blob, _model, onProgress) => {
        onProgress?.({ status: 'Reading the audio…', percent: null });
        calls += 1;
        // Fail the first take only.
        if (calls === 1) throw new Error('boom');
        return [{ text: 'hello world', timestamp: [0, 1] }];
      },
      saveCaptions: async (id) => {
        saved.push(id);
      },
    });
    expect(result.captioned).toBe(1);
    expect(result.failed).toEqual([{ name: 'bad', error: 'boom' }]);
    expect(saved).toEqual(['good']);
  });

  it('treats silence as a failure, not an empty save', async () => {
    const result = await backfillMissingCaptions([take({ name: 'silent' })], 'model', {
      transcribeTimed: async () => [],
      saveCaptions: async () => {
        throw new Error('should not save');
      },
    });
    expect(result.captioned).toBe(0);
    expect(result.failed).toEqual([{ name: 'silent', error: 'Could not hear any speech to caption.' }]);
  });

  it('stops promptly when cancelled', async () => {
    const onProgress = vi.fn();
    const result = await backfillMissingCaptions([take({ name: 'a' }), take({ name: 'b' })], 'model', {
      transcribeTimed: async () => [{ text: 'hi', timestamp: [0, 0.5] }],
      saveCaptions: async () => {},
      onProgress,
      shouldCancel: () => true,
    });
    expect(result.cancelled).toBe(true);
    expect(result.captioned).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('reports per-take progress', async () => {
    const seen: string[] = [];
    await backfillMissingCaptions([take({ name: 'old-1' })], 'model', {
      transcribeTimed: async (_blob, _model, onProgress) => {
        onProgress?.({ status: 'Reading the audio…', percent: null });
        return [{ text: 'hi', timestamp: [0, 0.5] }];
      },
      saveCaptions: async () => {},
      onProgress: (progress) => {
        seen.push(`${progress.done}/${progress.total} ${progress.currentName} ${progress.status}`);
      },
    });
    expect(seen[0]).toContain('old-1');
    expect(seen[seen.length - 1].startsWith('1/1')).toBe(true);
  });
});
