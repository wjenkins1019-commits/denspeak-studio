// @vitest-environment jsdom
// Every section's strip is this one component with a different `from`, so the
// table runs it once per section: the section you are in must never be offered
// as a destination, and the take must leave stamped with that section, so the
// notice's "Back to …" can only name where the take really came from.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendTakeRow } from './SendTakeRow';
import {
  HANDOFF_TARGETS,
  clearHandoff,
  sectionLabel,
  subscribeHandoff,
  takeHandoff,
  type HandoffItem,
  type HandoffSource,
} from '../lib/handoff';

const take = { name: 'A take', blob: new Blob(['audio']) };

const SECTIONS: HandoffSource[] = ['studio', 'convert', 'transcribe', 'process', 'song', 'library'];

afterEach(() => {
  cleanup();
  clearHandoff();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('SendTakeRow', () => {
  it.each(SECTIONS)('leaves its own section (%s) out of the destinations', (from) => {
    window.history.replaceState(null, '', `#/${from}`);

    render(<SendTakeRow {...take} from={from} />);

    const offered = screen.getAllByRole('button').map((button) => button.textContent);
    expect(offered).toEqual(
      HANDOFF_TARGETS.filter((entry) => entry.target !== from).map((entry) => entry.label),
    );
    // Library receives nothing, so there its own name is simply absent too.
    expect(offered).not.toContain(sectionLabel(from));
  });

  it.each(SECTIONS)('stamps the take with %s as its source', async (from) => {
    const target = HANDOFF_TARGETS.find((entry) => entry.target !== from);
    if (!target) throw new Error('every section has somewhere to send a take');

    window.history.replaceState(null, '', `#/${from}`);
    const seen: HandoffItem[] = [];
    const stop = subscribeHandoff(target.target, (item) => seen.push(item));

    render(
      <SendTakeRow {...take} duration={12.5} captions={{ srt: 'srt', vtt: 'vtt' }} from={from} />,
    );
    fireEvent.click(screen.getByRole('button', { name: target.label }));
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: 'A take',
      duration: 12.5,
      captions: { srt: 'srt', vtt: 'vtt' },
      from,
    });
    expect(await takeHandoff(target.target)).toBeNull();
  });

  it('offers every destination to a take from Library, which receives none', () => {
    render(<SendTakeRow {...take} from="library" />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Studio',
      'Convert',
      'Transcribe',
      'Shape',
      'Beat',
    ]);
  });

  it('queues for a section that is not open, and opens it without a history entry', async () => {
    window.history.replaceState(null, '', '#/convert');
    const depth = window.history.length;
    const heard = vi.fn();
    window.addEventListener('hashchange', heard);

    render(<SendTakeRow {...take} from="library" />);
    fireEvent.click(screen.getByRole('button', { name: 'Beat' }));
    window.removeEventListener('hashchange', heard);

    expect(window.location.hash).toBe('#/song');
    // Replacing, not pushing: Back must not reopen the spent section as if undo.
    expect(window.history.length).toBe(depth);
    // replaceState fires no hashchange of its own, so this is the router's only
    // notice of the new section.
    expect(heard).toHaveBeenCalledTimes(1);
    expect((await takeHandoff('song'))?.name).toBe('A take');
  });
});
