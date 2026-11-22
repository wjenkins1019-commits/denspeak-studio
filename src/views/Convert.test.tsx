// @vitest-environment jsdom
// Hand-off wiring: a take queued in Studio must arrive in Convert already
// loaded and playable, instead of leaving the user to export a WAV and pick it
// again. A take sent while Convert is open must land without a remount, say what
// arrived, and leave the replaced take reachable. Rendered under StrictMode, as
// the app is: delivery rests on a subscription effect, so a take must still land
// exactly once when React mounts, cleans up and mounts again.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Convert from './Convert';
import { clearHandoff, pendingCount, sendHandoff, setHandoffStore } from '../lib/handoff';
import type { HandoffRecord } from '../lib/handoffStore';

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
  setHandoffStore(null);
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
    // The player only mounts once its effect has made the object URL: wait for
    // the element the effect mounts, rather than assuming a tick ran it.
    await waitFor(() => expect(document.querySelectorAll('audio')).toHaveLength(1));
    expect(screen.queryByText(/No source yet/)).toBeNull();
    expect(screen.getAllByText(/Arrived from another section/)).toHaveLength(1);

    // Consumed by that one delivery, not left queued for the next mount.
    cleanup();
    render(
      <StrictMode>
        <Convert />
      </StrictMode>,
    );
    // The new mount reads an empty store, so the empty hint is what says the
    // mount settled — before it, saying nothing arrived proves nothing.
    expect(await screen.findByText(/No source yet/)).toBeTruthy();
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

  it('takes one take when Next take is clicked twice before the claim lands', async () => {
    // Queued before the visit, so there is a queue behind the one it opens with.
    for (const name of ['First take', 'Second take', 'Third take']) {
      sendHandoff('convert', { name, blob: new Blob([name]) });
    }

    render(
      <StrictMode>
        <Convert />
      </StrictMode>,
    );

    expect(await screen.findByText(/Arrived from another section: First take/)).toBeTruthy();
    expect(screen.getByText(/2 more waiting/)).toBeTruthy();

    // The second click arrives while the first take's row is still being
    // deleted. It is the same request, not a request for the take behind it.
    const next = screen.getByRole('button', { name: 'Next take' });
    await act(async () => {
      fireEvent.click(next);
      fireEvent.click(next);
    });

    expect(screen.getByText(/Arrived from another section: Second take/)).toBeTruthy();
    expect(screen.getByText(/1 more waiting/)).toBeTruthy();

    // The take the second click would have claimed is still there to take.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
    });
    expect(screen.getByText(/Arrived from another section: Third take/)).toBeTruthy();
    expect(screen.queryByText(/more waiting/)).toBeNull();
  });

  it('puts back a Next-take claim when the view is gone before the delete lands', async () => {
    // The first two deletes wait for the test; later ones go through, so a
    // later visit can take what is put back.
    const releases: Array<() => void> = [];
    const rows = new Map<string, HandoffRecord>();
    let gatedRemoves = 2;
    setHandoffStore({
      async list(): Promise<HandoffRecord[]> {
        return [...rows.values()];
      },
      async put(record: HandoffRecord): Promise<void> {
        rows.set(record.key, record);
      },
      remove(key: string): Promise<void> {
        if (gatedRemoves > 0) {
          gatedRemoves -= 1;
          return new Promise<void>((resolve) => {
            releases.push(() => {
              rows.delete(key);
              resolve();
            });
          });
        }
        rows.delete(key);
        return Promise.resolve();
      },
    });
    sendHandoff('convert', { name: 'First take', blob: new Blob(['a']) });
    sendHandoff('convert', { name: 'Second take', blob: new Blob(['b']) });

    // A plain render: one subscription, so one claim at a time.
    const { unmount } = render(<Convert />);
    // The visit's own claim has to land before there is a Next take to press:
    // wait for its delete to be under way, then let it through. The claim
    // waits for the sends' puts first, so the delete is not there in the
    // same tick as the render.
    await waitFor(() => expect(releases.length).toBe(1));
    await act(async () => {
      releases.shift()?.();
    });
    expect(await screen.findByText(/Arrived from another section: First take/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
    });
    // The claim is in flight: the second take is out of the queue already,
    // its row still waiting on the delete.
    await waitFor(() => expect(releases.length).toBe(1));
    expect(pendingCount('convert')).toBe(0);

    // Navigating away unmounts the view before that delete lands.
    act(() => {
      unmount();
    });
    await act(async () => {
      releases.shift()?.();
    });

    // The take is still queued rather than lost with the view: a later visit
    // takes it instead of finding nothing.
    expect(pendingCount('convert')).toBe(1);
    render(<Convert />);
    expect(await screen.findByText(/Arrived from another section: Second take/)).toBeTruthy();
  });
});
