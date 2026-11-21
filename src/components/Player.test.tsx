// @vitest-environment jsdom
// Regression test for the stale-caption bug: ready SRT/VTT downloads must
// never belong to a previous take. The Player resets its caption state to
// idle whenever a new audio blob arrives; this test renders that contract
// instead of trusting it.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Player } from './Player';
import { formatSRT, formatVTT, offsetStoredCaptions } from '../lib/captions';
import { ensureAcxEnds } from '../lib/acx';
import { searchTakeCaptions, searchTokens } from '../lib/captionSearch';
import type { Take } from '../lib/library';

const { transcribeTimedMock, updateTakeCaptionsMock } = vi.hoisted(() => ({
  transcribeTimedMock: vi.fn(),
  updateTakeCaptionsMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/transcribe', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/transcribe')>();
  return { ...original, transcribeTimed: transcribeTimedMock };
});

vi.mock('../lib/library', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/library')>();
  return { ...original, updateTakeCaptions: updateTakeCaptionsMock };
});

const PRECOMPUTED = {
  srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
  vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
};

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  // jsdom has no object URLs; the Player only needs opaque handles.
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

beforeEach(() => {
  transcribeTimedMock.mockReset();
  updateTakeCaptionsMock.mockClear();
});

describe('Player caption reset', () => {
  it('returns to idle Captions when a new blob arrives after ready', () => {
    const first = new Blob(['first'], { type: 'audio/wav' });
    const second = new Blob(['second'], { type: 'audio/wav' });
    const { rerender } = render(<Player blob={first} name="take" captions={PRECOMPUTED} />);

    fireEvent.click(screen.getByRole('button', { name: 'Captions' }));
    expect(screen.getByRole('button', { name: 'Download SRT' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download VTT' })).toBeTruthy();

    rerender(<Player blob={second} name="take" captions={PRECOMPUTED} />);

    expect(screen.queryByRole('button', { name: 'Download SRT' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download VTT' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Captions' })).toBeTruthy();
  });

  it('writes a successful Whisper fallback back onto the take', async () => {
    transcribeTimedMock.mockResolvedValue([{ text: 'hello world', timestamp: [0, 1] }]);
    const blob = new Blob(['old take'], { type: 'audio/wav' });
    render(<Player blob={blob} name="old-take" takeId="take-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Captions' }));
    expect(await screen.findByRole('button', { name: 'Download SRT' })).toBeTruthy();

    expect(updateTakeCaptionsMock).toHaveBeenCalledTimes(1);
    const [id, heard] = updateTakeCaptionsMock.mock.calls[0] as unknown as [
      string,
      { srt: string; vtt: string },
    ];
    expect(id).toBe('take-1');
    expect(heard.srt).toContain('hello world');
    expect(heard.vtt).toContain('WEBVTT');
  });

  it('search and seek land on shifted post-Match times, not the originals', () => {
    // End-to-end wiring: the Match head rebuild shifts stored captions, search
    // reads the matched take, and the Player seeks to the hit — never the
    // pre-Match time.
    const RATE = 22_050;
    const peak = Math.pow(10, -12 / 20);
    const headLen = Math.round(0.04 * RATE);
    const tailLen = Math.round(0.04 * RATE);
    const bodyLen = Math.round(1.5 * RATE);
    const samples = new Float32Array(headLen + bodyLen + tailLen);
    for (let i = 0; i < bodyLen; i += 1) {
      samples[headLen + i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * peak;
    }
    let onset = -1;
    for (let i = 0; i < samples.length; i += 1) {
      if (Math.abs(samples[i]) >= 0.02) {
        onset = i / RATE;
        break;
      }
    }
    expect(onset).toBeGreaterThan(0);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world' },
      { start: onset + 0.5, end: onset + 1.0, text: 'second line' },
    ];
    const original = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const fixed = ensureAcxEnds(samples, RATE);
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    expect(headDeltaSeconds).toBeGreaterThan(0.5);
    const shifted = offsetStoredCaptions(original, headDeltaSeconds);
    const roundMs = (value: number): number => Math.round(value * 1000) / 1000;

    // Search reads the matched take's stored captions.
    const matchedTake = { id: 'matched', name: 'Matched', captions: shifted } as Take;
    const hits = searchTakeCaptions(matchedTake, searchTokens('hello'));
    expect(hits).toHaveLength(1);
    expect(hits[0].start).toBe(roundMs(onset + headDeltaSeconds));
    expect(hits[0].start).not.toBeCloseTo(onset, 3);

    // The Player seeks to the hit, not the pre-Match time.
    const blob = new Blob(['matched-audio'], { type: 'audio/wav' });
    const { rerender } = render(
      <Player blob={blob} name="Matched" captions={shifted} startAt={null} />,
    );
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('Player rendered no audio element');
    let soughtTo: number | null = null;
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => soughtTo ?? 0,
      set: (value: number) => {
        soughtTo = value;
      },
    });
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    rerender(<Player blob={blob} name="Matched" captions={shifted} startAt={hits[0].start} />);
    expect(soughtTo).toBe(hits[0].start);
    expect(soughtTo ?? NaN).not.toBeCloseTo(onset, 3);
  });

  it('seeks on loadedmetadata when the element is not ready yet', () => {
    // readyState 0 (jsdom default): the effect must defer the seek to the
    // metadata listener instead of seeking immediately.
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    render(<Player blob={blob} name="Take" startAt={4.2} />);
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('Player rendered no audio element');
    expect(audio.readyState).toBe(0);
    let soughtTo: number | null = null;
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => soughtTo ?? 0,
      set: (value: number) => {
        soughtTo = value;
      },
    });
    expect(soughtTo).toBeNull();
    act(() => {
      audio.dispatchEvent(new window.Event('loadedmetadata'));
    });
    expect(soughtTo).toBe(4.2);
  });

  it('skips the write when the blob has no library entry', async () => {
    transcribeTimedMock.mockResolvedValue([{ text: 'hello world', timestamp: [0, 1] }]);
    const blob = new Blob(['preview'], { type: 'audio/wav' });
    render(<Player blob={blob} name="preview" />);

    fireEvent.click(screen.getByRole('button', { name: 'Captions' }));
    expect(await screen.findByRole('button', { name: 'Download SRT' })).toBeTruthy();
    expect(updateTakeCaptionsMock).not.toHaveBeenCalled();
  });
});
