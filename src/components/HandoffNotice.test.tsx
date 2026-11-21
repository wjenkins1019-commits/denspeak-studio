// @vitest-environment jsdom
// The arrival notice is the deliberate way back that a hand-off owes the user:
// replacing the history entry means browser Back no longer reopens the sender,
// so the notice carries the source section and offers it as a button.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HandoffNotice } from './HandoffNotice';

const arrived = { name: 'A take', blob: new Blob(['audio']), from: 'convert' as const };

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('HandoffNotice', () => {
  it('goes back to the section the take came from, without a history entry', () => {
    window.location.hash = '#/transcribe';
    const depth = window.history.length;

    render(<HandoffNotice item={arrived} here="transcribe" replaced={false} onKeep={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Convert' }));

    expect(window.location.hash).toBe('#/convert');
    expect(window.history.length).toBe(depth);
  });

  it('names the sender by its UI label, including the two that only send', () => {
    render(
      <HandoffNotice
        item={{ ...arrived, from: 'studio' }}
        here="song"
        replaced={false}
        onKeep={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Back to Studio' })).toBeTruthy();
  });

  it('offers no way back to the section already on screen', () => {
    render(<HandoffNotice item={arrived} here="convert" replaced={false} onKeep={() => {}} />);

    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy();
  });
});
