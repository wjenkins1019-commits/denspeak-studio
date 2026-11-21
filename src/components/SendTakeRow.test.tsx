// @vitest-environment jsdom
// The strip offers every section, including the one on screen: handoff.ts hands
// the take to an open section rather than queueing it for a remount that the
// unchanged hash would never trigger.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SendTakeRow } from './SendTakeRow';
import { clearHandoff, subscribeHandoff, takeHandoff } from '../lib/handoff';

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

  it('hands the take to the section already open instead of queueing it', () => {
    window.location.hash = '#/process';
    const seen: string[] = [];
    const stop = subscribeHandoff('process', (item) => seen.push(item.name));

    render(<SendTakeRow {...take} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shape' }));
    stop();

    expect(seen).toEqual(['A take']);
    expect(takeHandoff('process')).toBeNull();
  });

  it('queues for a section that is not open and opens it', () => {
    window.location.hash = '#/convert';

    render(<SendTakeRow {...take} />);
    fireEvent.click(screen.getByRole('button', { name: 'Beat' }));

    expect(window.location.hash).toBe('#/song');
    expect(takeHandoff('song')?.name).toBe('A take');
  });
});
