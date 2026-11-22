// @vitest-environment jsdom
// The hand-off router path, end to end: sendTake replaces the history entry, and
// the fragment-only replaceState must reach App's hashchange listener so the
// target section mounts and takes the item. The strip's own test only shows the
// hash and history depth; this one shows the section on screen changing.
// Rendered under StrictMode, as the app is.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearHandoff, sendHandoff, sendTake, setClearTimeout, setHandoffStore } from './lib/handoff';
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

/** Storage whose deletes never answer, standing in for a store that hangs. */
class HungStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();
  /** Every key a delete was asked for, so a test can see how many were tried. */
  readonly removes: string[] = [];

  async list(): Promise<HandoffRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.at - b.at);
  }

  async put(record: HandoffRecord): Promise<void> {
    this.rows.set(record.key, record);
  }

  remove(key: string): Promise<void> {
    this.removes.push(key);
    return new Promise(() => {});
  }
}

/** Storage that hangs the first delete it is asked for, then answers. */
class OnceHungStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();
  hung = false;

  async list(): Promise<HandoffRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.at - b.at);
  }

  async put(record: HandoffRecord): Promise<void> {
    this.rows.set(record.key, record);
  }

  remove(key: string): Promise<void> {
    if (!this.hung) {
      this.hung = true;
      return new Promise(() => {});
    }

    this.rows.delete(key);
    return Promise.resolve();
  }
}

/**
 * Storage that never answers the first delete it is asked for and refuses the
 * rest, so a refusal lands while an earlier delete is still waiting.
 */
class HangThenRefuseStore implements HandoffStore {
  readonly rows = new Map<string, HandoffRecord>();
  hung = false;

  async list(): Promise<HandoffRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.at - b.at);
  }

  async put(record: HandoffRecord): Promise<void> {
    this.rows.set(record.key, record);
  }

  remove(key: string): Promise<void> {
    if (this.hung) throw new Error('the row would not delete');
    this.hung = true;
    return new Promise(() => {});
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
  setClearTimeout();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  window.history.replaceState(null, '', window.location.pathname);
});

/**
 * The setup every panel test shares: the app, takes queued for Song while the
 * route is elsewhere, and the panel opened from the rail count. Each test then
 * says only what it does to the panel and what that should do.
 */
