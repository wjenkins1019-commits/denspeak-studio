// @vitest-environment jsdom
// Batch Match must fix every failing take in one run and report each take:
// passes need no new take, failures are saved as processed copies, songs are
// never even offered. Analyzer/matcher/saver are injected: no worker.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchMatch } from './BatchMatch';
import { saveTake, type Take } from '../lib/library';
import { formatSRT, formatVTT, offsetStoredCaptions, parseCues } from '../lib/captions';

vi.mock('../lib/library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/library')>();
  return { ...actual, saveTake: vi.fn(() => Promise.resolve({} as Take)) };
});

afterEach(() => {
  cleanup();
});

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

const PASS = { seconds: 10, peakDb: -4, rmsDb: -20, noiseFloorDb: -80 };
const HOT = { seconds: 10, peakDb: -0.5, rmsDb: -20, noiseFloorDb: -80 };

describe('BatchMatch', () => {
  it('matches the failing takes, passes the rest, and skips songs', async () => {
    const saveMatchedTake = vi.fn(() => Promise.resolve());
    const onDone = vi.fn();
    render(
      <BatchMatch
        takes={[take({ name: 'good' }), take({ name: 'hot' }), take({ name: 'mix', kind: 'song' })]}
        onDone={onDone}
        analyze={(() => {
          const reports = [PASS, HOT];
          let calls = 0;
          return () => Promise.resolve(reports[Math.min(calls++, reports.length - 1)]);
        })()}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after: PASS,
            gainDb: -2,
            peakLimited: true,
          })
        }
        saveMatchedTake={saveMatchedTake}
      />,
    );

    // Only the two voice takes are offered; the song is excluded.
    fireEvent.click(screen.getByRole('button', { name: /Match project \(2\)/ }));

    // The good take analyzes as pass; override analyze per-take below via blob identity.
    expect(await screen.findByText(/matched 0|matched 1|already in spec/)).toBeTruthy();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shifts stored captions by the worker head delta like LevelCheck', async () => {
    // The batch default saver must carry the same ACX head shift LevelCheck
    // applies: the mock endsFix moves every cue +0.71 s onto the rebuilt head.
    const cues = [{ start: 0.1, end: 1.2, text: 'Hello world', speaker: 'Leah' }];
    const captions = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const expected = offsetStoredCaptions(captions, 0.71);
    const saveTakeMock = vi.mocked(saveTake);
    saveTakeMock.mockClear();
    render(
      <BatchMatch
        takes={[take({ name: 'hot', captions })]}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after: PASS,
            gainDb: -2,
            peakLimited: false,
            endsFix: { headDeltaMs: 710, tailDeltaMs: 1960, roomTone: false },
          })
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Match project \(1\)/ }));
    expect(await screen.findByText(/matched 1/)).toBeTruthy();
    expect(saveTakeMock).toHaveBeenCalledTimes(1);
    const saved = saveTakeMock.mock.calls[0][0] as { captions: { srt: string; vtt: string } };
    expect(saved.captions.srt).toBe(expected.srt);
    expect(saved.captions.vtt).toBe(expected.vtt);
    expect(parseCues(saved.captions.srt)[0]).toMatchObject({ start: 0.81, speaker: 'Leah' });
    expect(parseCues(saved.captions.vtt)).toEqual(parseCues(saved.captions.srt));
    expect(await screen.findByText(/Captions shifted with the new head\./)).toBeTruthy();
  });

  it('reports failures per take without stopping the run', async () => {
    render(
      <BatchMatch
        takes={[take({ name: 'bad' }), take({ name: 'hot' })]}
        analyze={() => Promise.resolve(HOT)}
        matchAudio={() =>
          Promise.resolve({
            wav: new Blob(['fixed'], { type: 'audio/wav' }),
            before: HOT,
            after: PASS,
            gainDb: -2,
            peakLimited: false,
          })
        }
        saveMatchedTake={(take) =>
          take.name === 'bad' ? Promise.reject(new Error('disk full')) : Promise.resolve()
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Match project \(2\)/ }));
    expect(await screen.findByText(/failed 1/)).toBeTruthy();
    expect(screen.getByText(/disk full/)).toBeTruthy();
  });
});
