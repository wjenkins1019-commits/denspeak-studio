// @vitest-environment jsdom
// Receiver wiring for the hand-off: a take sent while Transcribe is open must
// land without a remount (the hash does not change), and the take it replaced
// must stay one click away. Whisper and the export helpers are mocked because
// neither is touched by an arrival.
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
    render(<Transcribe />);

    act(() => sendHandoff('transcribe', { name: 'First take', blob: new Blob(['a']), duration: 3 }));
    expect(screen.getByText('First take · 3.0s')).toBeTruthy();

    act(() => sendHandoff('transcribe', { name: 'Second take', blob: new Blob(['b']), duration: 5 }));
    expect(screen.getByText('Second take · 5.0s')).toBeTruthy();
    expect(screen.getByText(/it replaced the take you had/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep the previous take' }));

    expect(screen.getByText('First take · 3.0s')).toBeTruthy();
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });
});
