// Tests for the EQ response curve, the filter chain, and style resolution.
// Nothing here touches audio hardware: curves are evaluated from the biquad
// coefficients and signals are small synthetic buffers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allStyles,
  applyEq,
  deleteCustomStyle,
  eqResponse,
  EQ_STYLES,
  listCustomStyles,
  sameBands,
  saveCustomStyle,
  styleById,
  type EqBand,
  type EqPoint,
} from './eq';

const RATE = 48_000;

function nearest(curve: EqPoint[], hz: number): EqPoint {
  let best = curve[0];
  for (const point of curve) {
    if (Math.abs(Math.log(point.hz / hz)) < Math.abs(Math.log(best.hz / hz))) best = point;
  }
  return best;
}

function peakBand(frequency: number, gainDb: number, q = 1): EqBand {
  return { type: 'peak', frequency, gainDb, q };
}

describe('eqResponse', () => {
  it('is flat at 0 dB with no bands', () => {
    for (const point of eqResponse([], 32)) {
      expect(point.db).toBeCloseTo(0, 9);
    }
  });

  it('honours the point count and log axis', () => {
    const curve = eqResponse([], 17);
    expect(curve).toHaveLength(17);
    expect(curve[0].hz).toBeCloseTo(20, 6);
    expect(curve[16].hz).toBeCloseTo(20_000, 3);
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i].hz).toBeGreaterThan(curve[i - 1].hz);
    }
  });

  it('shows a +6 dB peak at its centre and little elsewhere', () => {
    const curve = eqResponse([peakBand(1000, 6)], 240, RATE);
    expect(nearest(curve, 1000).db).toBeGreaterThan(4.5);
    expect(nearest(curve, 1000).db).toBeLessThan(6.5);
    expect(Math.abs(nearest(curve, 60).db)).toBeLessThan(1);
    expect(Math.abs(nearest(curve, 15_000).db)).toBeLessThan(1);
  });

  it('ignores a negligible peak band, like the filter chain does', () => {
    const flat = eqResponse([], 64);
    const tiny = eqResponse([peakBand(1000, 0.01)], 64);
    for (let i = 0; i < flat.length; i += 1) {
      expect(tiny[i].db).toBeCloseTo(flat[i].db, 9);
    }
  });

  it('rolls lows off below a high-pass corner', () => {
    const curve = eqResponse([{ type: 'highPass', frequency: 300, gainDb: 0, q: 0.707 }], 240, RATE);
    expect(nearest(curve, 50).db).toBeLessThan(-12);
    expect(Math.abs(nearest(curve, 5000).db)).toBeLessThan(0.5);
  });

  it('shows the telephone style as band-limited around 1 kHz', () => {
    const curve = eqResponse(styleById('telephone').bands, 240, RATE);
    const mid = nearest(curve, 1000).db;
    expect(nearest(curve, 100).db).toBeLessThan(mid - 10);
    expect(nearest(curve, 15_000).db).toBeLessThan(mid - 10);
  });
});

describe('applyEq', () => {
  function sine(seconds: number, hz = 440): Float32Array {
    const samples = new Float32Array(Math.floor(RATE * seconds));
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE);
    }
    return samples;
  }

  function peakOf(samples: Float32Array): number {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return peak;
  }

  it('never mutates the input', () => {
    const input = sine(0.1);
    const snapshot = input.slice();
    applyEq(input, RATE, [peakBand(1000, 6)]);
    expect(input).toEqual(snapshot);
  });

  it('passes an empty chain through unchanged', () => {
    const input = sine(0.1);
    expect(applyEq(input, RATE, [])).toEqual(input);
  });

  it('applies the output trim as a plain gain', () => {
    const input = sine(0.2);
    const boosted = applyEq(input, RATE, [], { outputGainDb: 6.0206 });
    expect(peakOf(boosted) / peakOf(input)).toBeCloseTo(2, 2);
  });

  it('a boost band audibly changes the signal', () => {
    const input = sine(0.2, 1000);
    const output = applyEq(input, RATE, [peakBand(1000, 6)]);
    expect(peakOf(output)).toBeGreaterThan(peakOf(input) * 1.5);
  });
});

describe('sameBands', () => {
  const bands: EqBand[] = [peakBand(1000, 3, 1)];

  it('matches identical chains and tolerates float dust', () => {
    expect(sameBands(bands, [{ type: 'peak', frequency: 1000.005, gainDb: 3.005, q: 1 }])).toBe(true);
  });

  it('rejects different lengths, types and clear value changes', () => {
    expect(sameBands(bands, [])).toBe(false);
    expect(sameBands(bands, [{ type: 'lowShelf', frequency: 1000, gainDb: 3, q: 1 }])).toBe(false);
    expect(sameBands(bands, [peakBand(1020, 3, 1)])).toBe(false);
  });
});

describe('style resolution', () => {
  it('falls back to Flat for unknown ids', () => {
    expect(styleById('no-such-style').id).toBe('flat');
    expect(styleById('telephone').bands).toHaveLength(3);
  });

  it('every built-in style resolves to itself', () => {
    for (const style of EQ_STYLES) {
      expect(styleById(style.id)).toBe(style);
    }
  });
});

describe('custom styles', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts empty and survives corrupt storage', () => {
    expect(listCustomStyles()).toEqual([]);
    store.set('chatterbox.eqStyles', 'not json{');
    expect(listCustomStyles()).toEqual([]);
    store.set('chatterbox.eqStyles', '{"id":"custom:x"}');
    expect(listCustomStyles()).toEqual([]);
  });

  it('saves, sanitises and resolves a custom style', () => {
    const saved = saveCustomStyle({
      label: '  My style  ',
      bands: [
        { type: 'peak', frequency: 1000, gainDb: 3, q: 1 },
        // Out-of-range values are clamped, unknown types become peaks.
        { type: 'nope' as EqBand['type'], frequency: 5, gainDb: 100, q: 99 },
      ],
      level: true,
    });
    expect(saved.label).toBe('My style');
    expect(saved.bands[1]).toEqual({ type: 'peak', frequency: 20, gainDb: 24, q: 10 });

    expect(listCustomStyles()).toHaveLength(1);
    expect(styleById(saved.id).label).toBe('My style');
    expect(allStyles()).toHaveLength(EQ_STYLES.length + 1);
  });

  it('blanks get a default label and deletes remove the style', () => {
    const saved = saveCustomStyle({ label: '   ', bands: [], level: false });
    expect(saved.label).toBe('Custom style');
    deleteCustomStyle(saved.id);
    expect(listCustomStyles()).toEqual([]);
    expect(styleById(saved.id).id).toBe('flat');
  });
});
