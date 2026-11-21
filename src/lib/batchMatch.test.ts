import { describe, expect, it, vi } from 'vitest';
import { batchMatchTakes, isMatchableTake } from './batchMatch';
import type { Take } from './library';
import type { LoudnessReport } from './loudness';

function take(overrides: Partial<Take> & { name: string }): Take {
  return {
    id: overrides.name,
    createdAt: 0,
    duration: 10,
    kind: 'convert',
    blob: new Blob(['audio'], { type: 'audio/wav' }),
    ...overrides,
  } as Take;
}

const PASS: LoudnessReport = { seconds: 10, peakDb: -4, rmsDb: -20, noiseFloorDb: -80 };
const HOT: LoudnessReport = { seconds: 10, peakDb: -0.5, rmsDb: -20, noiseFloorDb: -80 };
const NOISY_AFTER: LoudnessReport = { seconds: 10, peakDb: -4, rmsDb: -20, noiseFloorDb: -40 };

function matched(after: LoudnessReport = PASS) {
  return {
    wav: new Blob(['fixed'], { type: 'audio/wav' }),
    before: HOT,
    after,
    gainDb: -2,
    peakLimited: true,
  };
}

describe('isMatchableTake', () => {
  it('skips song mixes', () => {
    expect(isMatchableTake(take({ name: 'voice' }))).toBe(true);
    expect(isMatchableTake(take({ name: 'mix', kind: 'song' }))).toBe(false);
  });
});

