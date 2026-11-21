// Parametric equaliser for voice material.
//
// Bands are plain data (type, frequency, gain, Q) so the same style can be
// applied to a narration render, a voice-bank sample or an imported recording.
// The optional `level` stage adds gentle compression and a -1 dBFS peak
// normalisation, which is what actually "levels out" a voice between takes.
//
// Styles are deliberately separate from voices: a voice is who speaks, a style
// is how the take is finished. Any voice can be rendered through any style.

import { applyBiquad, compressSamples, makeBiquad, normalizePeak, type FilterType } from './dsp';

export interface EqBand {
  type: FilterType;
  /** Hz. */
  frequency: number;
  /** dB. Ignored by the pass filters. */
  gainDb: number;
  /** Width of peaking bands; 0.7 is a broad, musical setting. */
  q: number;
}

export interface EqStyle {
  id: string;
  label: string;
  description: string;
  bands: EqBand[];
  /** Whether the style also levels the output. */
  level: boolean;
}

export interface EqOptions {
  /** Compress + peak normalise after the bands. */
  compress?: boolean;
  /** Apply an output trim in dB, on top of any levelling. */
  outputGainDb?: number;
}

export const EQ_STYLES: EqStyle[] = [
  {
    id: 'flat',
    label: 'Flat',
    description: 'No shaping — the engine output as-is.',
    bands: [],
    level: false,
  },
  {
    id: 'voice-clarity',
    label: 'Clarity',
    description: 'Cuts rumble and mud, adds presence so consonants read clearly.',
    bands: [
      { type: 'highPass', frequency: 85, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 260, gainDb: -3, q: 1.1 },
      { type: 'peak', frequency: 3200, gainDb: 3, q: 1.0 },
      { type: 'highShelf', frequency: 7500, gainDb: -2, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'podcast',
    label: 'Podcast',
    description: 'Close-mic feel: tight lows, forward mids, controlled sibilance.',
    bands: [
      { type: 'highPass', frequency: 100, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 300, gainDb: -2.5, q: 1.0 },
      { type: 'peak', frequency: 2500, gainDb: 2.5, q: 1.1 },
      { type: 'peak', frequency: 6200, gainDb: -2, q: 2.0 },
      { type: 'highShelf', frequency: 9000, gainDb: -1.5, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'ad',
    label: 'Ad',
    description: 'Radio-spot punch: full bottom, scooped mud, bright and loud.',
    bands: [
      { type: 'highPass', frequency: 95, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 180, gainDb: 3, q: 1.1 },
      { type: 'peak', frequency: 450, gainDb: -2.5, q: 1.2 },
      { type: 'peak', frequency: 3000, gainDb: 3.5, q: 1.0 },
      { type: 'highShelf', frequency: 8000, gainDb: 2, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'warm-narration',
    label: 'Narration',
    description: 'Body in the low mids and a softer top — good for long reads.',
    bands: [
      { type: 'highPass', frequency: 70, gainDb: 0, q: 0.707 },
      { type: 'lowShelf', frequency: 190, gainDb: 2.5, q: 0.707 },
      { type: 'peak', frequency: 420, gainDb: -2, q: 1.2 },
      { type: 'highShelf', frequency: 7000, gainDb: -3, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'audiobook',
    label: 'Audiobook',
    description: 'Smooth and even for hours of listening: gentle body, soft top.',
    bands: [
      { type: 'highPass', frequency: 80, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 160, gainDb: 1.5, q: 0.9 },
      { type: 'peak', frequency: 380, gainDb: -2, q: 1.2 },
      { type: 'peak', frequency: 2800, gainDb: 1.5, q: 1.0 },
      { type: 'highShelf', frequency: 9000, gainDb: -1.5, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'news',
    label: 'News',
    description: 'Authoritative read: slim lows, strong intelligibility band.',
    bands: [
      { type: 'highPass', frequency: 110, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 320, gainDb: -3, q: 1.1 },
      { type: 'peak', frequency: 3200, gainDb: 4, q: 1.0 },
      { type: 'peak', frequency: 5000, gainDb: 1.5, q: 1.4 },
    ],
    level: true,
  },
  {
    id: 'radio',
    label: 'Radio',
    description: 'Broadcast chain: low cut, warm chest, forward presence.',
    bands: [
      { type: 'highPass', frequency: 90, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 200, gainDb: 2, q: 1.0 },
      { type: 'peak', frequency: 400, gainDb: -1.5, q: 1.2 },
      { type: 'peak', frequency: 3000, gainDb: 3, q: 1.0 },
      { type: 'peak', frequency: 6500, gainDb: 2, q: 1.6 },
    ],
    level: true,
  },
  {
    id: 'voiceover',
    label: 'Voiceover',
    description: 'Commercial VO: scooped mids, polished top, de-essed around 6.5 kHz.',
    bands: [
      { type: 'highPass', frequency: 95, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 280, gainDb: -2.5, q: 1.1 },
      { type: 'peak', frequency: 3500, gainDb: 3, q: 1.0 },
      { type: 'peak', frequency: 6500, gainDb: -2, q: 2.2 },
      { type: 'highShelf', frequency: 10000, gainDb: 1, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'trailer',
    label: 'Trailer',
    description: 'Cinematic weight and air — deep lows, wide top end.',
    bands: [
      { type: 'highPass', frequency: 55, gainDb: 0, q: 0.707 },
      { type: 'lowShelf', frequency: 120, gainDb: 5, q: 0.707 },
      { type: 'peak', frequency: 500, gainDb: -3, q: 1.2 },
      { type: 'peak', frequency: 2200, gainDb: 3, q: 1.0 },
      { type: 'highShelf', frequency: 6000, gainDb: 2, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'intimate',
    label: 'Intimate',
    description: 'Quiet, close delivery: soft top, warm breath, no bite.',
    bands: [
      { type: 'highPass', frequency: 70, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 220, gainDb: 1.5, q: 0.9 },
      { type: 'peak', frequency: 400, gainDb: -1, q: 1.2 },
      { type: 'peak', frequency: 2500, gainDb: 1.5, q: 1.0 },
      { type: 'highShelf', frequency: 8000, gainDb: -2.5, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'deep',
    label: 'Deep',
    description: 'Drops the voice lower: chest lift, recessed upper mids.',
    bands: [
      { type: 'highPass', frequency: 60, gainDb: 0, q: 0.707 },
      { type: 'lowShelf', frequency: 150, gainDb: 4, q: 0.707 },
      { type: 'peak', frequency: 400, gainDb: -2, q: 1.2 },
      { type: 'highShelf', frequency: 6000, gainDb: -2, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'crisp',
    label: 'Crisp',
    description: 'Detail without hiss: presence lift and a clean, open top.',
    bands: [
      { type: 'highPass', frequency: 85, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 1800, gainDb: 2, q: 1.2 },
      { type: 'peak', frequency: 4500, gainDb: 3, q: 1.0 },
      { type: 'highShelf', frequency: 9000, gainDb: 2, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'bright',
    label: 'Bright',
    description: 'Opens up the top end without adding hiss.',
    bands: [
      { type: 'highPass', frequency: 80, gainDb: 0, q: 0.707 },
      { type: 'highShelf', frequency: 5000, gainDb: 3, q: 0.707 },
      { type: 'peak', frequency: 220, gainDb: -1.5, q: 1.0 },
    ],
    level: false,
  },
  {
    id: 'de-harsh',
    label: 'De-harsh',
    description: 'Tames the brittle 5–8 kHz region synthetic voices tend to have.',
    bands: [
      { type: 'peak', frequency: 6800, gainDb: -4, q: 1.8 },
      { type: 'highShelf', frequency: 9500, gainDb: -2, q: 0.707 },
    ],
    level: true,
  },
  {
    id: 'telephone',
    label: 'Telephone',
    description: 'Band-limited phone call: no lows, no air, nasal midrange.',
    bands: [
      { type: 'highPass', frequency: 320, gainDb: 0, q: 0.9 },
      { type: 'lowPass', frequency: 3400, gainDb: 0, q: 0.9 },
      { type: 'peak', frequency: 1200, gainDb: 2, q: 1.2 },
    ],
    level: true,
  },
  {
    id: 'lo-fi',
    label: 'Lo-fi',
    description: 'Old tape and small speakers: narrow band, boxy mids.',
    bands: [
      { type: 'highPass', frequency: 200, gainDb: 0, q: 0.707 },
      { type: 'lowPass', frequency: 5000, gainDb: 0, q: 0.707 },
      { type: 'peak', frequency: 800, gainDb: 2, q: 1.2 },
    ],
    level: true,
  },
];

// ---------------------------------------------------------------------------
// Custom styles
//
// Bands edited by hand in the Shape view are saved here, under a `custom:` id,
// so they survive switching style and leaving the view. They live in
// localStorage next to the other settings and resolve through the same
// `styleById`, which is why every voice picker and the Studio can use them
// without knowing they are custom.

const CUSTOM_KEY = 'chatterbox.eqStyles';
const CUSTOM_PREFIX = 'custom:';

const BAND_TYPES: FilterType[] = ['peak', 'lowShelf', 'highShelf', 'highPass', 'lowPass'];

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function sanitiseBand(band: EqBand): EqBand {
  const finite = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  return {
    type: BAND_TYPES.includes(band?.type) ? band.type : 'peak',
    frequency: clamp(finite(band?.frequency, 1000), 20, 20000),
    gainDb: clamp(finite(band?.gainDb, 0), -24, 24),
    q: clamp(finite(band?.q, 1), 0.1, 10),
  };
}

function isCustomStyle(value: unknown): value is EqStyle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EqStyle>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.startsWith(CUSTOM_PREFIX) &&
    typeof candidate.label === 'string' &&
    candidate.label.trim().length > 0 &&
    Array.isArray(candidate.bands) &&
    typeof candidate.level === 'boolean'
  );
}

/** Every stored custom style, oldest first. Invalid entries are dropped. */
export function listCustomStyles(): EqStyle[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomStyle).map((style) => ({
      ...style,
      description: typeof style.description === 'string' ? style.description : 'Your own bands.',
      bands: style.bands.map(sanitiseBand),
    }));
  } catch {
    return [];
  }
}

function writeCustomStyles(styles: EqStyle[]): void {
  try {
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(styles));
  } catch {
    // Storage unavailable; the style stays in the caller's state only.
  }
}

/** Built-in styles first, then anything the user saved. */
export function allStyles(): EqStyle[] {
  return [...EQ_STYLES, ...listCustomStyles()];
}

/** Persist the current bands as a new style and return it. */
export function saveCustomStyle(input: {
  label: string;
  bands: EqBand[];
  level: boolean;
}): EqStyle {
  const style: EqStyle = {
    id: `${CUSTOM_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: input.label.trim() || 'Custom style',
    description: 'Saved in the Shape view.',
    bands: input.bands.map(sanitiseBand),
    level: input.level,
  };

  writeCustomStyles([...listCustomStyles(), style]);
  return style;
}

export function deleteCustomStyle(id: string): void {
  writeCustomStyles(listCustomStyles().filter((style) => style.id !== id));
}

/**
 * Put a deleted style back exactly as it was, keeping its id, so anything that
 * names it — a saved voice, a Studio project — resolves again.
 */
export function restoreCustomStyle(style: EqStyle): void {
  writeCustomStyles([...listCustomStyles().filter((saved) => saved.id !== style.id), style]);
}

export function isCustomStyleId(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** Whether two band lists produce the same filter chain. */
export function sameBands(a: EqBand[], b: EqBand[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((band, index) => {
    const other = b[index];
    return (
      band.type === other.type &&
      Math.abs(band.frequency - other.frequency) < 0.01 &&
      Math.abs(band.gainDb - other.gainDb) < 0.01 &&
      Math.abs(band.q - other.q) < 0.001
    );
  });
}

/** Resolve a built-in or custom style; falls back to Flat. */
export function styleById(id: string): EqStyle {
  return (
    EQ_STYLES.find((style) => style.id === id) ??
    listCustomStyles().find((style) => style.id === id) ??
    EQ_STYLES[0]
  );
}

export interface EqPoint {
  hz: number;
  db: number;
}

/**
 * Magnitude response of the band chain in dB, sampled on a log frequency axis.
 * This is what the graph draws: every biquad is evaluated at e^-jω and their
 * responses multiply, exactly as they cascade in `applyEq`.
 */
export function eqResponse(bands: EqBand[], points = 240, sampleRate = 48_000): EqPoint[] {
  const filters = bands
    .filter((band) => band.type !== 'peak' || Math.abs(band.gainDb) >= 0.05)
    .map((band) => makeBiquad(band.type, sampleRate, band.frequency, band.gainDb, band.q));

  const curve: EqPoint[] = [];
  for (let index = 0; index < points; index += 1) {
    const hz = 20 * Math.pow(1000, index / (points - 1));
    const omega = (2 * Math.PI * hz) / sampleRate;
    const cos1 = Math.cos(omega);
    const sin1 = -Math.sin(omega);
    const cos2 = Math.cos(2 * omega);
    const sin2 = -Math.sin(2 * omega);

    let real = 1;
    let imaginary = 0;
    for (const filter of filters) {
      const numeratorReal = filter.b0 + filter.b1 * cos1 + filter.b2 * cos2;
      const numeratorImaginary = filter.b1 * sin1 + filter.b2 * sin2;
      const denominatorReal = 1 + filter.a1 * cos1 + filter.a2 * cos2;
      const denominatorImaginary = filter.a1 * sin1 + filter.a2 * sin2;
      const denominator = denominatorReal * denominatorReal + denominatorImaginary * denominatorImaginary || 1e-12;

      // (numerator / denominator), then multiply into the running response.
      const stageReal =
        (numeratorReal * denominatorReal + numeratorImaginary * denominatorImaginary) / denominator;
      const stageImaginary =
        (numeratorImaginary * denominatorReal - numeratorReal * denominatorImaginary) / denominator;
      const nextReal = real * stageReal - imaginary * stageImaginary;
      imaginary = real * stageImaginary + imaginary * stageReal;
      real = nextReal;
    }

    curve.push({ hz, db: 20 * Math.log10(Math.hypot(real, imaginary) || 1e-6) });
  }

  return curve;
}

/** Run the bands in order, then optional levelling and trim. Never mutates input. */
export function applyEq(
  input: Float32Array,
  sampleRate: number,
  bands: EqBand[],
  options: EqOptions = {},
): Float32Array {
  const output = input.slice();

  for (const band of bands) {
    if (band.type === 'peak' && Math.abs(band.gainDb) < 0.01) continue;
    applyBiquad(output, makeBiquad(band.type, sampleRate, band.frequency, band.gainDb, band.q));
  }

  if (options.compress) {
    compressSamples(output, sampleRate, { thresholdDb: -20, ratio: 2.4, attackMs: 12, releaseMs: 150 });
  }

  if (options.outputGainDb) {
    const gain = Math.pow(10, options.outputGainDb / 20);
    for (let i = 0; i < output.length; i += 1) output[i] *= gain;
  }

  if (options.compress) normalizePeak(output, -1);

  return output;
}

/** Convenience: apply a named style. */
export function applyStyle(
  input: Float32Array,
  sampleRate: number,
  style: EqStyle,
  options: Omit<EqOptions, 'compress'> = {},
): Float32Array {
  return applyEq(input, sampleRate, style.bands, { ...options, compress: style.level });
}
