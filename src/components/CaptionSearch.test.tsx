// @vitest-environment jsdom
// Caption search must find the cue holding the words and jump to its time:
// typing narrows to the matching cue, and Hear it passes the take and stamp.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptionSearch } from './CaptionSearch';
import { formatSRT } from '../lib/captions';
import type { Take } from '../lib/library';

afterEach(() => {
  cleanup();
});

function take(name: string, texts: string[]): Take {
  const cues = texts.map((text, index) => ({ start: index * 2, end: index * 2 + 1.5, text }));
  return {
    id: name,
    name,
    createdAt: 0,
    duration: 10,
    kind: 'render',
    blob: new Blob(['audio'], { type: 'audio/wav' }),
    captions: { srt: formatSRT(cues), vtt: '' },
  } as Take;
}

describe('CaptionSearch', () => {
  it('finds the cue and jumps to its timestamp', () => {
    const onJump = vi.fn();
    render(
      <CaptionSearch
        takes={[take('chapter-1', ['the quick brown fox', 'sleeps at dawn'])]}
        uncaptioned={0}
        onJump={onJump}
      />,
    );
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'quick fox' } });
    expect(screen.getByText('chapter-1')).toBeTruthy();
    expect(screen.getByTitle('Open chapter-1 at 0:00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Hear it/ }));
    expect(onJump).toHaveBeenCalledWith('chapter-1', 0);
  });

  it('says what is not covered when takes lack captions', () => {
    render(<CaptionSearch takes={[]} uncaptioned={2} onJump={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'fox' } });
    expect(screen.getByText(/backfill above/)).toBeTruthy();
  });
});
