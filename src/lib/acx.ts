// ACX head/tail and room-tone handling.
//
// After loudness, the next biggest audiobook rejection reason is the edges:
// ACX wants 0.5–1 s of room tone at the head and 1–5 s at the tail. Renders
// used to ship with ~40 ms edges (trimSilence leaves a 40 ms pad and the last
// block has no trailing pause), so every preset render technically failed.
//
// The check measures leading/trailing near-silence; the fix trims long edges
// and pads short ones back to safely-inside targets (0.75 s head, 2 s tail).
// Padding reuses the take's own quietest audio looped when the take has
// recorded room tone, and digital silence when it doesn't (synth takes) —
// cutting digital silence into a recorded take would be an audible splice,
// and cutting recorded tone into a synth take would add noise for nothing.
export interface AcxEnds {
  /** Leading near-silence, ms. */
  headMs: number;
  /** Trailing near-silence, ms. */
  tailMs: number;
}

export interface AcxEndsFix {
  /** Positive when padded, negative when trimmed. */
  headDeltaMs: number;
  /** Positive when padded, negative when trimmed. */
  tailDeltaMs: number;
  /** True when the fill came from the take's own room tone, not silence. */
  roomTone: boolean;
}

/** ACX acceptance windows. */
export const ACX_HEAD_MIN_MS = 500;
export const ACX_HEAD_MAX_MS = 1000;
export const ACX_TAIL_MIN_MS = 1000;
export const ACX_TAIL_MAX_MS = 5000;

/** Safely-inside targets the fix pads/trims to. */
export const ACX_HEAD_TARGET_MS = 750;
export const ACX_TAIL_TARGET_MS = 2000;

/**
 * Below this, an edge move is measurement noise, not a fix worth mentioning:
 * the UIs only narrate edge/caption shifts past 50 ms (real rebuilds move
 * hundreds of ms; the no-op path carries exactly zero).
 */
export const ENDS_FIX_NOTE_MIN_MS = 50;

/** A 10 ms window peaking below this (≈ −54 dBFS) counts as silence/room tone. */
const SILENCE_PEAK = 0.002;
/** 10 ms measurement windows. */
const WINDOW_S = 0.01;

/** A 50 ms window with an RMS inside this band is usable room tone to loop. */
const ROOM_TONE_MIN_DB = -80;
const ROOM_TONE_MAX_DB = -40;
/** 50 ms windows for the room-tone hunt. */
const TONE_WINDOW_S = 0.05;

function windowCount(samples: Float32Array, sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * WINDOW_S));
}

function isSilentWindow(
  samples: Float32Array,
  from: number,
  count: number,
): boolean {
  for (let i = 0; i < count; i += 1) {
    if (Math.abs(samples[from + i]) >= SILENCE_PEAK) return false;
  }
  return true;
}

/** Leading/trailing near-silence in ms. Throws on silence: nothing to edge. */
export function measureEnds(samples: Float32Array, sampleRate: number): AcxEnds {
  if (!(sampleRate > 0) || samples.length === 0) throw new Error('No audible speech to match.');
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
  }
  if (!(peak > 0) || 20 * Math.log10(peak) <= -100) throw new Error('No audible speech to match.');

  const window = windowCount(samples, sampleRate);
  let headWindows = 0;
  for (let from = 0; from < samples.length; from += window) {
    const count = Math.min(window, samples.length - from);
    if (!isSilentWindow(samples, from, count)) break;
    headWindows += 1;
    if (from + window >= samples.length) break;
  }
  let tailWindows = 0;
  for (let from = samples.length; from > 0; from -= window) {
    const count = Math.min(window, from);
    if (!isSilentWindow(samples, from - count, count)) break;
    tailWindows += 1;
  }
  // A fully-silent file is refused above; clamp overlap for safety anyway.
  const totalWindows = Math.ceil(samples.length / window);
  if (headWindows + tailWindows > totalWindows) tailWindows = totalWindows - headWindows;
  const msPerWindow = (window / sampleRate) * 1000;
  return { headMs: headWindows * msPerWindow, tailMs: tailWindows * msPerWindow };
}

export function formatMs(valueMs: number): string {
  return `${(valueMs / 1000).toFixed(2)} s`;
}

export interface EndsCheck {
  metric: string;
  value: string;
  verdict: 'pass' | 'fail';
  detail: string;
}

/** Grade edges against the ACX windows. Ad spots have no edge rule. */
export function checkEnds(ends: AcxEnds): { checks: EndsCheck[]; verdict: 'pass' | 'fail' } {
  const head =
    ends.headMs >= ACX_HEAD_MIN_MS && ends.headMs <= ACX_HEAD_MAX_MS
      ? {
          metric: 'Head silence',
          value: formatMs(ends.headMs),
          verdict: 'pass' as const,
          detail: 'Inside the 0.50–1.00 s ACX opening.',
        }
      : {
          metric: 'Head silence',
          value: formatMs(ends.headMs),
          verdict: 'fail' as const,
          detail: 'ACX wants 0.50–1.00 s of room tone before the first word.',
        };
  const tail =
    ends.tailMs >= ACX_TAIL_MIN_MS && ends.tailMs <= ACX_TAIL_MAX_MS
      ? {
          metric: 'Tail silence',
          value: formatMs(ends.tailMs),
          verdict: 'pass' as const,
          detail: 'Inside the 1–5 s ACX closing.',
        }
      : {
          metric: 'Tail silence',
          value: formatMs(ends.tailMs),
          verdict: 'fail' as const,
          detail: 'ACX wants 1–5 s of room tone after the last word.',
        };
  return { checks: [head, tail], verdict: head.verdict === 'pass' && tail.verdict === 'pass' ? 'pass' : 'fail' };
}

