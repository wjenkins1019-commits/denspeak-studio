// Tempo and grid estimation for an uploaded beat.
//
// Kick-drum energy carries the pulse in most music, so the detector works on a
// low-passed onset envelope: autocorrelate it to find the beat period, then
// slide a click grid over the envelope to find where the beats actually fall.

export interface TempoInfo {
  bpm: number;
  /** Seconds per beat. */
  beatSeconds: number;
  /** Seconds from the start of the file to the first detected beat. */
  offset: number;
  /** 0..1 — how periodic the pulse was. Below ~0.25 the tempo is a guess. */
  confidence: number;
  seconds: number;
}

const FRAME = 1024;
const HOP = 256;

/** One-pole low pass, used to isolate the kick region. */
function lowpass(input: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const output = new Float32Array(input.length);
  const coefficient = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let state = 0;
  for (let i = 0; i < input.length; i += 1) {
    state = input[i] * (1 - coefficient) + state * coefficient;
    output[i] = state;
  }
  return output;
}

function onsetEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const low = lowpass(samples, sampleRate, 160);
  const frames = Math.max(0, Math.floor((low.length - FRAME) / HOP) + 1);
  const energy = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const start = frame * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      const value = low[start + i];
      sum += value * value;
    }
    energy[frame] = Math.sqrt(sum / FRAME);
  }

  // Half-wave rectified difference: rises are onsets, decays are not.
  const flux = new Float32Array(frames);
  for (let i = 1; i < frames; i += 1) {
    flux[i] = Math.max(0, energy[i] - energy[i - 1]);
  }

  // Remove slow drift so a loud chorus does not dominate the correlation.
  const smoothed = new Float32Array(frames);
  const radius = 12;
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    let count = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const index = i + k;
      if (index < 0 || index >= frames) continue;
      sum += flux[index];
      count += 1;
    }
    smoothed[i] = flux[i] - sum / Math.max(1, count);
  }

  return smoothed;
}

/** Estimate tempo and the first beat position. */
export function detectTempo(samples: Float32Array, sampleRate: number): TempoInfo {
  const seconds = samples.length / sampleRate;
  const flux = onsetEnvelope(samples, sampleRate);
  const frameRate = sampleRate / HOP;

  if (flux.length < frameRate * 2) {
    return { bpm: 0, beatSeconds: 0, offset: 0, confidence: 0, seconds };
  }

  const minLag = Math.max(2, Math.round(frameRate * 0.28)); // 214 BPM
  const maxLag = Math.round(frameRate * 1.0); // 60 BPM

  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < flux.length; i += 1) sum += flux[i] * flux[i + lag];
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }

  if (bestLag === 0) return { bpm: 0, beatSeconds: 0, offset: 0, confidence: 0, seconds };

  let bpm = (60 * frameRate) / bestLag;
  while (bpm > 200) bpm /= 2;
  while (bpm < 70) bpm *= 2;

  // Re-derive the lag for the folded tempo so the grid matches what we report.
  const beatFrames = (60 / bpm) * frameRate;
  const lag = Math.round(beatFrames);

  let bestOffset = 0;
  let bestPhase = -Infinity;
  for (let offset = 0; offset < lag; offset += 1) {
    let sum = 0;
    let hits = 0;
    for (let position = offset; position < flux.length; position += lag) {
      sum += Math.max(0, flux[Math.round(position)] ?? 0);
      hits += 1;
    }
    const score = hits > 0 ? sum / hits : 0;
    if (score > bestPhase) {
      bestPhase = score;
      bestOffset = offset;
    }
  }

  // The integer search is quantised to the envelope hop, so the grid can sit a
  // few frames late. Centre it on the actual onset peaks.
  const deltas: number[] = [];
  for (let position = bestOffset; position < flux.length; position += lag) {
    const centre = Math.round(position);
    let weighted = 0;
    let total = 0;
    for (let relative = -8; relative <= 8; relative += 1) {
      const index = centre + relative;
      if (index < 0 || index >= flux.length) continue;
      const weight = Math.max(0, flux[index]);
      weighted += relative * weight;
      total += weight;
    }
    if (total > 0) deltas.push(weighted / total);
  }
  const averageDelta =
    deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
  bestOffset = (bestOffset + averageDelta + lag) % lag;

  let energy = 0;
  for (let i = 0; i < flux.length; i += 1) energy += flux[i] * flux[i];
  const correlation = energy > 0 ? bestScore / energy : 0;
  const confidence = Math.min(1, Math.max(0, correlation * 4));

  // Each envelope frame is labelled by its window *start*, so its energy only
  // reacts once the window reaches an onset — half a window early on average.
  const windowLead = FRAME / 2 / sampleRate;

  return {
    bpm: Math.round(bpm * 10) / 10,
    beatSeconds: 60 / bpm,
    offset: bestOffset / frameRate + windowLead,
    confidence,
    seconds,
  };
}
