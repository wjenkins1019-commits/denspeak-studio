// Acoustic analysis of a voice sample.
//
// Measures the things a listener hears as "that person": where the pitch sits
// and how far it moves, how bright the tone is, roughly where the formants are,
// how fast they talk and how clean the signal is. The measurements then produce
// a `recipe` — semitones, formant and brightness offsets — that the Convert
// engine can apply to any built-in voice, which is the offline way to
// approximate that speaker without the cloning model.

const PITCH_POLLOW_HZ = 55;
const PITCH_POLLHIGH_HZ = 400;
const PITCH_RATE = 8000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Average blocks of samples into a lower sample rate (cheap anti-aliasing). */
function decimate(samples: Float32Array, sampleRate: number, targetRate: number): Float32Array {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return samples;
  const size = Math.floor(samples.length / factor);
  const output = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    let sum = 0;
    for (let j = 0; j < factor; j += 1) sum += samples[i * factor + j];
    output[i] = sum / factor;
  }
  return output;
}

/**
 * Pitch of one frame by harmonic product spectrum.
 *
 * Autocorrelation is ambiguous at every multiple of the period, which reports
 * an octave (sometimes two) too low on high voices and on pitch-shifted audio.
 * Multiplying downsampled copies of the spectrum only lines up at the true
 * fundamental, so the octave errors disappear.
 */
function hpsPitch(
  samples: Float32Array,
  start: number,
  size: number,
  sampleRate: number,
): number {
  if (start + size > samples.length) return 0;

  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    re[i] = samples[start + i] * window;
  }
  fft(re, im);

  const bins = size / 2;
  const magnitude = new Float32Array(bins);
  let floor = 1e-9;
  for (let bin = 0; bin < bins; bin += 1) {
    const value = Math.hypot(re[bin], im[bin]);
    magnitude[bin] = value;
    if (value > floor) floor = Math.max(floor, value * 0.001);
  }

  const binHz = sampleRate / size;
  const lowBin = Math.max(1, Math.floor(PITCH_POLLOW_HZ / binHz));
  const highBin = Math.min(bins - 1, Math.ceil(1000 / binHz));

  let bestHz = 0;
  let bestScore = -Infinity;

  for (let bin = lowBin; bin <= highBin; bin += 1) {
    let score = 0;
    let used = 0;
    for (let harmonic = 1; harmonic <= 5; harmonic += 1) {
      const index = Math.round(bin * harmonic);
      // High candidates run out of harmonics before the fifth; stop rather than
      // discarding the fundamental entirely.
      if (index <= 0 || index >= bins) break;
      score += Math.log(Math.max(floor, magnitude[index]));
      used += 1;
    }
    if (used < 2) continue;

    // Compare the geometric mean, so a candidate with fewer usable harmonics is
    // not penalised by the extra negative terms.
    const mean = score / used;
    if (mean > bestScore) {
      bestScore = mean;
      bestHz = bin * binHz;
    }
  }

  return bestHz;
}

/** Normalised autocorrelation at a given lag — how periodic the frame is. */
function clarityAt(frame: Float32Array, lag: number): number {
  if (lag < 1 || lag >= frame.length) return 0;
  let sum = 0;
  let first = 0;
  let second = 0;
  for (let i = 0; i + lag < frame.length; i += 1) {
    sum += frame[i] * frame[i + lag];
    first += frame[i] * frame[i];
    second += frame[i + lag] * frame[i + lag];
  }
  if (first <= 0 || second <= 0) return 0;
  return clamp01(sum / Math.sqrt(first * second));
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))];
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
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
    const angle = (-2 * Math.PI) / length;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += length) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < length / 2; j += 1) {
        const a = i + j;
        const b = a + length / 2;
        const evenRe = re[a];
        const evenIm = im[a];
        const oddRe = re[b] * curRe - im[b] * curIm;
        const oddIm = re[b] * curIm + im[b] * curRe;
        re[a] = evenRe + oddRe;
        im[a] = evenIm + oddIm;
        re[b] = evenRe - oddRe;
        im[b] = evenIm - oddIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Average magnitude spectrum, used for brightness and formant estimates. */
function averageSpectrum(samples: Float32Array, sampleRate: number): Float32Array {
  const size = 1024;
  const hop = 512;
  const bins = size / 2;
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);

  const spectrum = new Float32Array(bins);
  let frames = 0;

  for (let start = 0; start + size <= samples.length; start += hop) {
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    let energy = 0;
    for (let i = 0; i < size; i += 1) {
      const value = samples[start + i] * window[i];
      re[i] = value;
      energy += value * value;
    }
    if (energy < 1e-6) continue;

    fft(re, im);
    for (let bin = 0; bin < bins; bin += 1) {
      spectrum[bin] += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
    }
    frames += 1;
  }

  if (frames === 0) return spectrum;
  for (let bin = 0; bin < bins; bin += 1) spectrum[bin] /= frames;
  return spectrum;
}

