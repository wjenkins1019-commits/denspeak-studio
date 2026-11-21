// Lays spoken lines over a beat: each lyric line is time-fitted to a whole
// number of beats and placed on the grid, then mixed with the uploaded track.
//
// This is rap/spoken-word delivery, not melodic singing. The voices in this app
// are speech models: what makes a line sit on a beat is the timing of when it
// starts and how long it takes, which is what this module controls.

import { resample, timeStretch } from './audio';
import { normalizePeak } from './dsp';

export interface BeatSource {
  samples: Float32Array;
  sampleRate: number;
}

export interface RenderedLine {
  text: string;
  samples: Float32Array;
  sampleRate: number;
}

export interface ArrangementOptions {
  bpm: number;
  /** Where the first beat lands, in seconds. */
  offset: number;
  /** Beats each line is fitted to (4 = one bar in 4/4). */
  beatsPerLine: number;
  /** Beat level relative to the vocal, 0..1.5. */
  beatGain: number;
  /** How much of the line's slot to keep free, 0..0.5. */
  breathGap: number;
}

export interface LinePlacement {
  text: string;
  start: number;
  end: number;
  stretched: boolean;
}

export interface RapMix {
  samples: Float32Array;
  sampleRate: number;
  seconds: number;
  lines: LinePlacement[];
  /** Beats per minute the grid actually used (the reported tempo, after fitting). */
  bpm: number;
}

const MIN_STRETCH = 0.55;
const MAX_STRETCH = 1.9;

function toRate(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  return resample(samples, to / from);
}

/** Fit one line into `slotSeconds` without mangling it beyond recognition. */
function fitLine(line: RenderedLine, slotSeconds: number): { samples: Float32Array; stretched: boolean } {
  const length = line.samples.length / line.sampleRate;
  if (length <= 0 || slotSeconds <= 0) return { samples: line.samples, stretched: false };

  const desired = slotSeconds / length;
  const rate = Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, desired));
  if (Math.abs(rate - 1) < 0.02) return { samples: line.samples, stretched: false };

  return { samples: timeStretch(line.samples, rate), stretched: true };
}

/**
 * Arrange rendered lines over a beat.
 *
 * The beat is looped if the vocal is longer than the track, which is how a
 * one-bar loop usually gets used anyway.
 */
export function arrangeRap(
  beat: BeatSource,
  lines: RenderedLine[],
  options: ArrangementOptions,
): RapMix {
  const sampleRate = beat.sampleRate;
  const beatSeconds = 60 / options.bpm;
  const slotSeconds = Math.max(0.2, beatSeconds * options.beatsPerLine);
  const usable = slotSeconds * (1 - Math.min(0.5, Math.max(0, options.breathGap)));

  const placements: LinePlacement[] = [];
  const fitted = lines.map((line, index) => {
    const start = options.offset + index * slotSeconds;
    const { samples, stretched } = fitLine(line, usable);
    const normalised = toRate(samples, line.sampleRate, sampleRate);
    placements.push({
      text: line.text,
      start,
      end: start + slotSeconds,
      stretched,
    });
    return normalised;
  });

  const vocalLength = fitted.reduce(
    (length, samples, index) => Math.max(length, Math.round(placements[index].start * sampleRate) + samples.length),
    0,
  );
  const totalLength = Math.max(vocalLength + Math.round(sampleRate * 0.5), beat.samples.length);

  const output = new Float32Array(totalLength);
  for (let i = 0; i < beat.samples.length; i += 1) {
    output[i] += beat.samples[i] * options.beatGain;
  }
  // Loop the beat under a longer vocal.
  for (let start = beat.samples.length; start < totalLength; start += beat.samples.length) {
    const count = Math.min(beat.samples.length, totalLength - start);
    for (let i = 0; i < count; i += 1) output[start + i] += beat.samples[i] * options.beatGain;
  }

  for (let index = 0; index < fitted.length; index += 1) {
    const samples = fitted[index];
    const start = Math.max(0, Math.round(placements[index].start * sampleRate));
    const count = Math.min(samples.length, output.length - start);
    for (let i = 0; i < count; i += 1) output[start + i] += samples[i];
  }

  normalizePeak(output, -1);

  return {
    samples: output,
    sampleRate,
    seconds: output.length / sampleRate,
    lines: placements,
    bpm: options.bpm,
  };
}
