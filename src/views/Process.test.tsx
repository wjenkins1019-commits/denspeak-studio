// @vitest-environment jsdom
// Receiver wiring for the hand-off: a take sent while Shape is open must land
// without a remount, and the sample it replaced must stay one click away.
// Rendered under StrictMode, as the app is: delivery rests on a subscription
// effect, so a take must still land exactly once when React mounts, cleans up
// and mounts again. The TTS engine is mocked; an arrival never renders speech.
//
// The preset tests below cover the other way Shape can lose work: hand-edited
// bands are dropped when a different preset is chosen, and deleting a saved
// preset removes it outright. Both are one click from coming back.
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
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/process');
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  clearHandoff();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  window.history.replaceState(null, '', window.location.pathname);
});

/** The preset picker's current value, and the rows it offers. */
function presetPicker(): HTMLSelectElement {
  return screen.getByLabelText('EQ preset') as HTMLSelectElement;
}

function bandRows(): number {
  return screen.getAllByTitle('Frequency (Hz)').length;
}

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

  it('announces the arrival as a status and puts focus on the section heading', () => {
    sendHandoff('process', { name: 'First sample', blob: new Blob(['a']), duration: 2 });

    render(<Process />);

    // Announced by the live region, not just drawn: the record dot is the only
    // other status in the view.
    expect(
      screen.getByText(/Arrived from another section: First sample/).closest('[role="status"]'),
    ).not.toBeNull();
    // The view swapped in under the user, so focus goes with it.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('leaves focus alone when a take arrives while the user is working', () => {
    render(<Process />);
    const field = screen.getByPlaceholderText('Name this preset');
    field.focus();

    act(() => sendHandoff('process', { name: 'Late sample', blob: new Blob(['b']), duration: 3 }));

    expect(
      screen.getByText(/Arrived from another section: Late sample/).closest('[role="status"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });

  // Not under StrictMode: a double mount would drain two takes and skip the
  // queue this is about.
  it('reports the take queued behind the first and takes it in place', () => {
    sendHandoff('process', { name: 'First sample', blob: new Blob(['a']), duration: 2 });
    sendHandoff('process', { name: 'Second sample', blob: new Blob(['b']), duration: 4 });

    render(<Process />);

    expect(screen.getAllByText('First sample loaded. Shape it, then apply.')).toHaveLength(1);
    expect(screen.getByText(/1 more waiting/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next take' }));

    expect(screen.getAllByText('Second sample loaded. Shape it, then apply.')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Next take' })).toBeNull();
  });

  it('keeps the queue reachable after the arrival notice is dismissed', () => {
    sendHandoff('process', { name: 'First sample', blob: new Blob(['a']), duration: 2 });
    sendHandoff('process', { name: 'Second sample', blob: new Blob(['b']), duration: 4 });
    sendHandoff('process', { name: 'Third sample', blob: new Blob(['c']), duration: 6 });

    render(<Process />);

    expect(screen.getByText(/2 more waiting/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));

    // Dismissed, but the queue is not gone: the count and the step stay.
    expect(screen.queryByText(/Arrived from another section/)).toBeNull();
    expect(screen.getByText(/2 more waiting/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next take' }));

    expect(screen.getAllByText('Second sample loaded. Shape it, then apply.')).toHaveLength(1);
    expect(screen.getByText(/1 more waiting/)).toBeTruthy();
  });
});

describe('Shape preset undo', () => {
  it('gives back the hand-edited bands that choosing another preset dropped', () => {
    render(
      <StrictMode>
        <Process />
      </StrictMode>,
    );

    expect(presetPicker().value).toBe('voice-clarity');
    const untouched = bandRows();

    fireEvent.click(screen.getByRole('button', { name: 'Add band' }));
    expect(bandRows()).toBe(untouched + 1);

    fireEvent.change(presetPicker(), { target: { value: 'podcast' } });

    expect(presetPicker().value).toBe('podcast');
    // The edit is gone from the graph, but not from the session.
    expect(screen.getByText(/Dropped your edits to “Clarity”/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(presetPicker().value).toBe('voice-clarity');
    expect(bandRows()).toBe(untouched + 1);
    expect(screen.queryByText(/Dropped your edits/)).toBeNull();
  });

  it('puts a deleted preset back where it was', () => {
    render(
      <StrictMode>
        <Process />
      </StrictMode>,
    );

    fireEvent.change(screen.getByPlaceholderText('Name this preset'), {
      target: { value: 'Mine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));

    const saved = presetPicker().value;
    expect(saved.startsWith('custom:')).toBe(true);
    expect([...presetPicker().options].some((option) => option.text === 'Mine')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));

    expect([...presetPicker().options].some((option) => option.text === 'Mine')).toBe(false);
    expect(screen.getByText(/Deleted “Mine”/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect([...presetPicker().options].some((option) => option.text === 'Mine')).toBe(true);
    expect(presetPicker().value).toBe(saved);
  });
});
