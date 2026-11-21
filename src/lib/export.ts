// Export helpers: filesystem-safe names, a one-click save, and a ZIP bundle of
// the whole library. WAV data is already uncompressed, so the archive stores
// entries as-is instead of deflating them.
import type { Take } from './library';
import { analyzeTake, encodeMp3 } from './dspClient';
import { MP3_BITRATE_KBPS } from './mp3';
import {
  checkLoudness,
  LOUDNESS_STANDARDS,
  type LoudnessReport,
  type LoudnessResult,
  type LoudnessStandard,
} from './loudness';

/** Characters Windows, macOS and Linux disagree about. */
const ILLEGAL = /[\\/:*?"<>|]/g;

/** "My take (raw).wav" -> "My take (raw).wav", with the unsafe bits removed. */
export function exportFileName(name: string, extension: string): string {
  const base = name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 90)
    .trim();
  return `${base || 'denspeak-studio'}.${extension}`;
}

/** Hand a blob to the browser's download manager with the given name. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking straight away can cancel the write on slower disks.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface SaveDialogFilter {
  name: string;
  extensions: string[];
}

export interface DesktopSaveApi {
  saveFile: (input: {
    defaultName: string;
    filters: SaveDialogFilter[];
    data: ArrayBuffer;
  }) => Promise<{ saved: boolean }>;
}

declare global {
  interface Window {
    denspeak?: { isDesktop?: boolean; saveFile?: DesktopSaveApi['saveFile'] };
  }
}

export const WAV_FILTERS: SaveDialogFilter[] = [{ name: 'WAV audio', extensions: ['wav'] }];
export const MP3_FILTERS: SaveDialogFilter[] = [{ name: 'MP3 audio', extensions: ['mp3'] }];
export const ZIP_FILTERS: SaveDialogFilter[] = [{ name: 'ZIP archive', extensions: ['zip'] }];
export const SRT_FILTERS: SaveDialogFilter[] = [{ name: 'SubRip subtitles', extensions: ['srt'] }];
export const VTT_FILTERS: SaveDialogFilter[] = [{ name: 'WebVTT subtitles', extensions: ['vtt'] }];
export const BUNDLE_FILTERS: SaveDialogFilter[] = [{ name: 'ZIP archive', extensions: ['zip'] }];

/**
 * Save As on desktop (native dialog through the preload bridge), plain
 * download everywhere else. The dialog path is injectable so tests can drive
 * it without opening an OS window.
 */
export async function saveExport(
  blob: Blob,
  fileName: string,
  filters: SaveDialogFilter[],
  api: DesktopSaveApi['saveFile'] | undefined = window.denspeak?.saveFile,
): Promise<boolean> {
  if (api) {
    const { saved } = await api({ defaultName: fileName, filters, data: await blob.arrayBuffer() });
    return saved;
  }
  saveBlob(blob, fileName);
  return true;
}

export function exportTake(
  take: Take,
  format: 'wav' | 'mp3' = 'wav',
  api?: DesktopSaveApi['saveFile'],
): Promise<boolean> {
  if (format === 'mp3') return exportTakeMp3(take, api);
  return saveExport(take.blob, exportFileName(take.name, 'wav'), WAV_FILTERS, api);
}

/** Encode the take as MP3 bytes (128 kbps mono) without touching the library copy. */
export async function takeToMp3Blob(
  take: Pick<Take, 'blob'>,
  bitrate: number = MP3_BITRATE_KBPS,
): Promise<Blob> {
  return encodeMp3(take.blob, bitrate);
}

