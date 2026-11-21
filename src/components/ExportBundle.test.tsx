// @vitest-environment jsdom
// The bundle button ships the take's audio plus its stored captions and a
// loudness report in one ZIP, in the chosen format.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportBundle } from './ExportBundle';

const { exportTakeBundleMock, getTakeMock } = vi.hoisted(() => ({
  exportTakeBundleMock: vi.fn(() => Promise.resolve('take bundle.zip')),
  getTakeMock: vi.fn(),
}));

vi.mock('../lib/export', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/export')>();
  return { ...original, exportTakeBundle: exportTakeBundleMock };
});

vi.mock('../lib/library', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/library')>();
  return { ...original, getTake: getTakeMock };
});

const CAPTIONS = {
  srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
  vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
};

function blob(): Blob {
  return new Blob(['audio'], { type: 'audio/wav' });
}

afterEach(() => {
  cleanup();
  exportTakeBundleMock.mockClear();
  getTakeMock.mockReset();
});

describe('ExportBundle', () => {
  it('bundles WAV with the live captions by default', async () => {
    render(<ExportBundle name="take" blob={blob()} takeId="take-1" captions={CAPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export bundle' }));
    await vi.waitFor(() => expect(exportTakeBundleMock).toHaveBeenCalledTimes(1));
    expect(exportTakeBundleMock).toHaveBeenCalledWith(
      { name: 'take', blob: expect.any(Blob), captions: CAPTIONS },
      { format: 'wav', standardId: 'audiobook' },
    );
    expect(getTakeMock).not.toHaveBeenCalled();
  });

  it('bundles MP3 when selected', async () => {
    render(<ExportBundle name="take" blob={blob()} captions={CAPTIONS} />);
    fireEvent.change(screen.getByLabelText('Bundle audio format'), { target: { value: 'mp3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export bundle' }));
    await vi.waitFor(() => expect(exportTakeBundleMock).toHaveBeenCalledTimes(1));
    const [, bundleOptions] = exportTakeBundleMock.mock.calls[0] as unknown as [unknown, { format: string }];
    expect(bundleOptions).toMatchObject({ format: 'mp3' });
  });

  it('re-reads the take when no live captions are passed', async () => {
    getTakeMock.mockResolvedValue({ captions: CAPTIONS });
    render(<ExportBundle name="take" blob={blob()} takeId="take-9" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export bundle' }));
    await vi.waitFor(() => expect(getTakeMock).toHaveBeenCalledWith('take-9'));
    expect(exportTakeBundleMock).toHaveBeenCalledWith(
      { name: 'take', blob: expect.any(Blob), captions: CAPTIONS },
      { format: 'wav', standardId: 'audiobook' },
    );
  });

  it('shows the failure instead of hanging on Bundling…', async () => {
    exportTakeBundleMock.mockRejectedValueOnce(new Error('MP3 encoding failed.'));
    render(<ExportBundle name="take" blob={blob()} captions={CAPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export bundle' }));
    expect(await screen.findByText('MP3 encoding failed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export bundle' })).toBeTruthy();
  });
});