describe('batchMatchTakes', () => {
  it('passes takes already in spec without saving', async () => {
    const saveMatched = vi.fn(() => Promise.resolve());
    const result = await batchMatchTakes([take({ name: 'good' })], 'audiobook', {
      analyze: async () => PASS,
      matchAudio: async () => {
        throw new Error('should not match');
      },
      saveMatched,
    });
    expect(result.passed).toBe(1);
    expect(result.matched).toBe(0);
    expect(saveMatched).not.toHaveBeenCalled();
    expect(result.entries[0].status).toBe('passed');
  });

  it('matches failing takes and saves a processed copy', async () => {
    const saved: string[] = [];
    const result = await batchMatchTakes([take({ name: 'hot' })], 'audiobook', {
      analyze: async () => HOT,
      matchAudio: async () => matched(),
      saveMatched: async (_take, _matched, savedName) => {
        saved.push(savedName);
      },
    });
    expect(result.matched).toBe(1);
    expect(saved).toEqual(['hot — Audiobook match']);
    expect(result.entries[0]).toMatchObject({
      status: 'matched',
      gainDb: -2,
      peakLimited: true,
    });
  });

  it('matches loudness-passing takes that fail ACX edges', async () => {
    const saveMatched = vi.fn(() => Promise.resolve());
    const captions = { srt: 'srt', vtt: 'vtt' };
    const result = await batchMatchTakes([take({ name: 'edge-fail', captions })], 'audiobook', {
      analyze: async () => PASS,
      measureEndsAudio: async () => ({ headMs: 40, tailMs: 40 }),
      matchAudio: async () => ({
        ...matched(),
        endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: false },
      }),
      saveMatched,
    });
    expect(result.passed).toBe(0);
    expect(result.matched).toBe(1);
    expect(saveMatched).toHaveBeenCalledTimes(1);
    expect(result.entries[0].status).toBe('matched');
    expect(result.entries[0].captionsShifted).toBe(true);
  });

  it('leaves captionsShifted off takes with no stored captions', async () => {
    const result = await batchMatchTakes([take({ name: 'hot' })], 'audiobook', {
      analyze: async () => HOT,
      matchAudio: async () => ({
        ...matched(),
        endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: false },
      }),
      saveMatched: async () => {},
    });
    expect(result.entries[0].status).toBe('matched');
    expect(result.entries[0].captionsShifted).toBeUndefined();
  });

  it('flags captionsShifted on needs-work copies saved with shifted captions', async () => {
    const saveMatched = vi.fn(() => Promise.resolve());
    const result = await batchMatchTakes(
      [take({ name: 'noisy', captions: { srt: 'srt', vtt: 'vtt' } })],
      'audiobook',
      {
        analyze: async () => HOT,
        matchAudio: async () => ({
          ...matched(NOISY_AFTER),
          endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: true },
        }),
        saveMatched,
      },
    );
    expect(result.entries[0].status).toBe('needs-work');
    expect(saveMatched).toHaveBeenCalledTimes(1);
    expect(result.entries[0].captionsShifted).toBe(true);
  });

  it('still passes loudness-passing takes whose edges pass', async () => {
    const saveMatched = vi.fn(() => Promise.resolve());
    const result = await batchMatchTakes([take({ name: 'good' })], 'audiobook', {
      analyze: async () => PASS,
      measureEndsAudio: async () => ({ headMs: 750, tailMs: 2000 }),
      matchAudio: async () => {
        throw new Error('should not match');
      },
      saveMatched,
    });
    expect(result.passed).toBe(1);
    expect(saveMatched).not.toHaveBeenCalled();
  });

  it('treats unreadable edges as loudness-only and ignores edges for ad spots', async () => {
    const saveMatched = vi.fn(() => Promise.resolve());
    const unreadable = await batchMatchTakes([take({ name: 'silent-edges' })], 'audiobook', {
      analyze: async () => PASS,
      measureEndsAudio: async () => {
        throw new Error('No audible speech to match.');
      },
      matchAudio: async () => {
        throw new Error('should not match');
      },
      saveMatched,
    });
    expect(unreadable.passed).toBe(1);
    const AD_PASS: LoudnessReport = { seconds: 10, peakDb: -1, rmsDb: -16, noiseFloorDb: -80 };
    const ad = await batchMatchTakes([take({ name: 'spot' })], 'ad', {
      analyze: async () => AD_PASS,
      matchAudio: async () => {
        throw new Error('should not match');
      },
      saveMatched,
    });
    expect(ad.passed).toBe(1);
    expect(saveMatched).not.toHaveBeenCalled();
  });

  it('notes the ACX edge fix on audiobook matches', async () => {
    const result = await batchMatchTakes([take({ name: 'hot' })], 'audiobook', {
      analyze: async () => HOT,
      matchAudio: async () => ({
        ...matched(),
        endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: true },
      }),
      saveMatched: async () => {},
    });
    expect(result.entries[0].endsNote).toMatch(/room tone/);
  });

  it('saves but flags takes that still fail after the fix', async () => {
    const result = await batchMatchTakes([take({ name: 'noisy' })], 'audiobook', {
      analyze: async () => HOT,
      matchAudio: async () => matched(NOISY_AFTER),
      saveMatched: async () => {},
    });
    expect(result.matched).toBe(0);
    expect(result.needsWork).toBe(1);
    expect(result.entries[0].status).toBe('needs-work');
    expect(result.entries[0].error).toContain('room tone');
  });

  it('keeps going when one take fails and reports per-take errors', async () => {
    const result = await batchMatchTakes([take({ name: 'silent' }), take({ name: 'hot' })], 'audiobook', {
      analyze: async (blob) => HOT,
      matchAudio: async (blob, standardId) => {
        void blob;
        void standardId;
        throw new Error('No audible speech to match.');
      },
      saveMatched: async () => {
        throw new Error('should not save');
      },
    });
    // Both fail at match step: each recorded, none stops the other.
    expect(result.failed).toBe(2);
    expect(result.entries.map((entry) => entry.name)).toEqual(['silent', 'hot']);
  });

  it('skips songs and stops promptly when cancelled', async () => {
    const saveMatched = vi.fn(() => Promise.resolve());
    const result = await batchMatchTakes(
      [take({ name: 'mix', kind: 'song' }), take({ name: 'a' }), take({ name: 'b' })],
      'audiobook',
      {
        analyze: async () => HOT,
        matchAudio: async () => matched(),
        saveMatched,
        shouldCancel: () => true,
      },
    );
    expect(result.cancelled).toBe(true);
    expect(saveMatched).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
  });

  it('reports per-take progress', async () => {
    const seen: string[] = [];
    await batchMatchTakes([take({ name: 'hot' })], 'audiobook', {
      analyze: async () => HOT,
      matchAudio: async () => matched(),
      saveMatched: async () => {},
      onProgress: (progress) => {
        seen.push(`${progress.done}/${progress.total} ${progress.currentName}`);
      },
    });
    expect(seen[0]).toContain('hot');
    expect(seen[seen.length - 1].startsWith('1/1')).toBe(true);
  });
});
