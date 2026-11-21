// @vitest-environment jsdom
// The editor parses stored SRT back to cues, lets text/timings change, then
// saves formatted SRT/VTT back onto the take so downloads re-export it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptionEditor } from './CaptionEditor';

const { updateTakeCaptionsMock } = vi.hoisted(() => ({
  updateTakeCaptionsMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/library', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/library')>();
  return { ...original, updateTakeCaptions: updateTakeCaptionsMock };
});

const CAPTIONS = {
  srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
  vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
};

afterEach(() => {
  cleanup();
  updateTakeCaptionsMock.mockClear();
});

describe('CaptionEditor', () => {
  it('saves edited text back to the take and hands new files to downloads', async () => {
    const onSaved = vi.fn();
    render(<CaptionEditor captions={CAPTIONS} name="take" takeId="take-1" onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit captions' }));
    fireEvent.change(screen.getByLabelText('Cue text 1'), { target: { value: 'Hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save captions' }));

    await vi.waitFor(() => expect(updateTakeCaptionsMock).toHaveBeenCalledTimes(1));
    const [id, next] = updateTakeCaptionsMock.mock.calls[0] as unknown as [
      string,
      { srt: string; vtt: string },
    ];
    expect(id).toBe('take-1');
    expect(next.srt).toContain('Hello world');
    expect(next.vtt).toContain('Hello world');
    expect(onSaved).toHaveBeenCalledWith(next);
  });

  it('keeps the voice label and re-exports it in both formats', async () => {
    const voiced = {
      srt: '1\n00:00:00,000 --> 00:00:01,000\nLeah: Hello\n',
      vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Leah>Hello</v>\n',
    };
    const onSaved = vi.fn();
    render(<CaptionEditor captions={voiced} name="take" takeId="take-1" onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit captions' }));
    expect((screen.getByLabelText('Cue voice 1') as HTMLInputElement).value).toBe('Leah');
    fireEvent.change(screen.getByLabelText('Cue text 1'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save captions' }));

    await vi.waitFor(() => expect(updateTakeCaptionsMock).toHaveBeenCalledTimes(1));
    const [, next] = updateTakeCaptionsMock.mock.calls[0] as unknown as [
      string,
      { srt: string; vtt: string },
    ];
    expect(next.srt).toContain('Leah: Hello there');
    expect(next.vtt).toContain('<v Leah>Hello there</v>');
  });

  it('nudges timings by a tenth of a second', () => {
    render(<CaptionEditor captions={CAPTIONS} name="take" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit captions' }));

    fireEvent.click(screen.getByRole('button', { name: 'Nudge cue 1 end later' }));
    expect((screen.getByLabelText('Cue end 1') as HTMLInputElement).value).toBe('1.1');
  });
});
