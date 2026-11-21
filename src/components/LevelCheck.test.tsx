// @vitest-environment jsdom
// The level check must grade a take in one click and never show a previous
// take's verdict: same reset contract as captions, tested the same way. The
// analyzer is injected so no worker is involved.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LevelCheck } from './LevelCheck';
import type { LoudnessReport } from '../lib/loudness';

afterEach(() => {
  cleanup();
});

const HOT: LoudnessReport = { seconds: 10, peakDb: -0.4, rmsDb: -20, noiseFloorDb: -80 };

describe('LevelCheck', () => {
  it('grades a take and clears the verdict for a new blob', async () => {
    const first = new Blob(['first'], { type: 'audio/wav' });
    const second = new Blob(['second'], { type: 'audio/wav' });
    const { rerender } = render(<LevelCheck blob={first} analyze={() => Promise.resolve(HOT)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    expect(await screen.findByText(/ready to ship|needs work/)).toBeTruthy();
    expect(screen.getByText(/Over the -3 dB ceiling/)).toBeTruthy();

    rerender(<LevelCheck blob={second} analyze={() => Promise.resolve(HOT)} />);
    expect(screen.queryByText(/Over the -3 dB ceiling/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check levels' })).toBeTruthy();
  });

  it('matches a failing take and saves the fixed copy with its captions', async () => {
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    const after = { seconds: 10, peakDb: -3, rmsDb: -20, noiseFloorDb: -80 };
    const saveMatchedTake = vi.fn(() => Promise.resolve());
    const onTakeSaved = vi.fn();
    render(
      <LevelCheck
        blob={blob}
        takeName="Chapter 1"
        captions={{ srt: 'srt', vtt: 'vtt' }}
        onTakeSaved={onTakeSaved}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={(input, standardId) => {
          expect(input).toBe(blob);
          expect(standardId).toBe('audiobook');
          return Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after,
            gainDb: -2,
            peakLimited: true,
          });
        }}
        saveMatchedTake={saveMatchedTake}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    const matchButton = await screen.findByRole('button', { name: 'Match Audiobook' });
    fireEvent.click(matchButton);

    expect(await screen.findByText(/Chapter 1 — Audiobook match/)).toBeTruthy();
    expect(saveMatchedTake).toHaveBeenCalledWith({
      name: 'Chapter 1 — Audiobook match',
      duration: 10,
      blob: expect.any(Blob),
      captions: { srt: 'srt', vtt: 'vtt' },
    });
    expect(onTakeSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/peak limited/)).toBeTruthy();
  });

  it('reports matcher failures instead of hanging on Matching', async () => {
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    render(
      <LevelCheck
        blob={blob}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={() => Promise.reject(new Error('No audible speech to match.'))}
        saveMatchedTake={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Match Audiobook' }));
    expect(await screen.findByText('No audible speech to match.')).toBeTruthy();
  });

  it('reports analyzer failures instead of hanging on Checking', async () => {
    const blob = new Blob(['broken'], { type: 'audio/wav' });
    render(
      <LevelCheck
        blob={blob}
        analyze={() => Promise.reject(new Error('Cannot read this file.'))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    expect(await screen.findByText('Cannot read this file.')).toBeTruthy();
  });

  it('checks ACX edges for audiobooks and fixes them on match', async () => {
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    // Loudness passes; only the edges fail — Match is still offered.
    const passing = { seconds: 10, peakDb: -4, rmsDb: -20, noiseFloorDb: -80 };
    render(
      <LevelCheck
        blob={blob}
        takeName="Chapter 1"
        analyze={() => Promise.resolve(passing)}
        measureEndsAudio={() => Promise.resolve({ headMs: 40, tailMs: 40 })}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: passing,
            after: passing,
            gainDb: 0,
            peakLimited: false,
            beforeEnds: { headMs: 40, tailMs: 40 },
            afterEnds: { headMs: 750, tailMs: 2000 },
            endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: false },
          })
        }
        saveMatchedTake={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    expect(await screen.findByText(/0\.50–1\.00 s/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Match Audiobook' }));
    expect(await screen.findByText(/Edges fixed to 0\.75 s head/)).toBeTruthy();
  });

  it('tells the user captions moved with the new head', async () => {
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    render(
      <LevelCheck
        blob={blob}
        takeName="Chapter 1"
        captions={{ srt: 'srt', vtt: 'vtt' }}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after: { seconds: 10, peakDb: -3, rmsDb: -20, noiseFloorDb: -80 },
            gainDb: -2,
            peakLimited: true,
            endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: false },
          })
        }
        saveMatchedTake={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Match Audiobook' }));
    expect(await screen.findByText(/Captions shifted \+0\.71 s with the new head\./)).toBeTruthy();
    expect(await screen.findByText(/Edges fixed to 0\.75 s head/)).toBeTruthy();
  });

  it('hides the Edges fixed note on the zero-delta no-op path', async () => {
    // A present-but-zero endsFix (skip-when-pass or loud-tone no-op) must
    // never print a fix claim, while the caption note still confirms no move.
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    render(
      <LevelCheck
        blob={blob}
        captions={{ srt: 'srt', vtt: 'vtt' }}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after: { seconds: 10, peakDb: -3, rmsDb: -20, noiseFloorDb: -80 },
            gainDb: -2,
            peakLimited: false,
            endsFix: { headDeltaMs: 0, tailDeltaMs: 0, roomTone: false },
          })
        }
        saveMatchedTake={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Match Audiobook' }));
    expect(await screen.findByText(/Captions unchanged — head already in spec\./)).toBeTruthy();
    expect(screen.queryByText(/Edges fixed/)).toBeNull();
  });

  it('never offers Match for a song take', async () => {
    // Batch Match and caption backfill skip songs; the inline check must too,
    // while still grading the take.
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    const matchAudio = vi.fn(() =>
      Promise.resolve({
        wav: new Blob(['fixed'], { type: 'audio/wav' }),
        before: HOT,
        after: { seconds: 10, peakDb: -3, rmsDb: -20, noiseFloorDb: -80 },
        gainDb: -2,
        peakLimited: false,
      }),
    );
    render(
      <LevelCheck
        blob={blob}
        isSong
        analyze={() => Promise.resolve(HOT)}
        matchAudio={matchAudio}
        saveMatchedTake={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    expect(await screen.findByText(/needs work before export/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Match/ })).toBeNull();
    expect(screen.getByText(/Song mixes skip Match/)).toBeTruthy();
    expect(matchAudio).not.toHaveBeenCalled();
  });

  it('keeps the head spec out of the Ad Spot unchanged note', async () => {
    // Ad spots have no ACX head rebuild; the unchanged note must not cite one.
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    window.localStorage.setItem('chatterbox.loudnessStandard', JSON.stringify('ad'));
    try {
      render(
        <LevelCheck
          blob={blob}
          captions={{ srt: 'srt', vtt: 'vtt' }}
          analyze={() => Promise.resolve(HOT)}
          matchAudio={(_input, standardId) => {
            expect(standardId).toBe('ad');
            return Promise.resolve({
              wav: new Blob(['fixed'], { type: 'audio/wav' }),
              before: HOT,
              after: { seconds: 10, peakDb: -3, rmsDb: -16, noiseFloorDb: -80 },
              gainDb: -2,
              peakLimited: false,
            });
          }}
          saveMatchedTake={() => Promise.resolve()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Match Ad Spot' }));
      expect(await screen.findByText(/Captions unchanged\./)).toBeTruthy();
      expect(screen.queryByText(/head already in spec/)).toBeNull();
    } finally {
      window.localStorage.removeItem('chatterbox.loudnessStandard');
    }
  });

  it('tells the user captions stayed put when the head was already in spec', async () => {
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    render(
      <LevelCheck
        blob={blob}
        captions={{ srt: 'srt', vtt: 'vtt' }}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after: { seconds: 10, peakDb: -3, rmsDb: -20, noiseFloorDb: -80 },
            gainDb: -2,
            peakLimited: false,
          })
        }
        saveMatchedTake={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Match Audiobook' }));
    expect(await screen.findByText(/Captions unchanged — head already in spec\./)).toBeTruthy();
  });

  it('skips the edge check for ad spots', async () => {
    const blob = new Blob(['hot'], { type: 'audio/wav' });
    const passing = { seconds: 10, peakDb: -1, rmsDb: -16, noiseFloorDb: -80 };
    const measureEndsAudio = vi.fn(() => Promise.resolve({ headMs: 40, tailMs: 40 }));
    window.localStorage.setItem('chatterbox.loudnessStandard', JSON.stringify('ad'));
    try {
      render(<LevelCheck blob={blob} analyze={() => Promise.resolve(passing)} measureEndsAudio={measureEndsAudio} />);
      fireEvent.click(screen.getByRole('button', { name: 'Check levels' }));
      await screen.findByText(/ready to ship/);
      expect(screen.queryByText(/Head silence/)).toBeNull();
      expect(measureEndsAudio).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem('chatterbox.loudnessStandard');
    }
  });
});
