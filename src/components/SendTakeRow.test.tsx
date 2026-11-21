// @vitest-environment jsdom
// The strip never offers the section the take came from: sending a take to
// where it already is only reloads it behind a notice that announces an
// arrival from somewhere else.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendTakeRow } from './SendTakeRow';
import { clearHandoff, subscribeHandoff, takeHandoff, type HandoffItem } from '../lib/handoff';

const take = { name: 'A take', blob: new Blob(['audio']), from: 'studio' as const };

afterEach(() => {
  cleanup();
  clearHandoff();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('SendTakeRow', () => {
  it('leaves out the section the take came from', () => {
    window.history.replaceState(null, '', '#/process');

    render(<SendTakeRow {...take} from="process" />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Convert',
      'Transcribe',
      'Beat',
    ]);
  });

  it('still offers every section to a take from Studio, which receives none', () => {
    render(<SendTakeRow {...take} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Convert',
      'Transcribe',
      'Shape',
      'Beat',
    ]);
  });

  it('hands the take, its length, its captions and its source to the section already open', () => {
    window.history.replaceState(null, '', '#/process');
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff('process', (item) => seen.push(item));

    render(<SendTakeRow {...take} duration={12.5} captions={{ srt: 'srt', vtt: 'vtt' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shape' }));
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: 'A take',
      duration: 12.5,
      captions: { srt: 'srt', vtt: 'vtt' },
      from: 'studio',
    });
    expect(takeHandoff('process')).toBeNull();
  });

  it('queues for a section that is not open, and opens it without a history entry', () => {
    window.history.replaceState(null, '', '#/convert');
    const depth = window.history.length;
    const heard = vi.fn();
    window.addEventListener('hashchange', heard);

    render(<SendTakeRow {...take} />);
    fireEvent.click(screen.getByRole('button', { name: 'Beat' }));
    window.removeEventListener('hashchange', heard);

    expect(window.location.hash).toBe('#/song');
    // Replacing, not pushing: Back must not reopen the spent section as if undo.
    expect(window.history.length).toBe(depth);
    // replaceState fires no hashchange of its own, so this is the router's only
    // notice of the new section.
    expect(heard).toHaveBeenCalledTimes(1);
    expect(takeHandoff('song')?.name).toBe('A take');
  });
});
