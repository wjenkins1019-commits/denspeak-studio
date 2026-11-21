// Tests for take loudness measurement and delivery-standard grading.
import { describe, expect, it } from 'vitest';
import {
  LOUDNESS_STANDARDS,
  checkLoudness,
  formatDb,
  measureLoudness,
} from './loudness';

const RATE = 22050;

function tone(seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE);
  }
  return out;
}

function standard(id: string) {
  const found = LOUDNESS_STANDARDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing standard ${id}`);
  return found;
}

describe('measureLoudness', () => {
  it('reads peak and RMS off a tone', () => {
    // A 0.5 sine peaks at -6.02 dB with an RMS 3 dB lower.
    const report = measureLoudness(tone(2, 0.5), RATE);
    expect(report.seconds).toBeCloseTo(2, 6);
    expect(report.peakDb).toBeCloseTo(-6.02, 1);
    expect(report.rmsDb).toBeCloseTo(-9.03, 1);
  });

  it('floors silence instead of going to negative infinity', () => {
    const report = measureLoudness(new Float32Array(RATE), RATE);
    expect(report.peakDb).toBeLessThanOrEqual(-119);
    expect(report.rmsDb).toBeLessThanOrEqual(-119);
    expect(report.noiseFloorDb).toBeLessThanOrEqual(-119);
    expect(formatDb(report.peakDb)).toBe('silent');
  });

  it('hears the quietest sustained sound as the noise floor', () => {
    const out = tone(4, 0.5);
    // A -50 dB bed under the second half.
    for (let i = out.length / 2; i < out.length; i += 1) {
      out[i] = Math.pow(10, -50 / 20) * Math.sin((2 * Math.PI * 90 * i) / RATE);
    }
    const report = measureLoudness(out, RATE);
    expect(report.noiseFloorDb).toBeGreaterThan(-56);
    expect(report.noiseFloorDb).toBeLessThan(-44);
  });
});

describe('checkLoudness', () => {
  it('passes a take inside the audiobook window', () => {
    const result = checkLoudness({ seconds: 10, peakDb: -3.5, rmsDb: -20, noiseFloorDb: -72 }, standard('audiobook'));
    expect(result.verdict).toBe('pass');
    expect(result.checks).toHaveLength(3);
  });

  it('fails hot peaks and noisy beds', () => {
    const result = checkLoudness({ seconds: 10, peakDb: -0.4, rmsDb: -20, noiseFloorDb: -52 }, standard('audiobook'));
    expect(result.verdict).toBe('fail');
    expect(result.checks.find((check) => check.metric === 'Peak')?.verdict).toBe('fail');
    expect(result.checks.find((check) => check.metric === 'Noise floor')?.verdict).toBe('fail');
  });

  it('fails out-of-window RMS for audiobooks but only warns for ads', () => {
    const quiet = { seconds: 10, peakDb: -4, rmsDb: -26, noiseFloorDb: -80 };
    expect(checkLoudness(quiet, standard('audiobook')).verdict).toBe('fail');
    const ad = checkLoudness(quiet, standard('ad'));
    expect(ad.verdict).toBe('warn');
    expect(ad.checks.find((check) => check.metric === 'Loudness')?.verdict).toBe('warn');
  });

  it('calls digital silence a pass with the honest note', () => {
    const result = checkLoudness({ seconds: 10, peakDb: -4, rmsDb: -20, noiseFloorDb: -120 }, standard('audiobook'));
    const noise = result.checks.find((check) => check.metric === 'Noise floor');
    expect(noise?.verdict).toBe('pass');
    expect(noise?.detail).toMatch(/Digital silence/);
  });
});
