// @vitest-environment jsdom
// The strip must not offer the section it is rendered in: sending there sets an
// unchanged hash, so no remount consumes the item and it lands on that section's
// source on the next visit instead.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SendTakeRow } from './SendTakeRow';
import { clearHandoff } from '../lib/handoff';

afterEach(() => {
  cleanup();
  clearHandoff();
  window.location.hash = '';
});

function renderRow(hash: string) {
  window.location.hash = hash;
  render(<SendTakeRow name="A take" blob={new Blob(['audio'])} />);
  return screen.getAllByRole('button').map((button) => button.textContent);
}

describe('SendTakeRow', () => {
  it('leaves out the section it is rendered in', () => {
    expect(renderRow('#/process')).toEqual(['Convert', 'Transcribe', 'Beat']);
  });

  it('offers every section from a view that is not a target', () => {
    expect(renderRow('#/library')).toEqual(['Convert', 'Transcribe', 'Shape', 'Beat']);
  });

  it('offers every section when there is no route yet', () => {
    expect(renderRow('')).toEqual(['Convert', 'Transcribe', 'Shape', 'Beat']);
  });
});
