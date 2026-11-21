// @vitest-environment jsdom
// The shaped take has no Player, so its stored captions must surface here:
// instant SRT/VTT downloads whenever the take carries cues, nothing otherwise.
// Filenames go through the shared export path, asserted on saveExport.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbCompare } from './AbCompare';

const saveExportMock = vi.fn();

vi.mock('../lib/export', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/export')>();
  return {
    ...original,
    saveExport: (...args: unknown[]) => {
      saveExportMock(...args);
      return Promise.resolve(true);
    },
  };
});

const CAPTIONS = {
  srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
  vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
};

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  saveExportMock.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

function blob(): Blob {
  return new Blob(['audio'], { type: 'audio/wav' });
}

describe('AbCompare caption downloads', () => {
  it('saves stored SRT/VTT under the take name', () => {
    render(<AbCompare raw={blob()} shaped={blob()} captions={CAPTIONS} captionsName="my-take" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download SRT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download VTT' }));
    const names = saveExportMock.mock.calls.map((call) => call[1]);
    expect(names).toEqual(['my-take.srt', 'my-take.vtt']);
  });

  it('shows no caption buttons without stored cues', () => {
    render(<AbCompare raw={blob()} shaped={blob()} />);
    expect(screen.queryByRole('button', { name: 'Download SRT' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download VTT' })).toBeNull();
  });
});
