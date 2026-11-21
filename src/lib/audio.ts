// Audio work for the Convert view and the Studio speed control.
//
// Pitch/formant shifting is done locally with a phase vocoder (pitch) plus a
// spectral envelope warp (formant/brightness). Everything is plain JS so it works
// inside the packaged Electron renderer with no native dependencies.

const FRAME = 1024;
const HOP = 256;
/** Sinc lobes each side of the resampling kernel; more is a gentler passband edge. */
const SINC_LOBES = 12;
/** How far either side of the nominal read position the time stretch may slide. */
const WSOLA_SEARCH = 64;
/** Samples compared when scoring a candidate frame: a couple of pitch periods. */
const WSOLA_OVERLAP = 192;
/**
 * Output hop for the time stretch. Half a frame, so the Hann windows of
 * neighbouring frames sum to exactly one: copies that line up (which is what the
 * search arranges) then add back to unity gain instead of overshooting.
 */
const WSOLA_HOP = FRAME / 2;

export interface VoiceShape {
  /** Pitch shift in semitones, roughly -14..14. */
  semitones?: number;
  /** Spectral envelope shift, -1..1. Positive sounds smaller/brighter. */
  formant?: number;
  /** High-frequency tilt, -1..1. */
  brightness?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    const half = length >> 1;

    for (let start = 0; start < n; start += length) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const vRe = re[b] * cRe - im[b] * cIm;
        const vIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nextRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Band-limited resample. `factor` > 1 makes the signal longer (and lower).
 *
 * The kernel is the difference between a clear voice and a muffled one. Linear
 * interpolation is a low-pass: at 22.05 kHz it is already about 3 dB down by
 * 10 kHz, which is exactly the band that carries a voice's air and consonant
 * definition. That was easy to miss while this only ran on an explicit pitch
 * change, but the per-phrase shaping calls it on every block, so it has to be
 * transparent. A Hann-windowed sinc stays flat up to the new Nyquist and
 * attenuates above it, which also keeps a plain decimation from folding
 * aliases back into the voice.
 */
export function resample(input: Float32Array, factor: number): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (Math.abs(factor - 1) < 1e-6) return input.slice();

  const length = Math.max(1, Math.round(input.length * factor));
  const output = new Float32Array(length);
  // Cutoff in cycles per input sample: never above the input Nyquist, and
  // below the output Nyquist when decimating.
  const cutoff = 0.5 * Math.min(1, factor);
  // Half-width in input samples; it grows as the cutoff drops, so a decimation
  // keeps the same number of sinc lobes instead of getting blurrier.
  const radius = Math.max(2, SINC_LOBES / (2 * cutoff));
  const reach = Math.ceil(radius);

  for (let i = 0; i < length; i += 1) {
    const position = i / factor;
    const centre = Math.floor(position);
    const from = Math.max(0, centre - reach + 1);
    const to = Math.min(input.length - 1, centre + reach);

    let sum = 0;
    let weight = 0;
    for (let j = from; j <= to; j += 1) {
      const offset = position - j;
      if (Math.abs(offset) > radius) continue;
      const arg = 2 * cutoff * offset;
      const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * offset) / radius);
      const coefficient = sinc * window;
      sum += input[j] * coefficient;
      weight += coefficient;
    }

    // Dividing by the kernel sum holds unity gain, including at the edges where
    // the window is cut short.
    output[i] = Math.abs(weight) > 1e-6 ? sum / weight : 0;
  }

  return output;
}

/**
 * Time stretch. `rate` > 1 makes the audio longer without changing its pitch;
 * `rate` < 1 shortens it.
 *
 * This used to be a phase vocoder, and a phase vocoder is the wrong tool for the
 * speed control. It keeps the magnitude of each frame but loses the phase
 * relationship between the bins that make up one partial, so their overlap-add
 * contributions partly cancel: on speech that lands on the consonants, which
 * turn soft and airy and take the top end with them.
 *
 * WSOLA works in the time domain instead. It copies real input frames, and
 * before each one it slides a short search window to wherever the waveform
 * continues most naturally, scored by normalised cross-correlation against the
 * tail of the frame just written. Nothing is rewritten spectrally, so there is
 * no phasiness, and harmonics and noise bursts come out as they went in. Pitch
 * is untouched because the waveform is never resampled.
 */
