// @vitest-environment jsdom
// Hand-off wiring: a take queued in Studio must arrive in Convert already
// loaded and playable, instead of leaving the user to export a WAV and pick it
// again. The store's own delivery rules are covered in src/lib/handoff.test.ts;
// this test owns the receiving view.
import { cleanup, render, screen } from '@testing-library/react';
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
  it('opens with a take queued for it as the loaded source, player and all', async () => {
    sendHandoff('convert', {
      name: 'Chapter one',
      blob: new Blob(['take'], { type: 'audio/wav' }),
    });

    render(<Convert />);

    expect(await screen.findByText('Loaded: Chapter one')).toBeTruthy();
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.isConnected).toBe(true);
    expect(screen.queryByText(/No source yet/)).toBeNull();
  });
});
