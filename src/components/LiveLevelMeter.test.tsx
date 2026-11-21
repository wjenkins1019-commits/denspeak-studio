// @vitest-environment jsdom
// The record-time meter must warn on hot peaks and high room noise without a
// microphone: testLevels drives the UI, so no Web Audio is involved.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveLevelMeter } from './LiveLevelMeter';

afterEach(() => {
  cleanup();
});

describe('LiveLevelMeter', () => {
  it('renders nothing without a stream', () => {
    const { container } = render(<LiveLevelMeter stream={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('warns on hot input', () => {
    render(<LiveLevelMeter stream={null} testLevels={{ peakDb: -1, noiseDb: -80 }} />);
    expect(screen.getByText(/back off the mic/)).toBeTruthy();
  });

  it('warns on a noisy room', () => {
    render(<LiveLevelMeter stream={null} testLevels={{ peakDb: -12, noiseDb: -50 }} />);
    expect(screen.getByText(/quieter spot/)).toBeTruthy();
  });

  it('stays quiet on a healthy level', () => {
    render(<LiveLevelMeter stream={null} testLevels={{ peakDb: -12, noiseDb: -70 }} />);
    expect(screen.queryByText(/back off the mic/)).toBeNull();
    expect(screen.queryByText(/quieter spot/)).toBeNull();
    expect(screen.getByText(/Peak/)).toBeTruthy();
  });
});
