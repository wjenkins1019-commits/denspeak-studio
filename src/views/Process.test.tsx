// @vitest-environment jsdom
// Receiver wiring for the hand-off: a take sent while Shape is open must land
// without a remount, and the sample it replaced must stay one click away. The
// TTS engine is mocked; an arrival never renders speech.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Process from './Process';
import { clearHandoff, sendHandoff } from '../lib/handoff';

vi.mock('../lib/tts', () => ({
  renderSpeech: vi.fn(async () => new Blob(['tts'])),
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

describe('Shape hand-off', () => {
  it('takes a second take sent while it is open, and hands the first back', () => {
    render(<Process />);

    act(() => sendHandoff('process', { name: 'First sample', blob: new Blob(['a']), duration: 2 }));
    expect(screen.getByText('First sample loaded. Shape it, then apply.')).toBeTruthy();

    act(() => sendHandoff('process', { name: 'Second sample', blob: new Blob(['b']), duration: 4 }));
    expect(screen.getByText('Second sample loaded. Shape it, then apply.')).toBeTruthy();
    expect(screen.getByText(/it replaced the take you had/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep the previous take' }));

    expect(screen.getByText('First sample loaded. Shape it, then apply.')).toBeTruthy();
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });
});
