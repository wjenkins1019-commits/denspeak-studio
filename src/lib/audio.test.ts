// Tests for the WAV writer and parser: header layout, clipping behaviour,
// error cases, and a lossless-enough round trip through both.
import { describe, expect, it } from 'vitest';
import { decodeWavPcm, encodeWav, resample } from './audio';

function tone(length = 256, rate = 22_050): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / rate);
  }
  return samples;
}

describe('resample', () => {
  it('keeps the passband: a 6 kHz tone survives a small ratio', () => {
    const rate = 22_050;
    const source = new Float32Array(4096);
    for (let i = 0; i < source.length; i += 1) source[i] = Math.sin((2 * Math.PI * 6000 * i) / rate);

    const out = resample(source, 1.026);
    expect(out).toHaveLength(Math.round(source.length * 1.026));

    let peak = 0;
    for (let i = 1000; i < 3000; i += 1) peak = Math.max(peak, Math.abs(out[i]));
    // Linear interpolation landed near 0.8 here (about -2 dB), which is the
    // muffling this kernel exists to avoid; a band-limited one stays flat.
    expect(peak).toBeGreaterThan(0.97);
    expect(peak).toBeLessThan(1.03);
  });

  it('is a no-op at ratio 1 and tolerates empty input', () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    expect(Array.from(resample(input, 1))).toEqual(Array.from(input));
    expect(resample(new Float32Array(0), 2)).toHaveLength(0);
  });
});

function header(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const tag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  return {
    tag,
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
  };
}

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header with matching sizes', () => {
    const samples = tone();
    const buffer = encodeWav(samples, 22_050);
    expect(buffer.byteLength).toBe(44 + samples.length * 2);

    const parsed = header(buffer);
    expect(parsed.tag(0)).toBe('RIFF');
    expect(parsed.tag(8)).toBe('WAVE');
    expect(parsed.tag(12)).toBe('fmt ');
    expect(parsed.tag(36)).toBe('data');
    expect(parsed.format).toBe(1);
    expect(parsed.channels).toBe(1);
    expect(parsed.sampleRate).toBe(22_050);
    expect(parsed.bits).toBe(16);
    expect(parsed.dataSize).toBe(samples.length * 2);
  });
});

describe('decodeWavPcm', () => {
  it('round-trips the writer within two quantisation steps', () => {
    const samples = tone(1024);
    const decoded = decodeWavPcm(encodeWav(samples, 22_050));
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.samples).toHaveLength(samples.length);
    // The writer scales the positive side by 0x7fff and the parser divides by
    // 0x8000, so positive samples carry an extra ~1 LSB of error on top of
    // the half-LSB rounding both sides share.
    let worst = 0;
    for (let i = 0; i < samples.length; i += 1) {
      worst = Math.max(worst, Math.abs(decoded.samples[i] - samples[i]));
    }
    expect(worst).toBeLessThan(1 / 16_384);
  });

  it('clips out-of-range input instead of wrapping', () => {
    const decoded = decodeWavPcm(encodeWav(new Float32Array([2, -2, 1, -1]), 8000));
    expect(decoded.samples[0]).toBeCloseTo(1, 4);
    expect(decoded.samples[1]).toBeCloseTo(-1, 4);
  });

  it('mixes stereo down to mono', () => {
    const frames = 16;
    const buffer = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(encodeWav(new Float32Array(frames), 8000));
    bytes.forEach((byte, i) => new Uint8Array(buffer)[i] = byte);
    // Rewrite the header as two channels, then fill L=+0.5 / R=-0.5.
    view.setUint16(22, 2, true);
    view.setUint32(40, frames * 4, true);
    for (let frame = 0; frame < frames; frame += 1) {
      view.setInt16(44 + frame * 4, 0x4000, true);
      view.setInt16(44 + frame * 4 + 2, -0x4000, true);
    }
    const decoded = decodeWavPcm(buffer);
    expect(decoded.samples).toHaveLength(frames);
    for (const sample of decoded.samples) expect(sample).toBeCloseTo(0, 6);
  });

  it('rejects non-WAV, float and empty input', () => {
    expect(() => decodeWavPcm(new ArrayBuffer(0))).toThrow(/WAV/);
    expect(() => decodeWavPcm(new TextEncoder().encode('not audio at all....').buffer as ArrayBuffer)).toThrow(
      /WAV/,
    );

    const float = encodeWav(tone(8), 8000);
    new DataView(float).setUint16(20, 3, true); // IEEE float, unsupported
    expect(() => decodeWavPcm(float)).toThrow(/PCM/);

    expect(() => decodeWavPcm(encodeWav(new Float32Array(0), 8000))).toThrow(/no audio/);
  });
});
