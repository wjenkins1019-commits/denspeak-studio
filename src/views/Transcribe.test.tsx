// @vitest-environment jsdom
// Receiver wiring for the hand-off: a take sent while Transcribe is open must
// land without a remount (the hash does not change), and the take it replaced
// must stay one click away. Rendered under StrictMode, as the app is: delivery
// rests on a subscription effect, so a take must still land exactly once when
// React mounts, cleans up and mounts again. Whisper and the export helpers are
// mocked because neither is touched by an arrival.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Transcribe from './Transcribe';
import { clearHandoff, sendHandoff } from '../lib/handoff';

// Two models: the Player defaults to the second entry in the list.
vi.mock('../lib/transcribe', () => ({
  TRANSCRIBE_MODELS: [
    { id: 'tiny', label: 'Tiny', note: 'test' },
    { id: 'base', label: 'Base', note: 'test' },
  ],
  transcribe: vi.fn(),
  transcribeTimed: vi.fn(),
}));

vi.mock('../lib/export', () => ({
  exportFileName: (name: string) => name,
  saveBlob: vi.fn(),
}));

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  clearHandoff();
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  clearHandoff();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('Transcribe hand-off', () => {
  it('takes a second take sent while it is open, and hands the first back', () => {
    render(
      <StrictMode>
        <Transcribe />
      </StrictMode>,
    );

    act(() => sendHandoff('transcribe', { name: 'First take', blob: new Blob(['a']), duration: 3 }));
    expect(screen.getAllByText('First take · 3.0s')).toHaveLength(1);
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);
    expect(document.querySelectorAll('audio')).toHaveLength(1);

    act(() => sendHandoff('transcribe', { name: 'Second take', blob: new Blob(['b']), duration: 5 }));
    expect(screen.getAllByText('Second take · 5.0s')).toHaveLength(1);
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);
    expect(screen.getByText(/it replaced the take you had/)).toBeTruthy();
    expect(document.querySelectorAll('audio')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Keep the previous take' }));

    expect(screen.getAllByText('First take · 3.0s')).toHaveLength(1);
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });
});
