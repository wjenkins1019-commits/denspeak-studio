// @vitest-environment jsdom
// The hand-off router path, end to end: sendTake replaces the history entry, and
// the fragment-only replaceState must reach App's hashchange listener so the
// target section mounts and takes the item. The strip's own test only shows the
// hash and history depth; this one shows the section on screen changing.
// Rendered under StrictMode, as the app is.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearHandoff, sendHandoff, sendTake, setHandoffStore } from './lib/handoff';
import type { HandoffRecord, HandoffStore } from './lib/handoffStore';

vi.mock('./lib/tts', () => ({
  renderSpeech: vi.fn(async () => new Blob(['tts'])),
}));

// Two models: Player defaults to the second entry in the list.
vi.mock('./lib/transcribe', () => ({
  TRANSCRIBE_MODELS: [
    { id: 'tiny', label: 'Tiny', note: 'test' },
    { id: 'base', label: 'Base', note: 'test' },
  ],
  transcribe: vi.fn(),
  transcribeTimed: vi.fn(),
}));

vi.mock('./lib/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/audio')>();
  return {
    ...actual,
    decodeToMono: vi.fn(async () => ({ samples: new Float32Array(1024), sampleRate: 22050 })),
  };
});

vi.mock('./lib/beat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/beat')>();
  return {
    ...actual,
    detectTempo: vi.fn(() => ({ bpm: 90, offset: 0, confidence: 0.9, seconds: 1 })),
  };
});

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

/** Storage that can be made to refuse deletes, standing in for a store that will not let a take go. */
class StubbornStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();
  stubborn = true;

  async list(): Promise<HandoffRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.at - b.at);
  }

  async put(record: HandoffRecord): Promise<void> {
    this.rows.set(record.key, record);
  }

  async remove(key: string): Promise<void> {
    if (this.stubborn) throw new Error('the row would not delete');
    this.rows.delete(key);
  }
}

beforeEach(() => {
  clearHandoff();
  // Set the starting route without the event a hash assignment would leave
  // queued: a stale hashchange arriving mid-test would swap sections on its own
  // and hide a hand-off that failed to reach the router.
  window.history.replaceState(null, '', '#/convert');
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // jsdom has no animation frames; decoding a beat waits for one.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  clearHandoff();
  setHandoffStore(null);
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  window.history.replaceState(null, '', window.location.pathname);
});

