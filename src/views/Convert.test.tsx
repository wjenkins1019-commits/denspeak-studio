// @vitest-environment jsdom
// Hand-off wiring: a take queued in Studio must arrive in Convert already
// loaded and playable, instead of leaving the user to export a WAV and pick it
// again. A take sent while Convert is open must land without a remount, say what
// arrived, and leave the replaced take reachable. Rendered under StrictMode, as
// the app is: delivery rests on a subscription effect, so a take must still land
// exactly once when React mounts, cleans up and mounts again.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Convert from './Convert';
import { clearHandoff, sendHandoff } from '../lib/handoff';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  clearHandoff();
  // jsdom has no object URLs; the Player only needs an opaque handle.
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  clearHandoff();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('Convert hand-off', () => {
  it('opens with a take queued for it as the loaded source, once', async () => {
    sendHandoff('convert', {
      name: 'Chapter one',
      blob: new Blob(['take'], { type: 'audio/wav' }),
    });

    render(
      <StrictMode>
        <Convert />
      </StrictMode>,
    );

    expect(await screen.findAllByText('Loaded: Chapter one')).toHaveLength(1);
    // The player only mounts once its effect has made the object URL.
    await act(async () => {});
    expect(document.querySelectorAll('audio')).toHaveLength(1);
    expect(screen.queryByText(/No source yet/)).toBeNull();
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);

    // Consumed by that one delivery, not left queued for the next mount.
    cleanup();
    render(
      <StrictMode>
        <Convert />
      </StrictMode>,
    );
    // Let the new mount's store read settle before saying nothing arrived.
    await act(async () => {});
    expect(screen.queryByText(/Loaded: Chapter one/)).toBeNull();
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });

  it('says what arrived and offers the take it replaced back', () => {
    render(
      <StrictMode>
        <Convert />
      </StrictMode>,
    );

    act(() => sendHandoff('convert', { name: 'First take', blob: new Blob(['a']) }));
    expect(screen.getAllByText('Loaded: First take')).toHaveLength(1);
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);
    expect(document.querySelectorAll('audio')).toHaveLength(1);

    act(() => sendHandoff('convert', { name: 'Second take', blob: new Blob(['b']) }));
    expect(screen.getAllByText('Loaded: Second take')).toHaveLength(1);
    expect(document.querySelectorAll('audio')).toHaveLength(1);
    expect(screen.getByText(/it replaced the take you had/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep the previous take' }));

    expect(screen.getAllByText('Loaded: First take')).toHaveLength(1);
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
  });
});
