// @vitest-environment jsdom
// The arrival notice is the deliberate way back that a hand-off owes the user:
// replacing the history entry means browser Back no longer reopens the sender,
// so the notice names the source section and goes there carrying the take.
// Which section the notice is in comes from the route, never from a prop, so a
// sender can never be offered a way "back" to itself.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HandoffNotice } from './HandoffNotice';
import { clearHandoff, HANDOFF_TARGETS, takeHandoff } from '../lib/handoff';

const arrived = { name: 'A take', blob: new Blob(['audio']), from: 'convert' as const };

afterEach(() => {
  cleanup();
  clearHandoff();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('HandoffNotice', () => {
  it('goes back to the sender with the take, without a history entry', () => {
    window.history.replaceState(null, '', '#/transcribe');
    const depth = window.history.length;

    render(<HandoffNotice item={arrived} replaced={false} onKeep={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Convert' }));

    expect(window.location.hash).toBe('#/convert');
    expect(window.history.length).toBe(depth);
    // The sender unmounted when the take left it, so reopening its route alone
    // would land on an empty section. The take has to come back too.
    expect(takeHandoff('convert')).toEqual(arrived);
  });

  it('names the sender by its UI label, and queues nothing for a section that keeps its own work', () => {
    window.history.replaceState(null, '', '#/song');

    render(<HandoffNotice item={{ ...arrived, from: 'studio' }} replaced={false} onKeep={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Studio' }));

    expect(window.location.hash).toBe('#/studio');
    // Studio keeps its projects on disk. A take queued at a section that only
    // ever sends would sit there and land unasked on some later visit.
    for (const { target } of HANDOFF_TARGETS) expect(takeHandoff(target)).toBeNull();
  });

  it('offers no way back when the route already says this is the sender', () => {
    window.history.replaceState(null, '', '#/convert');

    render(<HandoffNotice item={arrived} replaced={false} onKeep={() => {}} />);

    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy();
  });
});