describe('hand-off navigation', () => {
  it('swaps App to the section the take was sent to', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Change a recording' })).toBeTruthy();

    await act(async () => {
      sendTake('song', { name: 'A take', blob: new Blob(['a']), duration: 1 });
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Rap over your beat' })).toBeTruthy();
    expect(window.location.hash).toBe('#/song');
    expect(screen.queryByRole('heading', { level: 1, name: 'Change a recording' })).toBeNull();
  });

  it('announces a take landing for another section, and not its decrements', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Let the rail's first read settle so it becomes the baseline.
    await act(async () => {});
    const announcer = () => document.getElementById('handoff-announcer');
    expect(announcer()?.getAttribute('role')).toBe('status');
    expect(announcer()?.getAttribute('aria-live')).toBe('polite');
    expect(announcer()?.textContent).toBe('');

    await act(async () => {
      sendHandoff('song', { name: 'First take', blob: new Blob(['a']), duration: 1 });
    });
    expect(announcer()?.textContent).toBe('1 take waiting for Song');

    await act(async () => {
      sendHandoff('song', { name: 'Second take', blob: new Blob(['b']), duration: 2 });
    });
    expect(announcer()?.textContent).toBe('2 takes waiting for Song');

    // Taking one lowers the count; nothing is read for the fall, and the stale
    // line is withdrawn so it cannot be mistaken for the current count.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Song/ }));
    });
    expect(await screen.findByText(/1 more waiting/)).toBeTruthy();
    expect(announcer()?.textContent).toBe('');
  });

  it('opens what is waiting for a section from its rail count, without taking it', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Let the rail's first read of the store settle, so the count below can
    // only come from being told about the send.
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /take waiting/ })).toBeNull();

    await act(async () => {
      sendHandoff('song', {
        name: 'A take',
        blob: new Blob(['a']),
        duration: 1,
        from: 'convert',
      });
    });

    // The rail says where it is waiting, without opening Song to find out.
    const count = screen.getByRole('button', { name: /1 take waiting for Song/ });

    await act(async () => {
      fireEvent.click(count);
    });

    const panel = screen.getByRole('dialog', { name: 'Waiting for Song' });
    expect(panel.textContent).toContain('A take');
    expect(panel.textContent).toContain('from Convert');
    // Reviewing is not taking: the queue and the route are both untouched.
    expect(screen.getByRole('button', { name: /1 take waiting for Song/ })).toBeTruthy();
    expect(window.location.hash).toBe('#/convert');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Song' }));
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Rap over your beat' })).toBeTruthy();
    // Taken now, so there is nothing left to count.
    expect(screen.queryByRole('button', { name: /take waiting for Song/ })).toBeNull();
  });

  it('discards queued takes one at a time, then clears the rest', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await act(async () => {});

    await act(async () => {
      sendHandoff('song', { name: 'First take', blob: new Blob(['a']), duration: 1 });
      sendHandoff('song', { name: 'Second take', blob: new Blob(['b']), duration: 2 });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /2 takes waiting for Song/ }));
    });

    const panel = screen.getByRole('dialog', { name: 'Waiting for Song' });
    // Everything a clear would throw away is named before it is offered.
    expect(panel.textContent).toContain('First take');
    expect(panel.textContent).toContain('Second take');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard First take' }));
    });

    expect(panel.textContent).not.toContain('First take');
    expect(panel.textContent).toContain('Second take');
    expect(screen.getByRole('button', { name: /1 take waiting for Song/ })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all 1' }));
    });

    expect(screen.getByText('Nothing queued now.')).toBeTruthy();
    // The count that opened the panel is gone with the queue.
    expect(screen.queryByRole('button', { name: /take waiting for Song/ })).toBeNull();
  });

  it('keeps focus inside the panel as rows are discarded and cleared', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await act(async () => {});

    await act(async () => {
      sendHandoff('song', { name: 'First take', blob: new Blob(['a']), duration: 1 });
      sendHandoff('song', { name: 'Second take', blob: new Blob(['b']), duration: 2 });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /2 takes waiting for Song/ }));
    });

    const heading = screen.getByRole('heading', { level: 2, name: 'Waiting for Song' });
    expect(document.activeElement).toBe(heading);

    // The row the click lands on is gone with the click, so a pointer has
    // already put focus on that button's way out.
    const first = screen.getByRole('button', { name: 'Discard First take' });
    first.focus();
    await act(async () => {
      fireEvent.click(first);
    });

    // Focus follows the list rather than dropping to the page behind the dialog:
    // it is on the take that took the discarded row's place.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard Second take' }));
    expect(document.activeElement).not.toBe(document.body);

    const clear = screen.getByRole('button', { name: 'Clear all 1' });
    clear.focus();
    await act(async () => {
      fireEvent.click(clear);
    });

    // Nothing left to land on: the heading is where the panel opened, and the
    // line under it says the queue is empty.
    expect(screen.getByText('Nothing queued now.')).toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });

  it('leaves the on-screen section’s count to its notice and keeps the others', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await act(async () => {});

    await act(async () => {
      sendHandoff('song', { name: 'First take', blob: new Blob(['a']), duration: 1 });
      sendHandoff('song', { name: 'Second take', blob: new Blob(['b']), duration: 2 });
      sendHandoff('process', { name: 'Shape take', blob: new Blob(['c']), duration: 3 });
    });

    // Both counts are on the rail while those sections are elsewhere.
    expect(screen.getByRole('button', { name: /2 takes waiting for Song/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 take waiting for Shape/ })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Song/ }));
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Rap over your beat' })).toBeTruthy();
    // Song took one, so one is left — said by the notice, not the rail.
    expect(screen.queryByRole('button', { name: /waiting for Song/ })).toBeNull();
    expect(await screen.findByText(/1 more waiting/)).toBeTruthy();
    // A section that is not on screen keeps its count.
    expect(screen.getByRole('button', { name: /1 take waiting for Shape/ })).toBeTruthy();

    // A take sent while Song is open lands there; the queue behind stays at one.
    await act(async () => {
      sendHandoff('song', { name: 'Third take', blob: new Blob(['d']), duration: 4 });
    });
    expect(screen.getByText(/1 more waiting/)).toBeTruthy();

    // Taking the last queued take empties the notice's count as well.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
    });

    expect(await screen.findByText(/Arrived from another section: Second take/)).toBeTruthy();
    expect(screen.queryByText(/more waiting/)).toBeNull();
    expect(screen.queryByRole('button', { name: /waiting for Song/ })).toBeNull();
  });

  it('says a take could not be opened, and opens it on another try', async () => {
    const store = new StubbornStore();
    setHandoffStore(store);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await act(async () => {});

    await act(async () => {
      sendHandoff('song', { name: 'A take', blob: new Blob(['a']), duration: 1 });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Song/ }));
    });

    // Not an empty section: the take is still queued, and the section says why
    // it did not open rather than looking as if nothing was sent.
    expect(await screen.findByText(/wouldn’t clear, so it is still waiting/)).toBeTruthy();
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();

    store.stubborn = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(await screen.findByText(/Arrived from another section: A take/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it('keeps a take the panel could not delete, and says so', async () => {
    const store = new StubbornStore();
    setHandoffStore(store);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await act(async () => {});

    await act(async () => {
      sendHandoff('song', { name: 'A take', blob: new Blob(['a']), duration: 1 });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /1 take waiting for Song/ }));
    });

    const panel = screen.getByRole('dialog', { name: 'Waiting for Song' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard A take' }));
    });

    // Still listed, because its row is still there; the panel explains why
    // instead of dropping it and letting it arrive again on the next run.
    expect(panel.textContent).toContain('A take');
    expect(panel.textContent).toContain('its saved copy is still there');
    expect(store.rows.size).toBe(1);
  });

  it('takes the notice\'s way back to the section the take came from', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await act(async () => {
      sendTake('song', { name: 'A take', blob: new Blob(['a']), duration: 1, from: 'convert' });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Rap over your beat' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Back to Convert' }));
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Change a recording' })).toBeTruthy();
    expect(window.location.hash).toBe('#/convert');
    // The sender unmounted when the take left it, so the way back has to bring
    // the take with it rather than land on an empty section.
    expect(await screen.findByText(/^Loaded: A take$/)).toBeTruthy();
  });

  it('keeps the arrival notice when the next take cannot be opened', async () => {
    const store = new StubbornStore();
    store.stubborn = false;
    setHandoffStore(store);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await act(async () => {});

    // Queued while Song is closed, so they wait for its visit.
    await act(async () => {
      sendHandoff('song', { name: 'First take', blob: new Blob(['a']), duration: 1 });
      sendHandoff('song', { name: 'Second take', blob: new Blob(['b']), duration: 2 });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Song/ }));
    });
    expect(await screen.findByText(/Arrived from another section: First take/)).toBeTruthy();

    // A take sent to the open Song lands on top, so its notice offers the take
    // it replaced back. Second take is still queued behind it.
    await act(async () => {
      sendHandoff('song', { name: 'Third take', blob: new Blob(['c']), duration: 3 });
    });
    expect(screen.getByText(/Arrived from another section: Third take/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep the previous take' })).toBeTruthy();

    // The next take's row will not go. The failure is reported beside the
    // notice, so the way back to what is on screen is not taken away with it.
    store.stubborn = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next take' }));
    });

    expect(screen.getByText(/Arrived from another section: Third take/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep the previous take' })).toBeTruthy();
    expect(screen.getByText(/wouldn’t clear, so it is still waiting/)).toBeTruthy();

    // Retrying opens the take behind, and the one it replaced is still there.
    store.stubborn = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(screen.getByText(/Arrived from another section: Second take/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep the previous take' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(store.rows.size).toBe(0);
  });
});
