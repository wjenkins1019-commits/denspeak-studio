// @vitest-environment jsdom
// Receiver wiring for the hand-off: a take sent while Shape is open must land
// without a remount, and the sample it replaced must stay one click away.
// Rendered under StrictMode, as the app is: delivery rests on a subscription
// effect, so a take must still land exactly once when React mounts, cleans up
// and mounts again. The TTS engine is mocked; an arrival never renders speech.
import { StrictMode } from 'react';
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
    render(
      <StrictMode>
        <Process />
      </StrictMode>,
    );

    act(() => sendHandoff('process', { name: 'First sample', blob: new Blob(['a']), duration: 2 }));
    expect(screen.getAllByText('First sample loaded. Shape it, then apply.')).toHaveLength(1);
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);
    expect(document.querySelectorAll('audio')).toHaveLength(1);

    act(() => sendHandoff('process', { name: 'Second sample', blob: new Blob(['b']), duration: 4 }));
    expect(screen.getAllByText('Second sample loaded. Shape it, then apply.')).toHaveLength(1);
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);
    expect(screen.getByText(/it replaced the take you had/)).toBeTruthy();
    expect(document.querySelectorAll('audio')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Keep the previous take' }));

    expect(screen.getAllByText('First sample loaded. Shape it, then apply.')).toHaveLength(1);
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });
});