function spectralCentroid(spectrum: Float32Array, sampleRate: number): number {
  const binHz = sampleRate / (spectrum.length * 2);
  let weighted = 0;
  let total = 0;
  const low = Math.floor(80 / binHz);
  const high = Math.min(spectrum.length - 1, Math.floor(8000 / binHz));
  for (let bin = low; bin <= high; bin += 1) {
    weighted += bin * binHz * spectrum[bin];
    total += spectrum[bin];
  }
  return total > 0 ? weighted / total : 0;
}

/** Smoothed local maxima of the spectrum inside a band — rough formant finder. */
function formantIn(spectrum: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
  const binHz = sampleRate / (spectrum.length * 2);
  const smoothWidth = Math.max(1, Math.round(150 / binHz));

  let bestBin = -1;
  let bestValue = 0;
  const low = Math.floor(lowHz / binHz);
  const high = Math.min(spectrum.length - 2, Math.floor(highHz / binHz));

  for (let bin = low; bin <= high; bin += 1) {
    let sum = 0;
    let count = 0;
    for (let k = -smoothWidth; k <= smoothWidth; k += 1) {
      const index = bin + k;
      if (index < 0 || index >= spectrum.length) continue;
      sum += spectrum[index];
      count += 1;
    }
    const value = sum / Math.max(1, count);
    if (value > bestValue) {
      bestValue = value;
      bestBin = bin;
    }
  }

  return bestBin >= 0 ? bestBin * binHz : 0;
}

export interface VoiceMetrics {
  seconds: number;
  /** Median fundamental frequency of voiced frames, Hz. */
  pitchHz: number;
  pitchLowHz: number;
  pitchHighHz: number;
  /** Distance between the 10th and 90th pitch percentile, semitones. */
  rangeSemitones: number;
  /** 0..1 — 1 means a very level delivery. */
  steadiness: number;
  /** Rough harmonics-to-noise ratio, dB. */
  hnrDb: number;
  /** Spectral centroid, Hz — perceived brightness. */
  brightnessHz: number;
  formant1Hz: number;
  formant2Hz: number;
  /** Envelope peaks per second of voiced speech. */
  syllableRate: number;
  loudnessDb: number;
  /** Plain-language register/description. */
  register: string;
  /** Offsets the Convert engine can apply to another voice. */
  recipe: { semitones: number; formant: number; brightness: number };
  notes: string[];
}

export function describePitch(pitchHz: number): string {
  if (pitchHz <= 0) return 'no clear pitch';
  if (pitchHz < 95) return 'very low register';
  if (pitchHz < 125) return 'low register';
  if (pitchHz < 160) return 'mid-low register';
  if (pitchHz < 200) return 'mid register';
  if (pitchHz < 250) return 'mid-high register';
  return 'high register';
}

/** Syllables per second from the amplitude envelope's dominant period. */
function envelopeRate(envelope: number[], frameRate: number): number {
  if (envelope.length < 8) return 0;

  // Measure only between the first and last speech, so leading and trailing
  // silence do not drag the rate down.
  const peakLevel = Math.max(...envelope);
  const gate = peakLevel * 0.1;
  let start = 0;
  while (start < envelope.length && envelope[start] < gate) start += 1;
  let end = envelope.length;
  while (end > start && envelope[end - 1] < gate) end -= 1;
  const trimmed = envelope.slice(start, end);
  if (trimmed.length < 8) return 0;

  const mean = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  const centred = trimmed.map((value) => value - mean);
  const minLag = Math.max(2, Math.round(frameRate * 0.1));
  const maxLag = Math.min(centred.length - 2, Math.round(frameRate * 0.6));
  if (maxLag <= minLag) return 0;

  const scores: number[] = [];
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < centred.length - lag; i += 1) sum += centred[i] * centred[i + lag];
    scores[lag] = sum;
    if (sum > best) best = sum;
  }
  if (best <= 0) return 0;

  // Shortest lag that is nearly as strong, so a 2x period is not mistaken for
  // the syllable rate.
  let chosen = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (scores[lag] >= best * 0.8 && scores[lag] >= (scores[lag - 1] ?? 0)) {
      chosen = lag;
      break;
    }
  }
  if (chosen === 0) return 0;

  return clamp(frameRate / chosen, 0, 12);
}

