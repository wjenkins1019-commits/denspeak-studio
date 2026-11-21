// @vitest-environment jsdom
// The strip offers every section, including the one on screen: handoff.ts hands
// the take to an open section rather than queueing it for a remount that the
// unchanged hash would never trigger.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SendTakeRow } from './SendTakeRow';
import { clearHandoff, subscribeHandoff, takeHandoff, type HandoffItem } from '../lib/handoff';

const take = { name: 'A take', blob: new Blob(['audio']) };

afterEach(() => {
  cleanup();
  clearHandoff();
  window.location.hash = '';
});

describe('SendTakeRow', () => {
  it('offers every section, including the one already on screen', () => {
    window.location.hash = '#/process';

    render(<SendTakeRow {...take} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Convert',
      'Transcribe',
      'Shape',
      'Beat',
    ]);
  });

  it('hands the take, its length and its captions to the section already open', () => {
    window.location.hash = '#/process';
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
    });
    expect(takeHandoff('process')).toBeNull();
  });

  it('queues for a section that is not open, and opens it without a history entry', () => {
    window.location.hash = '#/convert';
    const depth = window.history.length;

    render(<SendTakeRow {...take} />);
    fireEvent.click(screen.getByRole('button', { name: 'Beat' }));

    expect(window.location.hash).toBe('#/song');
    // Replacing, not pushing: Back must not reopen the spent section as if undo.
    expect(window.history.length).toBe(depth);
    expect(takeHandoff('song')?.name).toBe('A take');
  });
});
