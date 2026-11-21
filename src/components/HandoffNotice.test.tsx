// @vitest-environment jsdom
// The arrival notice is the deliberate way back that a hand-off owes the user:
// replacing the history entry means browser Back no longer reopens the sender,
// so the notice names the source section and goes there carrying the take.
// Which section the notice is in comes from the route, never from a prop, so a
// sender can never be offered a way "back" to itself.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffNotice, HandoffStatus, WaitingTakes } from './HandoffNotice';
import type { HandoffTake } from '../lib/useHandoffTake';
import { clearHandoff, HANDOFF_TARGETS, takeHandoff } from '../lib/handoff';

const arrived = { name: 'A take', blob: new Blob(['audio']), from: 'convert' as const };

/** A section's take and queue, for rendering the region without a section. */
const handoff = (overrides: Partial<HandoffTake<null>> = {}): HandoffTake<null> => ({
  arrival: null,
  waiting: 0,
  failed: false,
  next: () => {},
  retry: () => {},
  keep: () => {},
  ...overrides,
});

afterEach(() => {
  cleanup();
  clearHandoff();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('HandoffNotice', () => {
  it('goes back to the sender with the take, without a history entry', async () => {
    window.history.replaceState(null, '', '#/transcribe');
    const depth = window.history.length;

    render(<HandoffNotice item={arrived} replaced={false} onKeep={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Convert' }));

    expect(window.location.hash).toBe('#/convert');
    expect(window.history.length).toBe(depth);
    // The sender unmounted when the take left it, so reopening its route alone
    // would land on an empty section. The take has to come back too.
    expect(await takeHandoff('convert')).toEqual({ ...arrived, returned: true });
  });

  it('carries the take back into the Studio, which takes one', async () => {
    window.history.replaceState(null, '', '#/process');

    render(<HandoffNotice item={{ ...arrived, from: 'studio' }} replaced={false} onKeep={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Studio' }));

    expect(window.location.hash).toBe('#/studio');
    expect(await takeHandoff('studio')).toEqual({ ...arrived, from: 'studio', returned: true });
  });

  it('only opens a section that keeps its own work', async () => {
    window.history.replaceState(null, '', '#/song');

    render(<HandoffNotice item={{ ...arrived, from: 'library' }} replaced={false} onKeep={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Library' }));

    expect(window.location.hash).toBe('#/library');
    // Library holds its takes in the database. A take queued at a section that
    // only ever sends would sit there and land unasked on some later visit.
    for (const { target } of HANDOFF_TARGETS) expect(await takeHandoff(target)).toBeNull();
  });

  it('offers no way back when the route already says this is the sender', () => {
    window.history.replaceState(null, '', '#/convert');

    render(<HandoffNotice item={arrived} replaced={false} onKeep={() => {}} />);

    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy();
  });

  it('confirms the take is home when a section sent it back', () => {
    window.history.replaceState(null, '', '#/convert');

    render(<HandoffNotice item={{ ...arrived, returned: true }} replaced={false} onKeep={() => {}} />);

    // The section that gets its own take back was not sent anything new, and
    // the button is only there to dismiss a line it already knows.
    expect(screen.getByText(/Your take is back: A take/)).toBeTruthy();
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy();
  });

  it('says how many takes are still waiting and offers the next one', () => {
    window.history.replaceState(null, '', '#/convert');
    const next = vi.fn();

    render(<HandoffNotice item={arrived} replaced={false} waiting={2} onNext={next} onKeep={() => {}} />);

    expect(screen.getByText(/2 more waiting/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps the rest of the queue reachable once the notice is dismissed', () => {
    const next = vi.fn();
    const { rerender } = render(<WaitingTakes waiting={2} onNext={next} />);

    expect(screen.getByText('2 more waiting')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
    expect(next).toHaveBeenCalledTimes(1);

    // Nothing left: the row goes away rather than sitting there counting zero.
    rerender(<WaitingTakes waiting={0} onNext={next} />);
    expect(screen.queryByText(/more waiting/)).toBeNull();
  });

  it('keeps the arrival wording for a forward hand-off', () => {
    window.history.replaceState(null, '', '#/song');

    render(<HandoffNotice item={arrived} replaced={false} onKeep={() => {}} />);

    expect(screen.getByText(/Arrived from another section: A take/)).toBeTruthy();
    expect(screen.queryByText(/Your take is back/)).toBeNull();
  });

  it('reports a failed next take under the notice, in a region already on the page', () => {
    window.history.replaceState(null, '', '#/song');
    const onScreen = { item: arrived, before: null };

    // Nothing has failed yet, but the region that will speak is already on the
    // page and empty: filling a region a screen reader knows about is what gets
    // announced, while a region inserted already holding its news is not.
    const { rerender } = render(<HandoffStatus handoff={handoff({ waiting: 1 })} />);
    const [empty] = screen.getAllByRole('status');
    expect(empty.textContent).toBe('');

    rerender(<HandoffStatus handoff={handoff({ arrival: onScreen, waiting: 1 })} />);
    const [notice] = screen.getAllByRole('status');
    const noticeText = notice.textContent;

    // A next take fails: one message is added, and the notice for the take on
    // screen is the same node saying the same thing, so it is not read twice.
    rerender(<HandoffStatus handoff={handoff({ arrival: onScreen, waiting: 1, failed: true })} />);
    const [stillNotice, failure] = screen.getAllByRole('status');

    expect(stillNotice).toBe(notice);
    expect(stillNotice.textContent).toBe(noticeText);
    expect(failure.textContent).toContain('wouldn’t clear, so it is still waiting');
    expect(failure.textContent).toContain('Try again');
    // What is read aloud is the new news only, not a second telling of the
    // arrival or of the count behind it.
    expect(failure.textContent).not.toContain('Arrived from another section');
    expect(failure.textContent).not.toContain('1 more waiting');
  });

  it('announces an arrival from a region already on the page', () => {
    window.history.replaceState(null, '', '#/song');

    // The region that carries the arrival is on screen and empty before any take
    // lands: a screen reader has already found it, so filling it is the change
    // that gets read out.
    const { rerender } = render(<HandoffStatus handoff={handoff()} />);
    const [arrivals] = screen.getAllByRole('status');
    expect(arrivals.textContent).toBe('');

    rerender(
      <HandoffStatus handoff={handoff({ arrival: { item: arrived, before: null }, waiting: 2 })} />,
    );

    const [filled] = screen.getAllByRole('status');
    expect(filled).toBe(arrivals);
    expect(filled.textContent).toContain('Arrived from another section: A take');
    expect(filled.textContent).toContain('2 more waiting');
  });
});
