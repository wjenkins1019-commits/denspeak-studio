// Tests for filename handling, the stored-entries ZIP writer, and the library
// export path. Archives are parsed back field-by-field and CRCs are
// cross-checked with Node's zlib, not with the writer's own math.
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodeWav } from './audio';
import {
  exportFileName,
  exportLibrary,
  exportTakeBundle,
  formatLoudnessReport,
  zipStored,
} from './export';
import { checkLoudness, LOUDNESS_STANDARDS } from './loudness';
import type { Take } from './library';
import { formatSRT, formatVTT, offsetStoredCaptions, parseCues } from './captions';

function wavBytes(seed: number): Uint8Array<ArrayBuffer> {
  const samples = new Float32Array(64);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin(i * 0.3 + seed) * 0.5;
  }
  return new Uint8Array(encodeWav(samples, 22_050));
}

function makeTake(name: string, seed: number): Take {
  return {
    id: `take-${name}-${seed}`,
    name,
    createdAt: Date.now(),
    duration: 1,
    kind: 'render',
    blob: new Blob([wavBytes(seed)], { type: 'audio/wav' }),
  };
}

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
  utf8: boolean;
}

/** Walk the local file headers; our writer emits no data descriptors. */
function parseZip(bytes: Uint8Array): { entries: ParsedEntry[]; declared: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: ParsedEntry[] = [];
  let offset = 0;

  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x0403_4b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.push({
      name,
      method,
      crc,
      data: bytes.slice(dataStart, dataStart + compressedSize),
      utf8: (flags & 0x0800) !== 0,
    });
    offset = dataStart + compressedSize;
  }

  // End-of-central-directory record, no archive comment.
  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== 0x0605_4b50) throw new Error('missing EOCD');
  return { entries, declared: view.getUint16(eocd + 10, true) };
}

describe('exportFileName', () => {
  it('keeps a clean name and normalises its extension', () => {
    expect(exportFileName('My take (raw).wav', 'wav')).toBe('My take (raw).wav');
    expect(exportFileName('take.MP3', 'wav')).toBe('take.wav');
    expect(exportFileName('noext', 'mp3')).toBe('noext.mp3');
  });

  it('replaces characters filesystems disagree about', () => {
    expect(exportFileName('a/b\\c:d*e?f"g<h>i|j', 'wav')).toBe('a-b-c-d-e-f-g-h-i-j.wav');
  });

  it('trims dots and whitespace from the ends', () => {
    expect(exportFileName('  Chapter 1: Go!  ', 'wav')).toBe('Chapter 1- Go!.wav');
  });

  it('falls back to the studio name when nothing is left', () => {
    expect(exportFileName('', 'wav')).toBe('denspeak-studio.wav');
    expect(exportFileName('   ', 'mp3')).toBe('denspeak-studio.mp3');
    expect(exportFileName('...', 'wav')).toBe('denspeak-studio.wav');
  });

  it('caps the base name at 90 characters', () => {
    const name = exportFileName('x'.repeat(200), 'wav');
    expect(name).toBe(`${'x'.repeat(90)}.wav`);
  });
});

describe('zipStored', () => {
  it('round-trips stored entries with valid headers and CRCs', async () => {
    const first = wavBytes(1);
    const second = new TextEncoder().encode('hello');
    const blob = zipStored([
      { name: 'first.wav', bytes: first },
      { name: 'dir/ünïcode.mp3', bytes: second },
    ]);
    expect(blob.type).toBe('application/zip');

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { entries, declared } = parseZip(bytes);
    expect(declared).toBe(2);
    expect(entries.map((entry) => entry.name)).toEqual(['first.wav', 'dir/ünïcode.mp3']);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.utf8).toBe(true);
    }
    expect(entries[0].data).toEqual(first);
    expect(entries[1].data).toEqual(second);
    expect(entries[0].crc >>> 0).toBe(crc32(Buffer.from(first)) >>> 0);
    expect(entries[1].crc >>> 0).toBe(crc32(Buffer.from(second)) >>> 0);
  });

  it('writes a valid empty archive', async () => {
    const bytes = new Uint8Array(await zipStored([]).arrayBuffer());
    const { entries, declared } = parseZip(bytes);
    expect(entries).toEqual([]);
    expect(declared).toBe(0);
  });
});

