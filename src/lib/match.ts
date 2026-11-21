import { compressSamples, normalizePeak } from './dsp';
import { measureLoudness, type LoudnessReport, type LoudnessStandard } from './loudness';

export interface MatchPlan {
  /** Gain to apply, dB. Positive raises a quiet take, negative tames a hot one. */
  gainDb: number;
  /** RMS centre of the standard's window, dBFS. */
  targetRmsDb: number;
}

/** A take needing more than this is too far gone to fix with gain alone. */
export const MATCH_MAX_GAIN_DB = 30;

/**
 * Gain that centres the take in the standard's RMS window. Throws on silence:
 * there is nothing to match, and the gain math would be unbounded.
 */
export function planMatch(report: LoudnessReport, standard: LoudnessStandard): MatchPlan {
  if (!(report.seconds > 0) || !(report.peakDb > -100) || !(report.rmsDb > -100)) {
    throw new Error('No audible speech to match.');
  }
  const targetRmsDb = (standard.rmsMinDb + standard.rmsMaxDb) / 2;
  const gainDb = Math.min(
    MATCH_MAX_GAIN_DB,
    Math.max(-MATCH_MAX_GAIN_DB, targetRmsDb - report.rmsDb),
  );
  return { gainDb, targetRmsDb };
}

/**
 * The gain-plus-ceiling step on already-tamed PCM. Returns whether the
 * ceiling bit — callers report it so the fix stays honest.
 */
export function applyMatch(
  samples: Float32Array,
  gainDb: number,
  peakMaxDb: number,
): { peakLimited: boolean } {
  const gain = Math.pow(10, gainDb / 20);
  for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;

  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak > 0 && 20 * Math.log10(peak) > peakMaxDb) {
    normalizePeak(samples, peakMaxDb);
    return { peakLimited: true };
  }
  return { peakLimited: false };
}

export interface MatchResult {
  gainDb: number;
  peakLimited: boolean;
}

/**
 * The full fix in place: light compression first so a peaky take does not
 * force the whole RMS window down, then gain planned off the tamed audio,
 * then the peak ceiling. The gain is honest because it is measured after the
 * compressor, not before it.
 */
export function matchSamples(
  samples: Float32Array,
  sampleRate: number,
  standard: LoudnessStandard,
): MatchResult {
  const first = measureLoudness(samples, sampleRate);
  if (!(first.seconds > 0) || !(first.peakDb > -100) || !(first.rmsDb > -100)) {
    throw new Error('No audible speech to match.');
  }
  compressSamples(samples, sampleRate, {
    thresholdDb: -20,
    ratio: 2.4,
    attackMs: 12,
    releaseMs: 150,
  });
  const { gainDb } = planMatch(measureLoudness(samples, sampleRate), standard);
  const { peakLimited } = applyMatch(samples, gainDb, standard.peakMaxDb);
  return { gainDb, peakLimited };
}