export function timeStretch(input: Float32Array, rate: number): Float32Array {
  if (input.length < FRAME || Math.abs(rate - 1) < 0.001) return input.slice();

  const window = hann(FRAME);
  const outputLength = Math.max(1, Math.round(input.length * rate));
  const padded = outputLength + FRAME;
  const output = new Float32Array(padded);
  const normalization = new Float32Array(padded);

  // Last start that still holds a whole frame, so no frame is half zeros.
  const limit = Math.max(0, input.length - FRAME);
  const overlap = Math.min(WSOLA_OVERLAP, FRAME);
  /** Segment picked for the previous frame; -1 before the first one. */
  let previous = -1;

  // The output advances by a fixed hop while the read position advances by
  // hop / rate, which is what makes the result longer or shorter.
  for (let write = 0; write < outputLength; write += WSOLA_HOP) {
    const nominal = Math.round(write / rate);
    let start = Math.min(nominal, limit);

    if (previous >= 0) {
      // Where the last frame would continue if the sound just kept going, and
      // the window around the nominal position where it may actually live.
      const template = previous + WSOLA_HOP;
      const from = Math.max(0, Math.min(nominal, limit) - WSOLA_SEARCH);
      const to = Math.min(limit, nominal + WSOLA_SEARCH);
      let best = -Infinity;
      for (let candidate = from; candidate <= to; candidate += 1) {
        let dot = 0;
        let energy = 0;
        for (let k = 0; k < overlap; k += 1) {
          const a = template + k;
          const b = candidate + k;
          dot += (a < input.length ? input[a] : 0) * input[b];
          energy += input[b] * input[b];
        }
        // Normalised, so a quieter candidate that matches the shape wins over
        // a loud one that merely matches the level.
        const score = dot / Math.sqrt(energy + 1e-9);
        if (score > best) {
          best = score;
          start = candidate;
        }
      }
    }

    for (let k = 0; k < FRAME; k += 1) {
      const index = write + k;
      if (index >= padded) break;
      output[index] += input[start + k] * window[k];
      normalization[index] += window[k];
    }

    previous = start;
  }

  for (let i = 0; i < padded; i += 1) {
    if (normalization[i] > 1e-6) output[i] /= normalization[i];
  }

  return output.slice(0, outputLength);
}

/**
 * Shift the spectral envelope (formants) and tilt the high end. The envelope is
 * smoothed, warped, and recombined with the original harmonic detail so the pitch
 * itself stays put.
 */
