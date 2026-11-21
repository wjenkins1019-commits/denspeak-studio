// @vitest-environment jsdom
// Library search-to-jump wiring: the Player test locks search-over-shifted
// captions and Player-honors-startAt separately, but the handoff between
// them lives here — CaptionSearch onJump must open the hit's take and hand
// its timestamp to that take's Player. A decoy take carrying the same words
// at the pre-Match time proves the jump picks the right take and the right
// (shifted) time.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library';
import { formatSRT, formatVTT, offsetStoredCaptions, parseCues } from '../lib/captions';
import { clearHandoff, takeHandoff } from '../lib/handoff';
import type { Take } from '../lib/library';

const { listTakesMock } = vi.hoisted(() => ({ listTakesMock: vi.fn() }));

vi.mock('../lib/library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/library')>();
  return { ...actual, listTakes: listTakesMock };
});

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const mediaProto = HTMLMediaElement.prototype as unknown as Record<PropertyKey, unknown>;
const savedTimeDescriptor = Object.getOwnPropertyDescriptor(mediaProto, 'currentTime');
const savedReadyDescriptor = Object.getOwnPropertyDescriptor(mediaProto, 'readyState');

let soughtTo: number | null;

beforeEach(() => {
  clearHandoff();
  window.location.hash = '#/library';
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  listTakesMock.mockReset();
  soughtTo = null;
  Object.defineProperty(mediaProto, 'currentTime', {
    configurable: true,
    get: () => soughtTo ?? 0,
    set: (value: number) => {
      soughtTo = value;
    },
  });
  Object.defineProperty(mediaProto, 'readyState', { configurable: true, value: 1 });
});

afterEach(() => {
  cleanup();
  clearHandoff();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  if (savedTimeDescriptor) Object.defineProperty(mediaProto, 'currentTime', savedTimeDescriptor);
  if (savedReadyDescriptor) Object.defineProperty(mediaProto, 'readyState', savedReadyDescriptor);
});

function makeTake(id: string, name: string, captions: { srt: string; vtt: string }): Take {
  return {
    id,
    name,
    createdAt: 0,
    duration: 10,
    kind: 'render',
    blob: new Blob(['audio'], { type: 'audio/wav' }),
    captions,
  } as Take;
}

describe('Library send-on', () => {
  it('queues a saved take for the section picked and opens that section', async () => {
    listTakesMock.mockResolvedValue([
      makeTake('take-a', 'Original take', { srt: '', vtt: '' }),
    ]);

    render(<Library />);
    expect(await screen.findByText('Original take')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Shape' }));

    expect(window.location.hash).toBe('#/process');
    expect((await takeHandoff('process'))?.name).toBe('Original take');
    expect(await takeHandoff('convert')).toBeNull();
  });
});

describe('Library caption search jump', () => {
  it('opens the hit take and seeks its Player to the shifted time', async () => {
    // The shift math is locked in captions.test.ts; a fixed representative
    // head delta stands in for the post-Match copy here — this test owns the
    // search-to-Player handoff, not the DSP.
    const originalCues = [{ start: 0.04, end: 0.44, text: 'hello world' }];
    const shifted = offsetStoredCaptions(
      { srt: formatSRT(originalCues), vtt: formatVTT(originalCues) },
      0.71,
    );
    const shiftedStart = parseCues(shifted.srt)[0].start;
    expect(shiftedStart).toBe(0.75);

    const takeA = makeTake('take-a', 'Original take', {
      srt: formatSRT(originalCues),
      vtt: formatVTT(originalCues),
    });
    const takeB = makeTake('take-b', 'Matched copy', shifted);
    listTakesMock.mockResolvedValue([takeA, takeB]);

    render(<Library />);
    expect(await screen.findByText('Matched copy')).toBeTruthy();

    // Both takes match; hits follow take order, so the second row is the copy.
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'hello' } });
    const jumpButtons = await screen.findAllByRole('button', { name: /Hear it/ });
    expect(jumpButtons).toHaveLength(2);
    fireEvent.click(jumpButtons[1]);

    // The copy's Player opened and sought to the shifted cue — not 0:00 and
    // not the original's pre-Match time.
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('No Player audio element after jump');
    expect(audio.closest('.card')?.textContent).toContain('Matched copy');
    expect(soughtTo).toBe(shiftedStart);
    expect(soughtTo).not.toBe(0.04);
  });
});
