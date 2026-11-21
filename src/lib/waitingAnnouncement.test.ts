import { describe, expect, it } from 'vitest';
import { waitingAnnouncement, waitingFell, type WaitingCounts } from './waitingAnnouncement';
import type { HandoffTarget } from './handoff';

const labels: Record<HandoffTarget, string> = {
  studio: 'Studio',
  convert: 'Convert',
  transcribe: 'Transcribe',
  process: 'Shape',
  song: 'Song',
};

const say = (before: WaitingCounts, after: WaitingCounts, onScreen: string | null) =>
  waitingAnnouncement(before, after, onScreen, (target) => labels[target]);

describe('waitingAnnouncement', () => {
  it('announces a take that landed for another section', () => {
    expect(say({}, { song: 1 }, 'convert')).toBe('1 take waiting for Song');
    expect(say({}, { song: 2 }, 'convert')).toBe('2 takes waiting for Song');
  });

  it('says nothing when a count falls', () => {
    expect(say({ song: 2 }, { song: 1 }, 'convert')).toBe('');
    expect(say({ song: 1 }, {}, 'convert')).toBe('');
  });

  it('stays silent for the section on screen', () => {
    expect(say({}, { process: 1 }, 'process')).toBe('');
  });

  it('joins the increases for several sections into one line', () => {
    expect(say({ song: 1 }, { song: 2, process: 1 }, 'convert')).toBe(
      '1 take waiting for Shape. 2 takes waiting for Song',
    );
  });

  it('says nothing when the counts are unchanged', () => {
    expect(say({ convert: 1 }, { convert: 1 }, 'studio')).toBe('');
  });

  it('reports a fall so the last line can be withdrawn without speaking', () => {
    expect(waitingFell({ song: 2 }, { song: 1 })).toBe(true);
    expect(waitingFell({ song: 1 }, { song: 2 })).toBe(false);
    expect(waitingFell({ song: 1 }, { song: 1 })).toBe(false);
  });
});
