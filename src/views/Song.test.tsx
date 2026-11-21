// @vitest-environment jsdom
// Receiver wiring for the hand-off: a beat sent while Song is open must land
// without a remount, and the beat it replaced must stay one click away. Decoding
// and tempo detection are stubbed so the arrival resolves without real audio.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Song from './Song';
import { clearHandoff, sendHandoff } from '../lib/handoff';

vi.mock('../lib/tts', () => ({
  renderSpeech: vi.fn(async () => new Blob(['tts'])),
}));

vi.mock('../lib/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/audio')>();
  return {
    ...actual,
    decodeToMono: vi.fn(async () => ({ samples: new Float32Array(1024), sampleRate: 22050 })),
  };
});

vi.mock('../lib/beat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/beat')>();
  return {
    ...actual,
    detectTempo: vi.fn(() => ({ bpm: 90, offset: 0.1, confidence: 0.9, seconds: 2 })),
  };
});

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  clearHandoff();
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // jsdom has no animation frames; readBeat waits for one before detecting tempo.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  clearHandoff();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('Song hand-off', () => {
  it('takes a second beat sent while it is open, and hands the first back', async () => {
    render(<Song />);

    await act(async () => {
      sendHandoff('song', { name: 'First beat', blob: new Blob(['a']), duration: 2 });
    });
    // The name shows twice: once beside the file input, once on the player.
    expect(await screen.findAllByText('First beat')).toHaveLength(2);

    await act(async () => {
      sendHandoff('song', { name: 'Second beat', blob: new Blob(['b']), duration: 4 });
    });
    expect(await screen.findAllByText('Second beat')).toHaveLength(2);
    expect(screen.getByText(/it replaced the take you had/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep the previous take' }));

    expect(screen.getAllByText('First beat')).toHaveLength(2);
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });
});