/**
 * The take's own room tone: its quietest 50 ms window, looped as fill. Null
 * when the take has none (digital silence throughout the gaps) — the caller
 * then pads with silence instead of inventing noise.
 */
export function extractRoomTone(samples: Float32Array, sampleRate: number): Float32Array | null {
  const window = Math.max(1, Math.round(sampleRate * TONE_WINDOW_S));
  let bestRms = Number.POSITIVE_INFINITY;
  let bestFrom = -1;
  for (let from = 0; from < samples.length; from += window) {
    const count = Math.min(window, samples.length - from);
    let sum = 0;
    for (let i = 0; i < count; i += 1) sum += samples[from + i] * samples[from + i];
    const rms = Math.sqrt(sum / count);
    if (rms < bestRms) {
      bestRms = rms;
      bestFrom = from;
    }
  }
  if (bestFrom < 0 || !(bestRms > 0)) return null;
  const db = 20 * Math.log10(bestRms);
  if (!(db > ROOM_TONE_MIN_DB) || !(db < ROOM_TONE_MAX_DB)) return null;
  return samples.slice(bestFrom, bestFrom + Math.min(window, samples.length - bestFrom));
}

function makeFill(length: number, tone: Float32Array | null): Float32Array {
  const fill = new Float32Array(length);
  if (!tone || tone.length === 0) return fill;
  for (let i = 0; i < length; i += 1) fill[i] = tone[i % tone.length];
  return fill;
}

/**
 * Trim/pad the edges to the ACX targets. Already-passing takes come back
 * untouched (same buffer, zero fix); the input is never mutated. Throws on
 * silence, like the loudness fix.
 */
export function ensureAcxEnds(
  samples: Float32Array,
  sampleRate: number,
): { samples: Float32Array; fix: AcxEndsFix } {
  const ends = measureEnds(samples, sampleRate);
  // Already inside the ACX windows: leave the audio alone. Rebuilding would
  // re-quantize the edges to whole 10 ms measurement windows and drift a
  // re-match by ~8 ms at 22050 Hz — so a matched take must be a no-op here
  // and carry a zero head delta for its captions.
  if (checkEnds(ends).verdict === 'pass') {
    return { samples, fix: { headDeltaMs: 0, tailDeltaMs: 0, roomTone: false } };
  }
  const msPerSample = 1000 / sampleRate;

  let headSamples = Math.round(ends.headMs / msPerSample);
  let tailSamples = Math.round(ends.tailMs / msPerSample);
  headSamples = Math.min(headSamples, samples.length);
  tailSamples = Math.min(tailSamples, samples.length - headSamples);

  // The voiced core between the silent edges; trimming only ever cuts silence.
  let start = headSamples;
  let end = samples.length - tailSamples;
  if (end < start) end = start;

  const targetHead = Math.round((ACX_HEAD_TARGET_MS / 1000) * sampleRate);
  const targetTail = Math.round((ACX_TAIL_TARGET_MS / 1000) * sampleRate);

  const tone = extractRoomTone(samples, sampleRate);
  // The fill must read as silence to the edge meter, or the rebuild can never
  // converge: a loud-tone fill measures 0 ms of head, so every Match would pad
  // another 0.75 s / 2.0 s and shift captions again, forever. Leave takes whose
  // quietest audio is louder than the silence threshold alone (gain still runs).
  if (tone !== null && !isSilentWindow(tone, 0, tone.length)) {
    return { samples, fix: { headDeltaMs: 0, tailDeltaMs: 0, roomTone: false } };
  }
  // Targets sit inside the windows by construction; clamp defensively.
  const outHead = Math.min(targetHead, Math.round((ACX_HEAD_MAX_MS / 1000) * sampleRate));
  const outTail = Math.min(targetTail, Math.round((ACX_TAIL_MAX_MS / 1000) * sampleRate));

  const headFill = makeFill(Math.max(0, outHead), tone);
  const tailFill = makeFill(Math.max(0, outTail), tone);

  const core = samples.slice(start, end);
  const out = new Float32Array(headFill.length + core.length + tailFill.length);
  out.set(headFill, 0);
  out.set(core, headFill.length);
  out.set(tailFill, headFill.length + core.length);

  const msPerSampleOut = 1000 / sampleRate;
  return {
    samples: out,
    fix: {
      headDeltaMs: outHead * msPerSampleOut - ends.headMs,
      tailDeltaMs: outTail * msPerSampleOut - ends.tailMs,
      roomTone: tone !== null,
    },
  };
}