export async function exportTakeMp3(
  take: Pick<Take, 'name' | 'blob'>,
  api?: DesktopSaveApi['saveFile'],
  bitrate: number = MP3_BITRATE_KBPS,
): Promise<boolean> {
  const mp3 = await takeToMp3Blob(take, bitrate);
  return saveExport(mp3, exportFileName(take.name, 'mp3'), MP3_FILTERS, api);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

interface ArchiveEntry {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Minimal ZIP writer: stored entries, UTF-8 names, no ZIP64. */
export function zipStored(entries: ArchiveEntry[], when = new Date()): Blob {
  const { time, date } = dosStamp(when);
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 file names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, entry.bytes);

    const directory = new DataView(new ArrayBuffer(46));
    directory.setUint32(0, 0x02014b50, true);
    directory.setUint16(4, 20, true);
    directory.setUint16(6, 20, true);
    directory.setUint16(8, 0x0800, true);
    directory.setUint16(10, 0, true);
    directory.setUint16(12, time, true);
    directory.setUint16(14, date, true);
    directory.setUint32(16, crc, true);
    directory.setUint32(20, size, true);
    directory.setUint32(24, size, true);
    directory.setUint16(28, name.length, true);
    directory.setUint16(30, 0, true);
    directory.setUint16(32, 0, true);
    directory.setUint16(34, 0, true);
    directory.setUint16(36, 0, true);
    directory.setUint32(38, 0, true);
    directory.setUint32(42, offset, true);
    central.push(new Uint8Array(directory.buffer), name);

    centralSize += 46 + name.length;
    offset += 30 + name.length + size;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/**
 * Bundle every take into one archive, one WAV per entry, named after the take.
 * Duplicate names get a counter so nothing is overwritten inside the ZIP.
 */
export async function exportLibrary(
  takes: Take[],
  when = new Date(),
  api?: DesktopSaveApi['saveFile'],
  fileName?: string,
): Promise<string | null> {
  const entries: ArchiveEntry[] = [];
  const used = new Set<string>();

  for (const take of takes) {
    let name = exportFileName(take.name, 'wav');
    let copy = 2;
    while (used.has(name.toLowerCase())) {
      name = exportFileName(`${take.name} ${copy}`, 'wav');
      copy += 1;
    }
    used.add(name.toLowerCase());
    entries.push({ name, bytes: new Uint8Array(await take.blob.arrayBuffer()) });
  }

  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-');
  const name = fileName ?? `denspeak-takes-${stamp}.zip`;
  const saved = await saveExport(zipStored(entries, when), name, ZIP_FILTERS, api);
  return saved ? name : null;
}

export type TakeBundleFormat = 'wav' | 'mp3';

export interface TakeBundleInput {
  name: string;
  blob: Blob;
  captions?: { srt: string; vtt: string };
}

/** One submission-ready text file: what was measured, against which bar. */
export function formatLoudnessReport(input: {
  takeName: string;
  audioFile: string;
  report: LoudnessReport;
  standard: LoudnessStandard;
  result: LoudnessResult;
  captionsIncluded: boolean;
  when?: Date;
}): string {
  const lines = [
    `${input.takeName} — loudness report`,
    `Checked ${(input.when ?? new Date()).toLocaleString()} against ${input.standard.name} — ${input.standard.blurb}`,
    `Audio in this bundle: ${input.audioFile}`,
    input.captionsIncluded
      ? 'Captions in this bundle: SRT + VTT'
      : 'Captions in this bundle: none — the take has no stored captions',
    '',
    `Verdict: ${input.result.verdict.toUpperCase()}`,
    '',
    ...input.result.checks.map(
      (check) => `${check.metric}: ${check.value} — ${check.verdict.toUpperCase()} — ${check.detail}`,
    ),
    '',
    `Measured: peak ${input.report.peakDb.toFixed(1)} dBFS, RMS ${input.report.rmsDb.toFixed(1)} dBFS, ` +
      `noise floor ${input.report.noiseFloorDb.toFixed(1)} dBFS, ` +
      `length ${input.report.seconds.toFixed(1)} s.`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * One-click per-take bundle: the audio in the chosen format, the stored
 * SRT/VTT when the take has them, and a loudness report graded against the
 * given standard. Loudness is measured off the take itself in the worker.
 *
 * The analyzer and encoder are injectable so tests can drive the bundle
 * without a worker; callers pass nothing and get the real pipeline.
 */
export async function exportTakeBundle(
  take: TakeBundleInput,
  options: {
    format?: TakeBundleFormat;
    standardId?: string;
    analyze?: (blob: Blob) => Promise<LoudnessReport>;
    encode?: (take: Pick<Take, 'blob'>) => Promise<Blob>;
    api?: DesktopSaveApi['saveFile'];
    when?: Date;
  } = {},
): Promise<string | null> {
  const format = options.format ?? 'wav';
  const standard =
    LOUDNESS_STANDARDS.find((entry) => entry.id === options.standardId) ?? LOUDNESS_STANDARDS[0];
  const base = exportFileName(take.name, 'wav').slice(0, -'.wav'.length);
  const audioFile = `${base}.${format === 'mp3' ? 'mp3' : 'wav'}`;

  const [audioBytes, report] = await Promise.all([
    (async () => {
      const audio: Blob =
        format === 'mp3' ? await (options.encode ?? takeToMp3Blob)({ blob: take.blob }) : take.blob;
      return new Uint8Array(await audio.arrayBuffer());
    })(),
    (options.analyze ?? analyzeTake)(take.blob),
  ]);
  const result = checkLoudness(report, standard);

  const entries: ArchiveEntry[] = [{ name: audioFile, bytes: audioBytes }];
  if (take.captions) {
    entries.push({ name: `${base}.srt`, bytes: new TextEncoder().encode(take.captions.srt) });
    entries.push({ name: `${base}.vtt`, bytes: new TextEncoder().encode(take.captions.vtt) });
  }
  entries.push({
    name: `${base}.loudness.txt`,
    bytes: new TextEncoder().encode(
      formatLoudnessReport({
        takeName: take.name,
        audioFile,
        report,
        standard,
        result,
        captionsIncluded: Boolean(take.captions),
        when: options.when,
      }),
    ),
  });

  const fileName = exportFileName(`${take.name} bundle`, 'zip');
  const saved = await saveExport(zipStored(entries, options.when ?? new Date()), fileName, BUNDLE_FILTERS, options.api);
  return saved ? fileName : null;
}
