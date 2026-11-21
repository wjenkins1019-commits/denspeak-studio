import { describe, expect, it } from 'vitest';
import { applyMatch, MATCH_MAX_GAIN_DB, matchSamples, planMatch } from './match';
import { checkLoudness, LOUDNESS_STANDARDS, measureLoudness } from './loudness';
import { normalizePeak } from './dsp';

const audiobook = LOUDNESS_STANDARDS[0];
const RATE = 22050;

/**
 * Tone bursts with silent gaps, like speech with pauses. A continuous tone
 * can never pass a noise-floor check (every window is loud), which is
 * correct — the check measures the room tone in the gaps.
 */
function bursts(seconds: number, peakDb: number): Float32Array {
  const peak = Math.pow(10, peakDb / 20);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    const voiced = Math.floor(i / (RATE / 4)) % 2 === 0;
    out[i] = voiced ? Math.sin((2 * Math.PI * 220 * i) / RATE) * peak : 0;
  }
  return out;
}

function sine(seconds: number, peakDb: number): Float32Array {
  const peak = Math.pow(10, peakDb / 20);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * peak;
  return out;
}

describe('planMatch', () => {
  it('centres the RMS window', () => {
    const plan = planMatch(
      { seconds: 10, peakDb: -6, rmsDb: -14, noiseFloorDb: -80 },
      audiobook,
    );
    expect(plan.targetRmsDb).toBeCloseTo(-20.5, 9);
    expect(plan.gainDb).toBeCloseTo(-6.5, 9);
  });

  it('clamps absurd gains instead of exploding', () => {
    const plan = planMatch(
      { seconds: 10, peakDb: -90, rmsDb: -95, noiseFloorDb: -110 },
      audiobook,
    );
    expect(plan.gainDb).toBe(MATCH_MAX_GAIN_DB);
  });

  it('refuses silence', () => {
    expect(() =>
      planMatch({ seconds: 10, peakDb: -120, rmsDb: -120, noiseFloorDb: -120 }, audiobook),
    ).toThrow('No audible speech');
    expect(() =>
      planMatch({ seconds: 0, peakDb: -6, rmsDb: -9, noiseFloorDb: -80 }, audiobook),
    ).toThrow('No audible speech');
  });
});

describe('applyMatch', () => {
  it('limits peaks to the ceiling and reports it', () => {
    const samples = sine(1, -1);
    const { peakLimited } = applyMatch(samples, 0, audiobook.peakMaxDb);
    expect(peakLimited).toBe(true);
    expect(measureLoudness(samples, RATE).peakDb).toBeLessThanOrEqual(
      audiobook.peakMaxDb + 0.01,
    );
  });

  it('leaves a settled take alone and reports it', () => {
    const samples = sine(1, -10);
    const { peakLimited } = applyMatch(samples, 0, audiobook.peakMaxDb);
    expect(peakLimited).toBe(false);
  });
});

describe('matchSamples', () => {
  it('brings a hot take into the Audiobook window under the peak ceiling', () => {
    const samples = bursts(2, -1);
    expect(checkLoudness(measureLoudness(samples, RATE), audiobook).verdict).toBe('fail');

    const { gainDb } = matchSamples(samples, RATE, audiobook);
    expect(gainDb).toBeLessThan(0);
    const after = measureLoudness(samples, RATE);
    expect(checkLoudness(after, audiobook).verdict).toBe('pass');
    expect(after.peakDb).toBeLessThanOrEqual(audiobook.peakMaxDb + 0.01);
  });

  it('raises a quiet take into the window', () => {
    const samples = bursts(2, -30);
    const { gainDb } = matchSamples(samples, RATE, audiobook);
    expect(gainDb).toBeGreaterThan(0);
    expect(checkLoudness(measureLoudness(samples, RATE), audiobook).verdict).toBe('pass');
  });

  it('refuses silence', () => {
    expect(() => matchSamples(new Float32Array(RATE), RATE, audiobook)).toThrow(
      'No audible speech',
    );
  });

  it('masters peak-normalised renders into both delivery standards', () => {
    // Mirrors the DSP tail order: the EQ stage peak-normalises to -1 dBFS,
    // then preset mastering runs the same fix as Match.
    for (const standard of LOUDNESS_STANDARDS) {
      const samples = bursts(2, -1);
      normalizePeak(samples, -1);
      matchSamples(samples, RATE, standard);
      expect(checkLoudness(measureLoudness(samples, RATE), standard).verdict).toBe('pass');
    }
  });
});
