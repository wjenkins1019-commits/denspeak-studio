// One-click mastering check for exported takes.
//
// Measures peak, RMS and noise floor straight off the finished WAV and grades
// them against a delivery standard. The audiobook bar is the ACX submission
// rule (peaks no higher than -3 dB, RMS inside -23..-18 dB, room tone no higher
// than -60 dB); the ad bar is the house target for loud broadcast spots
// (peaks inside -1 dB, RMS -19..-13 dB, room tone -60 dB). Synthesized takes
// have digital silence between phrases, which trivially passes the noise
// check — the honest verdict, since there is no recorded room tone to fail.
// Converted microphone recordings get a real noise-floor verdict instead.
export interface LoudnessReport {
  /** Length in seconds. */
  seconds: number;
  /** Loudest sample, dBFS. */
  peakDb: number;
  /** Whole-file RMS, dBFS. */
  rmsDb: number;
  /** 5th-percentile 50 ms window RMS, dBFS — the quietest sustained sound. */
  noiseFloorDb: number;
}

export type LoudnessVerdict = 'pass' | 'warn' | 'fail';

export interface LoudnessCheck {
  metric: string;
  value: string;
  verdict: LoudnessVerdict;
  detail: string;
}

export interface LoudnessStandard {
  id: string;
  name: string;
  blurb: string;
  /** Peaks must sit at or below this, dBFS. */
  peakMaxDb: number;
  /** RMS must sit inside this window, dBFS. */
  rmsMinDb: number;
  rmsMaxDb: number;
  /** Noise floor must sit at or below this, dBFS. */
  noiseMaxDb: number;
  /** Outside RMS fails the take (audiobook); otherwise it only warns (ad). */
  rmsStrict: boolean;
}

export const LOUDNESS_STANDARDS: LoudnessStandard[] = [
  {
    id: 'audiobook',
    name: 'Audiobook',
    blurb: 'The ACX submission rule.',
    peakMaxDb: -3,
    rmsMinDb: -23,
    rmsMaxDb: -18,
    noiseMaxDb: -60,
    rmsStrict: true,
  },
  {
    id: 'ad',
    name: 'Ad Spot',
    blurb: 'Loud broadcast spot.',
    peakMaxDb: -1,
    rmsMinDb: -19,
    rmsMaxDb: -13,
    noiseMaxDb: -60,
    rmsStrict: false,
  },
];

const FLOOR_DB = -120;
/** 50 ms windows for the noise-floor estimate. */
const NOISE_WINDOW_S = 0.05;

function toDb(value: number): number {
  if (!(value > 0)) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(value));
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))];
}

export function formatDb(value: number): string {
  return `${value <= FLOOR_DB + 1 ? 'silent' : `${value.toFixed(1)} dB`}`;
}

/** Measure a finished take. Pass mono samples at `sampleRate`. */
export function measureLoudness(samples: Float32Array, sampleRate: number): LoudnessReport {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const absolute = Math.abs(samples[i]);
    if (absolute > peak) peak = absolute;
    sum += samples[i] * samples[i];
  }
  const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;

  const window = Math.max(1, Math.round(sampleRate * NOISE_WINDOW_S));
  const windows: number[] = [];
  for (let from = 0; from < samples.length; from += window) {
    const count = Math.min(window, samples.length - from);
    let windowSum = 0;
    for (let i = 0; i < count; i += 1) windowSum += samples[from + i] * samples[from + i];
    windows.push(Math.sqrt(windowSum / count));
  }
  windows.sort((a, b) => a - b);

  return {
    seconds: sampleRate > 0 ? samples.length / sampleRate : 0,
    peakDb: toDb(peak),
    rmsDb: toDb(rms),
    noiseFloorDb: toDb(percentile(windows, 0.05)),
  };
}

export interface LoudnessResult {
  checks: LoudnessCheck[];
  verdict: LoudnessVerdict;
}

/** Grade a report against a standard, worst verdict wins. */
export function checkLoudness(report: LoudnessReport, standard: LoudnessStandard): LoudnessResult {
  const checks: LoudnessCheck[] = [];
  let verdict: LoudnessVerdict = 'pass';
  const demote = (next: LoudnessVerdict): void => {
    if (next === 'fail') verdict = 'fail';
    else if (next === 'warn' && verdict === 'pass') verdict = 'warn';
  };

  const peak: LoudnessCheck =
    report.peakDb <= standard.peakMaxDb
      ? {
          metric: 'Peak',
          value: formatDb(report.peakDb),
          verdict: 'pass',
          detail: `Inside the ${standard.peakMaxDb} dB ceiling.`,
        }
      : {
          metric: 'Peak',
          value: formatDb(report.peakDb),
          verdict: 'fail',
          detail: `Over the ${standard.peakMaxDb} dB ceiling — turn the level down and render again.`,
        };
  checks.push(peak);
  demote(peak.verdict);

  let rms: LoudnessCheck;
  if (report.rmsDb < standard.rmsMinDb) {
    const verdict = standard.rmsStrict ? 'fail' : 'warn';
    rms = {
      metric: 'Loudness',
      value: formatDb(report.rmsDb),
      verdict,
      detail: `Under the ${standard.rmsMinDb}…${standard.rmsMaxDb} dB window — it will sound quiet next to matching audio. Raise the level.`,
    };
  } else if (report.rmsDb > standard.rmsMaxDb) {
    const verdict = standard.rmsStrict ? 'fail' : 'warn';
    rms = {
      metric: 'Loudness',
      value: formatDb(report.rmsDb),
      verdict,
      detail: `Over the ${standard.rmsMinDb}…${standard.rmsMaxDb} dB window — hot and possibly crushed. Back the level off.`,
    };
  } else {
    rms = {
      metric: 'Loudness',
      value: formatDb(report.rmsDb),
      verdict: 'pass',
      detail: `Inside the ${standard.rmsMinDb}…${standard.rmsMaxDb} dB window.`,
    };
  }
  checks.push(rms);
  demote(rms.verdict);

  const noise: LoudnessCheck =
    report.noiseFloorDb <= standard.noiseMaxDb
      ? {
          metric: 'Noise floor',
          value: formatDb(report.noiseFloorDb),
          verdict: 'pass',
          detail:
            report.noiseFloorDb <= -100
              ? 'Digital silence between phrases — nothing recorded to fail.'
              : `Under the ${standard.noiseMaxDb} dB ceiling.`,
        }
      : {
          metric: 'Noise floor',
          value: formatDb(report.noiseFloorDb),
          verdict: 'fail',
          detail: `Over the ${standard.noiseMaxDb} dB ceiling — record quieter or clean the gaps.`,
        };
  checks.push(noise);
  demote(noise.verdict);

  return { checks, verdict };
}
