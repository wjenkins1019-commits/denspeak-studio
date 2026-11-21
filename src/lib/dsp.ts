// Shared DSP primitives: biquads, a level-evening compressor and peak
// normalisation. Used by the naturalness chain, the equaliser and the sample
// processor, so a preset means the same thing everywhere.

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export type FilterType = 'peak' | 'lowShelf' | 'highShelf' | 'highPass' | 'lowPass';

function normalise(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** RBJ cookbook biquad. `q` is ignored by the shelf types. */
export function makeBiquad(
  type: FilterType,
  sampleRate: number,
  frequency: number,
  gainDb: number,
  q = 0.707,
): Biquad {
  const nyquist = sampleRate / 2;
  const f = Math.min(Math.max(frequency, 10), nyquist * 0.95);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sin / (2 * Math.max(0.05, q));

  switch (type) {
    case 'peak':
      return normalise(
        1 + alpha * A,
        -2 * cos,
        1 - alpha * A,
        1 + alpha / A,
        -2 * cos,
        1 - alpha / A,
      );

    case 'highPass':
      return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);

    case 'lowPass':
      return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);

    case 'highShelf': {
      const beta = 2 * Math.sqrt(A) * (sin / Math.SQRT2);
      return normalise(
        A * (A + 1 + (A - 1) * cos + beta),
        -2 * A * (A - 1 + (A + 1) * cos),
        A * (A + 1 + (A - 1) * cos - beta),
        A + 1 - (A - 1) * cos + beta,
        2 * (A - 1 - (A + 1) * cos),
        A + 1 - (A - 1) * cos - beta,
      );
    }

    case 'lowShelf': {
      const beta = 2 * Math.sqrt(A) * (sin / Math.SQRT2);
      return normalise(
        A * (A + 1 - (A - 1) * cos + beta),
        2 * A * (A - 1 - (A + 1) * cos),
        A * (A + 1 - (A - 1) * cos - beta),
        A + 1 + (A - 1) * cos + beta,
        -2 * (A - 1 + (A + 1) * cos),
        A + 1 + (A - 1) * cos - beta,
      );
    }
  }
}

/** Apply a biquad in place (transposed direct form II). */
export function applyBiquad(samples: Float32Array, biquad: Biquad): void {
  const { b0, b1, b2, a1, a2 } = biquad;
  let z1 = 0;
  let z2 = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const input = samples[i];
    const output = b0 * input + z1;
    z1 = b1 * input - a1 * output + z2;
    z2 = b2 * input - a2 * output;
    samples[i] = output;
  }
}

export interface CompressorOptions {
  thresholdDb?: number;
  ratio?: number;
  attackMs?: number;
  releaseMs?: number;
}

/** Gentle level evening; speech already has dynamics, this tames peaks only. */
export function compressSamples(
  samples: Float32Array,
  sampleRate: number,
  options: CompressorOptions = {},
): void {
  const thresholdDb = options.thresholdDb ?? -20;
  const ratio = Math.max(1, options.ratio ?? 2.4);
  const attack = Math.exp(-1 / ((options.attackMs ?? 12) / 1000 * sampleRate));
  const release = Math.exp(-1 / ((options.releaseMs ?? 150) / 1000 * sampleRate));
  const threshold = Math.pow(10, thresholdDb / 20);

  let envelope = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const level = Math.abs(samples[i]);
    envelope =
      level > envelope
        ? attack * envelope + (1 - attack) * level
        : release * envelope + (1 - release) * level;

    if (envelope <= threshold) continue;

    const overDb = 20 * Math.log10(envelope / threshold);
    const reductionDb = overDb * (1 - 1 / ratio);
    samples[i] *= Math.pow(10, -reductionDb / 20);
  }
}

/** Peak-normalise to `targetDb` (default -1 dBFS) with a soft clip guard. */
export function normalizePeak(samples: Float32Array, targetDb = -1): void {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak === 0) return;

  const gain = Math.pow(10, targetDb / 20) / peak;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
}