describe('exportLibrary', () => {
  it('zips takes under their own names with a dated default', async () => {
    // A holder object: assignments inside the callback don't narrow a `let`.
    const seen: { defaultName?: string; data?: ArrayBuffer } = {};
    const result = await exportLibrary(
      [makeTake('Morning read', 1), makeTake('Evening read', 2)],
      new Date(2026, 4, 7, 12),
      async (input) => {
        seen.defaultName = input.defaultName;
        seen.data = input.data;
        return { saved: true };
      },
    );

    expect(result).toBe('denspeak-takes-2026-05-07.zip');
    expect(seen.defaultName).toBe('denspeak-takes-2026-05-07.zip');
    const { entries } = parseZip(new Uint8Array(seen.data ?? new ArrayBuffer(0)));
    expect(entries.map((entry) => entry.name)).toEqual(['Morning read.wav', 'Evening read.wav']);
  });

  it('numbers duplicate take names so nothing is overwritten', async () => {
    let data: ArrayBuffer = new ArrayBuffer(0);
    await exportLibrary(
      [makeTake('Same name', 1), makeTake('Same name', 2), makeTake('Same name', 3)],
      new Date(2026, 4, 7, 12),
      async (input) => {
        data = input.data;
        return { saved: true };
      },
    );
    const { entries } = parseZip(new Uint8Array(data));
    expect(entries.map((entry) => entry.name)).toEqual([
      'Same name.wav',
      'Same name 2.wav',
      'Same name 3.wav',
    ]);
    // Distinct takes stay distinct inside the archive.
    expect(entries[0].data).not.toEqual(entries[1].data);
  });

describe('exportTakeBundle', () => {
  const report = { seconds: 2, peakDb: -4, rmsDb: -20, noiseFloorDb: -70 };
  const captions = {
    srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
    vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
  };

  async function bundle(
    take: ReturnType<typeof makeTake> & { captions?: typeof captions },
    options?: Parameters<typeof exportTakeBundle>[1],
  ): Promise<{ fileName: string | null; entries: ParsedEntry[] }> {
    let data = new ArrayBuffer(0);
    let defaultName = '';
    const fileName = await exportTakeBundle(take, {
      analyze: async () => report,
      api: async (input) => {
        defaultName = input.defaultName;
        data = input.data;
        return { saved: true };
      },
      when: new Date(2026, 4, 7, 12),
      ...options,
    });
    expect(defaultName).toBe(fileName);
    const { entries } = parseZip(new Uint8Array(data));
    return { fileName, entries };
  }

  function textOf(entry: ParsedEntry): string {
    return new TextDecoder().decode(entry.data);
  }

  // The shift itself is locked in captions.test.ts against the real ACX
  // rebuild; both bundle tests below only ship whatever shifted captions
  // the Match save path handed them — a fixed representative head delta.
  const HEAD_DELTA_SECONDS = 0.71;
  const ORIGINAL_CUES = [
    { start: 0.04, end: 0.44, text: 'hello world', speaker: 'Leah' },
    { start: 0.54, end: 1.04, text: 'caption proof line', speaker: 'Ryan' },
  ];
  const SHIFTED = offsetStoredCaptions(
    { srt: formatSRT(ORIGINAL_CUES), vtt: formatVTT(ORIGINAL_CUES) },
    HEAD_DELTA_SECONDS,
  );

  it('packs WAV audio, both caption files and the loudness report', async () => {
    const { fileName, entries } = await bundle({ ...makeTake('Morning read', 1), captions });
    expect(fileName).toBe('Morning read bundle.zip');
    expect(entries.map((entry) => entry.name)).toEqual([
      'Morning read.wav',
      'Morning read.srt',
      'Morning read.vtt',
      'Morning read.loudness.txt',
    ]);
    expect(textOf(entries[1])).toBe(captions.srt);
    expect(textOf(entries[2])).toBe(captions.vtt);
    const loudness = textOf(entries[3]);
    expect(loudness).toContain('Audiobook');
    expect(loudness).toContain('Verdict: PASS');
    expect(loudness).toContain('Morning read.wav');
  });

  it('encodes MP3 audio when asked', async () => {
    const mp3 = new Blob(['mp3bytes'], { type: 'audio/mpeg' });
    const { entries } = await bundle(
      { ...makeTake('Evening read', 2), captions },
      { format: 'mp3', encode: async () => mp3 },
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      'Evening read.mp3',
      'Evening read.srt',
      'Evening read.vtt',
      'Evening read.loudness.txt',
    ]);
    expect(textOf(entries[0])).toBe('mp3bytes');
  });

  it('still bundles audio plus the report when captions are missing', async () => {
    const { entries } = await bundle(makeTake('Silent take', 3));
    expect(entries.map((entry) => entry.name)).toEqual([
      'Silent take.wav',
      'Silent take.loudness.txt',
    ]);
    expect(textOf(entries[1])).toContain('no stored captions');
  });

  it('reports a cancelled dialog', async () => {
    const cancelled = await exportTakeBundle(
      { ...makeTake('Solo', 9), captions },
      { analyze: async () => report, api: async () => ({ saved: false }) },
    );
    expect(cancelled).toBeNull();
  });

  it('ships the post-Match shifted captions, not the pre-Match originals', async () => {
    const original = { srt: formatSRT(ORIGINAL_CUES), vtt: formatVTT(ORIGINAL_CUES) };
    expect(SHIFTED.srt).not.toBe(original.srt);
    // The bundle is built from the saved post-Match take.
    const { entries } = await bundle({ ...makeTake('Matched read', 4), captions: SHIFTED });
    expect(entries.map((entry) => entry.name)).toEqual([
      'Matched read.wav',
      'Matched read.srt',
      'Matched read.vtt',
      'Matched read.loudness.txt',
    ]);
    expect(textOf(entries[1])).toBe(SHIFTED.srt);
    expect(textOf(entries[2])).toBe(SHIFTED.vtt);
    expect(textOf(entries[1])).not.toBe(original.srt);
    expect(textOf(entries[2])).not.toBe(original.vtt);
    // And the shipped cues sit on the rebuilt audio grid with labels intact.
    const roundMs = (value: number): number => Math.round(value * 1000) / 1000;
    const shipped = parseCues(textOf(entries[1]));
    expect(shipped.map((cue) => cue.start)).toEqual(
      ORIGINAL_CUES.map((cue) => roundMs(cue.start + HEAD_DELTA_SECONDS)),
    );
    expect(shipped.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    expect(parseCues(textOf(entries[2]))).toEqual(shipped);
  });

  it('ships byte-identical shifted captions in the MP3 bundle too', async () => {
    // Encoding swaps the audio entry only; the caption bytes must be
    // untouched by the format choice.
    const mp3 = new Blob(['mp3bytes'], { type: 'audio/mpeg' });
    const { entries } = await bundle(
      { ...makeTake('Matched read', 4), captions: SHIFTED },
      { format: 'mp3', encode: async () => mp3 },
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      'Matched read.mp3',
      'Matched read.srt',
      'Matched read.vtt',
      'Matched read.loudness.txt',
    ]);
    expect(textOf(entries[0])).toBe('mp3bytes');
    const encoder = new TextEncoder();
    expect(entries[1].data).toEqual(encoder.encode(SHIFTED.srt));
    expect(entries[2].data).toEqual(encoder.encode(SHIFTED.vtt));
    const shipped = parseCues(textOf(entries[1]));
    expect(shipped.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    expect(parseCues(textOf(entries[2]))).toEqual(shipped);
  });
});

describe('formatLoudnessReport', () => {
  it('lists every check with its verdict', () => {
    const standard = LOUDNESS_STANDARDS[0];
    const report = { seconds: 2, peakDb: -1, rmsDb: -20, noiseFloorDb: -70 };
    const text = formatLoudnessReport({
      takeName: 'Hot take',
      audioFile: 'Hot take.wav',
      report,
      standard,
      result: checkLoudness(report, standard),
      captionsIncluded: true,
    });
    expect(text).toContain('Hot take — loudness report');
    expect(text).toContain('Verdict: FAIL');
    expect(text).toContain('Peak:');
    expect(text).toContain('Loudness:');
    expect(text).toContain('Noise floor:');
  });
});

  it('honours a custom file name and reports a cancelled dialog', async () => {
    const takes = [makeTake('Solo', 9)];
    const custom = await exportLibrary(takes, new Date(), async () => ({ saved: true }), 'book.zip');
    expect(custom).toBe('book.zip');
    const cancelled = await exportLibrary(takes, new Date(), async () => ({ saved: false }), 'book.zip');
    expect(cancelled).toBeNull();
  });
});
