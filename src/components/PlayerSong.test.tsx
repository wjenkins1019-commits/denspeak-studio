// @vitest-environment jsdom
// The Player forwards the song flag to its inline LevelCheck, so Library and
// Song-view mixes (the only song sources) never get a Match button. A stub
// LevelCheck records the prop; real grading lives in LevelCheck's own suite.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Player } from './Player';

const seenIsSong: Array<boolean | undefined> = [];

vi.mock('./LevelCheck', () => ({
  LevelCheck: (props: { isSong?: boolean }) => {
    seenIsSong.push(props.isSong);
    return null;
  },
}));

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  seenIsSong.length = 0;
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('Player song forwarding', () => {
  it('passes isSong through to the level check', () => {
    render(<Player blob={new Blob(['mix'], { type: 'audio/wav' })} name="mix" isSong />);
    expect(seenIsSong).toEqual([true]);
  });

  it('leaves the flag unset for voice takes', () => {
    render(<Player blob={new Blob(['take'], { type: 'audio/wav' })} name="take" />);
    expect(seenIsSong).toEqual([undefined]);
  });
});