/** Measure a voice sample. Pass mono samples at `sampleRate`. */
export function analyseVoice(samples: Float32Array, sampleRate: number): VoiceMetrics {
  const seconds = samples.length / sampleRate;
  const low = decimate(samples, sampleRate, PITCH_RATE);
  const frameSize = Math.max(64, Math.round(PITCH_RATE * 0.04));
  const hopSize = Math.max(32, Math.round(PITCH_RATE * 0.02));

  const pitches: number[] = [];
  const clarities: number[] = [];
  const envelope: number[] = [];

  for (let start = 0; start + frameSize <= low.length; start += hopSize) {
    const frame = low.subarray(start, start + frameSize);
    let energy = 0;
    for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
    envelope.push(Math.sqrt(energy / frame.length));
  }

  // Pitch needs a longer window than the envelope: 2048 samples at 8 kHz is
  // 256 ms, which resolves low male voices to a few Hz.
  const pitchSize = 2048;
  // A 95th-percentile reference rather than the absolute peak: one transient
  // (vocoder edge, plosive) would otherwise gate out every real frame.
  const loudest = percentile(envelope, 0.95);

  for (let start = 0; start + pitchSize <= low.length; start += frameSize) {
    let energy = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const value = low[start + i];
      energy += value * value;
    }
    if (Math.sqrt(energy / frameSize) < loudest * 0.12) continue;

    const hz = hpsPitch(low, start, pitchSize, PITCH_RATE);
    if (hz < PITCH_POLLOW_HZ) continue;

    const frame = low.subarray(start, start + pitchSize);
    const clarity = clarityAt(frame, Math.round(PITCH_RATE / hz));
    if (clarity < 0.1) continue;

    pitches.push(hz);
    clarities.push(clarity);
  }

  const spectrum = averageSpectrum(samples, sampleRate);
  const brightnessHz = spectralCentroid(spectrum, sampleRate);
  const formant1Hz = formantIn(spectrum, sampleRate, 300, 950);
  const formant2Hz = formantIn(spectrum, sampleRate, 950, 2600);

  const peak = envelope.length > 0 ? Math.max(...envelope) : 0;
  const active = envelope.filter((level) => level > peak * 0.08);
  const activeSeconds = (active.length * hopSize) / PITCH_RATE;
  const loudnessDb =
    active.length > 0
      ? 20 * Math.log10(active.reduce((sum, level) => sum + level, 0) / active.length + 1e-9)
      : -120;

  // The syllable period is the strongest repeat in the envelope: 100-600 ms
  // between syllable peaks. Autocorrelation is immune to the amplitude ripple
  // that makes threshold counting unreliable.
  const syllableRate = activeSeconds > 0.2 ? envelopeRate(envelope, PITCH_RATE / hopSize) : 0;

  // A handful of frames with a spurious correlation is not a voice.
  const voiced = pitches.length >= 8;
  const pitchHz = voiced ? percentile(pitches, 0.5) : 0;
  const pitchLowHz = voiced ? percentile(pitches, 0.1) : 0;
  const pitchHighHz = voiced ? percentile(pitches, 0.9) : 0;
  const rangeSemitones =
    pitchLowHz > 0 && pitchHighHz > 0 ? 12 * Math.log2(pitchHighHz / pitchLowHz) : 0;

  // 8 semitones of range counts as fully expressive, so this never contradicts
  // the range figure shown next to it.
  const steadiness = voiced ? clamp01(1 - rangeSemitones / 8) : 0;

  const meanClarity =
    clarities.length > 0 ? clarities.reduce((sum, value) => sum + value, 0) / clarities.length : 0;
  const hnrDb =
    meanClarity > 0.01
      ? clamp(10 * Math.log10(meanClarity / (1 - meanClarity)), 0, 40)
      : 0;

  const recipe = {
    semitones: pitchHz > 0 ? clamp(12 * Math.log2(pitchHz / 165), -9, 9) : 0,
    formant:
      formant1Hz > 0 && formant2Hz > 0
        ? clamp(
            ((Math.log2(formant1Hz / 500) + Math.log2(formant2Hz / 1500)) / 2) * 0.9,
            -1,
            1,
          )
        : 0,
    brightness: brightnessHz > 0 ? clamp(Math.log2(brightnessHz / 1800) / 1.2, -1, 1) : 0,
  };

  const notes: string[] = [];
  if (seconds < 3) notes.push('Short sample — these numbers are rough.');
  if (!voiced) notes.push('Almost no steady pitch found; is this speech?');
  if (hnrDb > 0 && hnrDb < 5) notes.push('Noisy or breathy; a matched voice will be approximate.');
  if (rangeSemitones > 6) notes.push('Wide, expressive pitch range.');
  if (rangeSemitones > 0 && rangeSemitones < 1.5) notes.push('Very level delivery.');
  if (syllableRate > 8) notes.push('Fast delivery.');
  if (syllableRate > 0 && syllableRate < 1.2) notes.push('Slow, deliberate delivery.');

  return {
    seconds,
    pitchHz,
    pitchLowHz,
    pitchHighHz,
    rangeSemitones,
    steadiness,
    hnrDb,
    brightnessHz,
    formant1Hz,
    formant2Hz,
    syllableRate,
    loudnessDb,
    register: describePitch(pitchHz),
    recipe,
    notes,
  };
}
