// @vitest-environment jsdom
// The hand-off router path, end to end: sendTake replaces the history entry, and
// the fragment-only replaceState must reach App's hashchange listener so the
// target section mounts and takes the item. The strip's own test only shows the
// hash and history depth; this one shows the section on screen changing.
// Rendered under StrictMode, as the app is.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearHandoff, sendTake } from './lib/handoff';

vi.mock('./lib/tts', () => ({
  renderSpeech: vi.fn(async () => new Blob(['tts'])),
}));

// Two models: Player defaults to the second entry in the list.
vi.mock('./lib/transcribe', () => ({
  TRANSCRIBE_MODELS: [
    { id: 'tiny', label: 'Tiny', note: 'test' },
    { id: 'base', label: 'Base', note: 'test' },
  ],
  transcribe: vi.fn(),
  transcribeTimed: vi.fn(),
}));

vi.mock('./lib/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/audio')>();
  return {
    ...actual,
    decodeToMono: vi.fn(async () => ({ samples: new Float32Array(1024), sampleRate: 22050 })),
  };
});

vi.mock('./lib/beat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/beat')>();
  return {
    ...actual,
    detectTempo: vi.fn(() => ({ bpm: 90, offset: 0, confidence: 0.9, seconds: 1 })),
  };
});

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  clearHandoff();
  // Set the starting route without the event a hash assignment would leave
  // queued: a stale hashchange arriving mid-test would swap sections on its own
  // and hide a hand-off that failed to reach the router.
  window.history.replaceState(null, '', '#/convert');
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // jsdom has no animation frames; decoding a beat waits for one.
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
  window.history.replaceState(null, '', window.location.pathname);
});

describe('hand-off navigation', () => {
  it('swaps App to the section the take was sent to', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Change a recording' })).toBeTruthy();

    await act(async () => {
      sendTake('song', { name: 'A take', blob: new Blob(['a']), duration: 1 });
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Rap over your beat' })).toBeTruthy();
    expect(window.location.hash).toBe('#/song');
    expect(screen.queryByRole('heading', { level: 1, name: 'Change a recording' })).toBeNull();
  });

  it('takes the notice\'s way back to the section the take came from', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await act(async () => {
      sendTake('song', { name: 'A take', blob: new Blob(['a']), duration: 1, from: 'convert' });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Rap over your beat' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to Convert' }));
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Change a recording' })).toBeTruthy();
    expect(window.location.hash).toBe('#/convert');
    // The sender unmounted when the take left it, so the way back has to bring
    // the take with it rather than land on an empty section.
    expect(await screen.findByText(/^Loaded: A take$/)).toBeTruthy();
  });
});