function shapeSpectrum(
  input: Float32Array,
  sampleRate: number,
  formant: number,
  brightness: number,
): Float32Array {
  if (Math.abs(formant) < 0.005 && Math.abs(brightness) < 0.005) return input.slice();

  const bins = FRAME / 2 + 1;
  const window = hann(FRAME);
  const outputLength = input.length + FRAME;
  const output = new Float32Array(outputLength);
  const normalization = new Float32Array(outputLength);

  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const magnitude = new Float32Array(bins);
  const envelope = new Float32Array(bins);
  const phase = new Float32Array(bins);
  const shaped = new Float32Array(bins);
  const warp = Math.pow(2, formant);

  for (let position = 0; position < input.length; position += HOP) {
    for (let i = 0; i < FRAME; i += 1) {
      const sample = position + i < input.length ? input[position + i] : 0;
      re[i] = sample * window[i];
      im[i] = 0;
    }

    fft(re, im, false);

    for (let k = 0; k < bins; k += 1) {
      magnitude[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // Smooth magnitude into a coarse spectral envelope.
    const radius = 8;
    for (let k = 0; k < bins; k += 1) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, k - radius); j <= Math.min(bins - 1, k + radius); j += 1) {
        sum += magnitude[j];
        count += 1;
      }
      envelope[k] = count > 0 ? sum / count : 0;
    }

    for (let k = 0; k < bins; k += 1) {
      const source = clamp(Math.round(k / warp), 0, bins - 1);
      const residual = magnitude[k] / (envelope[k] + 1e-9);
      const frequency = (k * sampleRate) / FRAME;
      const tilt =
        Math.abs(brightness) < 0.005
          ? 1
          : Math.pow(Math.max(frequency, 120) / 1000, brightness * 2);
      shaped[k] = envelope[source] * residual * tilt;

      re[k] = shaped[k] * Math.cos(phase[k]);
      im[k] = shaped[k] * Math.sin(phase[k]);
      if (k > 0 && k < FRAME / 2) {
        re[FRAME - k] = re[k];
        im[FRAME - k] = -im[k];
      }
    }

    fft(re, im, true);

    for (let i = 0; i < FRAME; i += 1) {
      const index = position + i;
      if (index >= outputLength) break;
      output[index] += re[i] * window[i];
      normalization[index] += window[i] * window[i];
    }
  }

  for (let i = 0; i < outputLength; i += 1) {
    if (normalization[i] > 1e-6) output[i] /= normalization[i];
  }

  return output.slice(0, input.length);
}

/** Pitch-shift by resampling a phase-vocoder stretch, so duration is preserved. */
export function shiftPitch(input: Float32Array, semitones: number): Float32Array {
  const amount = clamp(semitones, -24, 24);
  if (Math.abs(amount) < 0.05) return input.slice();
  const rate = Math.pow(2, amount / 12);
  const stretched = timeStretch(input, rate);
  return resample(stretched, 1 / rate);
}

/** Apply a Convert preset to a mono recording. */
export function transformVoice(
  input: Float32Array,
  sampleRate: number,
  shape: VoiceShape,
): Float32Array {
  const semitones = clamp(shape.semitones ?? 0, -14, 14);
  const formant = clamp(shape.formant ?? 0, -1, 1);
  const brightness = clamp(shape.brightness ?? 0, -1, 1);

  const pitched = shiftPitch(input, semitones);
  return shapeSpectrum(pitched, sampleRate, formant, brightness);
}

/** Decode any Chromium-supported audio file into mono float samples. */
export async function decodeToMono(
  blob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number; duration: number }> {
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(bytes);
    const samples = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < buffer.length; i += 1) {
        samples[i] += data[i] / buffer.numberOfChannels;
      }
    }
    return { samples, sampleRate: buffer.sampleRate, duration: buffer.duration };
  } finally {
    void context.close();
  }
}

/** Encode mono float samples as 16-bit PCM WAV bytes. Pure math, so the DSP
 * worker uses this directly and the window thread wraps it in a blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

/** Encode mono float samples as a 16-bit PCM WAV blob. */
export function wavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
}

export interface DecodedPcm {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Parse 16-bit PCM WAV bytes back into mono float samples. The takes in the
 * library are all written by `encodeWav`, but this walks the chunks instead
 * of assuming offsets, and mixes stereo down, so MP3 export does not depend
 * on the writer's exact layout.
 */
export function decodeWavPcm(bytes: ArrayBuffer): DecodedPcm {
  const fail = (reason: string): never => {
    throw new Error(`Cannot export this take as MP3 (${reason}).`);
  };
  if (bytes.byteLength < 44) fail('not a WAV file');
  const view = new DataView(bytes);
  const tag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') fail('not a WAV file');

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (format !== 1) fail('only PCM audio is supported');
  if (bits !== 16) fail('only 16-bit audio is supported');
  if (channels < 1 || channels > 2) fail('only mono and stereo audio are supported');
  if (dataLength <= 0) fail('no audio data found');

  const frames = Math.floor(dataLength / (channels * 2));
  if (frames <= 0) fail('no audio data found');
  const samples = new Float32Array(frames);
  let position = dataOffset;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(position, true) / 0x8000;
      position += 2;
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate };
}