async function openSongQueue(names: string[], store?: HandoffStore): Promise<HTMLElement> {
  if (store) setHandoffStore(store);
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await act(async () => {});

  await act(async () => {
    names.forEach((name, index) => {
      sendHandoff('song', { name, blob: new Blob([name]), duration: index + 1 });
    });
  });

  const count = names.length === 1 ? '1 take' : `${names.length} takes`;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${count} waiting for Song`) }));
  });

  return screen.getByRole('dialog', { name: 'Waiting for Song' });
}

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
    const panel = await openSongQueue(['First take', 'Second take']);

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
    const panel = await openSongQueue(['First take', 'Second take']);

    const heading = screen.getByRole('heading', { level: 2, name: 'Waiting for Song' });
    // The panel takes focus in an effect, which can land after the dialog is
    // already in the DOM: wait for the focus rather than reading it in the
    // same tick as the panel.
    await waitFor(() => expect(document.activeElement).toBe(heading));

    // The empty result has its own standing live region, silent while takes are
    // still listed.
    const emptyNews = within(panel).getByRole('status');
    expect(emptyNews.textContent).toBe('');

    // The row the click lands on is gone with the click, so a pointer has
    // already put focus on that button's way out.
    const first = screen.getByRole('button', { name: 'Discard First take' });
    first.focus();
    await act(async () => {
      fireEvent.click(first);
    });

    // Focus follows the list rather than dropping to the page behind the dialog:
    // it is on the take that took the discarded row's place. The move is made
    // in an effect after the row leaves, so it is waited for rather than read
    // in the same tick as the click.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard Second take' }));
      expect(document.activeElement).not.toBe(document.body);
    });
    // The row that took the focus already says what is left; the count is not
    // also read out over it.
    expect(emptyNews.textContent).toBe('');

    const clear = screen.getByRole('button', { name: 'Clear all 1' });
    clear.focus();
    await act(async () => {
      fireEvent.click(clear);
    });

    // Nothing left to land on: the heading is where the panel opened, and the
    // empty result fills the live region, so it is spoken as well as shown.
    // The move is made in an effect after the last row leaves, so it is waited
    // for rather than read in the same tick as the text.
    expect(screen.getByText('Nothing queued now.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(emptyNews.textContent).toBe('Nothing queued now.');
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

  it('keeps a take the panel could not delete, and leaves focus where the reader has it', async () => {
    const store = new StubbornStore();
    const panel = await openSongQueue(['A take', 'Another take'], store);

    const discard = screen.getByRole('button', { name: 'Discard A take' });
    discard.focus();
    await act(async () => {
      fireEvent.click(discard);
    });

    // Still listed, because its row is still there; the panel explains why
    // instead of dropping it and letting it arrive again on the next run.
    expect(panel.textContent).toContain('A take');
    expect(panel.textContent).toContain('its saved copy is still there');
    expect(store.rows.size).toBe(2);
    // Nothing left the list, so nothing was taken from focus either: it is still
    // on the button that was pressed.
    expect(document.activeElement).toBe(discard);

    // The refused request is spent, not banked: a take arriving afterwards is no
    // reason to pull focus back to a row the reader has since moved off.
    const heading = screen.getByRole('heading', { level: 2, name: 'Waiting for Song' });
    heading.focus();
    await act(async () => {
      sendHandoff('song', { name: 'Late take', blob: new Blob(['c']), duration: 3 });
    });

    expect(panel.textContent).toContain('Late take');
    expect(document.activeElement).toBe(heading);
  });

  it('keeps every row when the store refuses a clear, and leaves focus where the reader has it', async () => {
    const store = new StubbornStore();
    const panel = await openSongQueue(['A take', 'Another take'], store);

    const clear = screen.getByRole('button', { name: 'Clear all 2' });
    clear.focus();
    await act(async () => {
      fireEvent.click(clear);
    });

    // Every row is still listed, because the store would not let any of them go,
    // and the panel says so rather than looking as if it were already empty.
    expect(panel.textContent).toContain('A take');
    expect(panel.textContent).toContain('Another take');
    expect(panel.textContent).toContain('Couldn’t remove 2 takes');
    expect(store.rows.size).toBe(2);
    // Nothing was thrown away, so nothing was taken from focus either: it stays
    // on the button that was pressed, which is still there to press again.
    expect(document.activeElement).toBe(clear);

    // The refused request is spent, not banked: the queue filling up again is no
    // reason to pull focus back to a control the reader has since left.
    const heading = screen.getByRole('heading', { level: 2, name: 'Waiting for Song' });
    heading.focus();
    await act(async () => {
      sendHandoff('song', { name: 'Late take', blob: new Blob(['c']), duration: 3 });
    });

    expect(panel.textContent).toContain('Late take');
    expect(document.activeElement).toBe(heading);
  });

  it('says a take is still queued when the store hangs on a discard', async () => {
    const store = new HungStore();
    const panel = await openSongQueue(['A take', 'Another take'], store);
    // The real wait is seconds long; what matters here is that it ends.
    setClearTimeout(20);

    const discard = screen.getByRole('button', { name: 'Discard A take' });
    discard.focus();
    await act(async () => {
      fireEvent.click(discard);
    });

    // The row would not clear, so it is still listed and the panel says why
    // instead of sitting on a Discard button that appeared to do nothing.
    expect(await screen.findByText(/its saved copy is still there/)).toBeTruthy();
    expect(panel.textContent).toContain('A take');
    expect(panel.textContent).toContain('Another take');
    expect(store.rows.size).toBe(2);
    expect(document.activeElement).toBe(discard);
  });

  it('spends one deadline on a clear however many takes are queued', async () => {
    const store = new HungStore();
    const panel = await openSongQueue(
      ['A take', 'Another take', 'Third take', 'Fourth take'],
      store,
    );
    setClearTimeout(20);

    store.removes.length = 0;
    const clear = screen.getByRole('button', { name: 'Clear all 4' });
    clear.focus();
    await act(async () => {
      fireEvent.click(clear);
    });

    // The first hung delete spends the clear's whole budget, so the rest are
    // kept without a delete being asked for. Waiting per row, as the loop did
    // before, asked for one per take and held the panel for a deadline each.
    // What matters is that the clear asked for fewer deletes than it had rows;
    // the exact count and the elapsed time both turn on when the timer fires.
    expect(await screen.findByText(/Couldn’t remove 4 takes/)).toBeTruthy();
    expect(store.removes.length).toBeGreaterThanOrEqual(1);
    expect(store.removes.length).toBeLessThan(4);
    expect(panel.textContent).toContain('Fourth take');
    expect(store.rows.size).toBe(4);
    expect(document.activeElement).toBe(clear);
  });

  it('says a delete and a clear are under way while the store hangs', async () => {
    const store = new HungStore();
    const panel = await openSongQueue(['A take', 'Another take'], store);
    setClearTimeout(20);

    // Synchronous, so the deadline cannot pass between the press and the check.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard A take' }));
    });

    // The press would otherwise sit on an unchanged button for as long as the
    // store takes, looking as though it had not been heard.
    expect(screen.getByRole('button', { name: 'Discarding A take' })).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all 2' }));
    });

    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeTruthy();

    // Both end in the clear's note, and both go back to their ordinary label: a
    // busy state that outlived its wait would leave the panel stuck on it.
    expect(await screen.findByText(/Couldn’t remove 2 takes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discarding A take' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard A take' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear all 2' })).toBeTruthy();
    expect(panel.textContent).toContain('Another take');
  });

  it('says in the panel which take is being discarded, and that a clear is under way', async () => {
    const store = new HungStore();
    const panel = await openSongQueue(['A take', 'Another take'], store);
    setClearTimeout(20);

    // Standing from the first render, so filling it later is what gets read.
    const news = within(panel).getByRole('status');
    expect(news.textContent).toBe('');

    // Synchronous, so the deadline cannot pass between the press and the check.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard A take' }));
    });

    // The row's own name changes to say it is working, but that is a name under
    // the focus the press just put there; the panel says it out loud instead.
    expect(news.textContent).toBe('Discarding “A take”.');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all 2' }));
    });

    // One region for the whole panel: what is still being discarded is said
    // beside the clear, not in a second region or on the button alone.
    expect(news.textContent).toBe('Discarding “A take”. Clearing 2 takes.');

    // Both settle into the clear's refusal, said in the one line: no busy text
    // left to read as work that never finished, and no second region to speak
    // the refusal over it.
    expect(await screen.findByText(/Couldn’t remove 2 takes/)).toBeTruthy();
    expect(within(panel).getAllByRole('status')).toHaveLength(1);
    expect(news.textContent).toContain('Couldn’t remove 2 takes');
    expect(news.textContent).not.toContain('Clearing');
    expect(panel.textContent).toContain('A take');
  });

  it('says a refusal in the panel’s one line, not over the delete still waiting', async () => {
    const store = new HangThenRefuseStore();
    const panel = await openSongQueue(['A take', 'Another take'], store);
    setClearTimeout(100);

    const news = within(panel).getByRole('status');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard A take' }));
    });
    expect(news.textContent).toBe('Discarding “A take”.');

    // The second row's delete is refused at once while the first is still
    // waiting, so a refusal and work under way are true together. As two regions
    // they spoke over each other; as one line the refusal is what is said.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard Another take' }));
    });

    expect(within(panel).getAllByRole('status')).toHaveLength(1);
    expect(news.textContent).toBe(
      'Couldn’t remove “Another take” — its saved copy is still there, so it is still waiting.',
    );
    expect(news.textContent).not.toContain('Discarding');
    // The row left unsaid is not lost: it still says it is working on its own
    // button, so the reader is not blind to it for the sake of one line.
    expect(screen.getByRole('button', { name: 'Discarding A take' })).toBeTruthy();

    // The hung delete reaches its deadline rather than outliving the test, and
    // it is its refusal that then stands.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(news.textContent).toContain('Couldn’t remove “A take”');
  });

  it('says a take could not be opened when the store hangs instead of refusing', async () => {
    const store = new HungStore();
    setHandoffStore(store);
    // The real wait is seconds long; what matters here is that it ends.
    setClearTimeout(20);
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

    // A delete that never answers used to leave the section silent, the take
    // caught between queued and shown. It is still queued, so it says so.
    expect(await screen.findByText(/wouldn’t clear, so it is still waiting/)).toBeTruthy();
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
    expect(store.rows.size).toBe(1);
  });

  it('opens the take on a retry once a hanging store answers', async () => {
    const store = new OnceHungStore();
    setHandoffStore(store);
    setClearTimeout(20);
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

    // The first delete hangs, so the take stays queued and the section says so;
    // it has to still be claimable once the store starts answering.
    expect(await screen.findByText(/wouldn’t clear, so it is still waiting/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(await screen.findByText(/Arrived from another section: A take/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(store.rows.size).toBe(0);
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
