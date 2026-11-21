// Tests for caption cue building and SRT/VTT formatting.
import { describe, expect, it } from 'vitest';
import {
  applyBoundaries,
  formatSRT,
  formatTimestampSRT,
  formatTimestampVTT,
  formatVTT,
  offsetStoredCaptions,
  parseCues,
  normalizeWords,
  parseTimestamp,
  splitCaptionWords,
  wordBoundaryFractions,
  wordsToCues,
  type TimedWord,
} from './captions';
import {
  assembleSpeechWithSpans,
  masterSpeech,
  rescaleSpans,
} from './humanize';
import { timeStretch, transformVoice } from './audio';
import { applyEq } from './eq';
import {
  ACX_HEAD_TARGET_MS,
  ACX_TAIL_TARGET_MS,
  checkEnds,
  ensureAcxEnds,
  measureEnds,
} from './acx';
import { LOUDNESS_STANDARDS } from './loudness';

function words(text: string, start = 0, step = 0.4): TimedWord[] {
  let cursor = start;
  return text.split(' ').map((word) => {
    const entry = { word, start: cursor, end: cursor + step * 0.8 };
    cursor += step;
    return entry;
  });
}

describe('timestamp formatting', () => {
  it('shapes SRT with commas and VTT with dots', () => {
    expect(formatTimestampSRT(65.5)).toBe('00:01:05,500');
    expect(formatTimestampVTT(65.5)).toBe('00:01:05.500');
    expect(formatTimestampSRT(0)).toBe('00:00:00,000');
  });

  it('parses both comma and dot stamps', () => {
    expect(parseTimestamp('00:01:05,500')).toBe(65.5);
    expect(parseTimestamp('00:01:05.500')).toBe(65.5);
    expect(parseTimestamp('not a stamp')).toBeNull();
  });
});

describe('wordsToCues', () => {
  it('groups short reads into one cue', () => {
    const cues = wordsToCues(words('Hello world this is a test'));
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello world this is a test');
    expect(cues[0].start).toBe(0);
  });

  it('caps cue length and breaks at sentence ends', () => {
    const long =
      'This is a much longer read that keeps going past the cue limit. A second sentence follows along here.';
    const cues = wordsToCues(words(long));
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].text.endsWith('.')).toBe(true);
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(84);
  });

  it('breaks cues on long gaps', () => {
    const first = words('Hello world');
    const second = words('much later now', 5);
    const cues = wordsToCues([...first, ...second]);
    expect(cues).toHaveLength(2);
    expect(cues[1].start).toBeGreaterThanOrEqual(5);
  });

  it('returns no cues for no usable words', () => {
    expect(wordsToCues([])).toEqual([]);
  });
});

describe('normalizeWords', () => {
  it('drops null timestamps and keeps word order', () => {
    const raw = [
      { text: 'hello', timestamp: [0, 0.4] as [number, number] },
      { text: 'oops', timestamp: null },
      { text: 'world', timestamp: [0.5, 0.9] as [number, number] },
    ];
    expect(normalizeWords(raw)).toEqual([
      { word: 'hello', start: 0, end: 0.4 },
      { word: 'world', start: 0.5, end: 0.9 },
    ]);
  });

  it('spreads a sentence chunk across its tokens in order', () => {
    const out = normalizeWords([{ text: 'hello brave world', timestamp: [0, 1.5] }]);
    expect(out.map((entry) => entry.word)).toEqual(['hello', 'brave', 'world']);
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBe(1.5);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
      expect(out[i].end).toBeGreaterThanOrEqual(out[i].start);
    }
  });
});

describe('splitCaptionWords', () => {
  it('tokenizes like the transcription path and drops blanks', () => {
    expect(splitCaptionWords('  Hello   brave world\nnew line ')).toEqual([
      'Hello',
      'brave',
      'world',
      'new',
      'line',
    ]);
    expect(splitCaptionWords('   ')).toEqual([]);
  });
});

describe('wordBoundaryFractions', () => {
  const RATE = 22050;

  /** Two loud bursts with true silence between them. */
  function bursts(): Float32Array {
    const out = new Float32Array(Math.round(RATE * 1.5));
    const fill = (from: number, to: number) => {
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1) {
        out[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE);
      }
    };
    fill(0, 0.5);
    fill(1.0, 1.5);
    return out;
  }

  it('lands the cut in the silence between words', () => {
    const fractions = wordBoundaryFractions(['hello', 'world'], bursts(), RATE);
    expect(fractions).toHaveLength(3);
    expect(fractions[0]).toBe(0);
    expect(fractions[2]).toBe(1);
    // The silence runs from 0.5 s to 1.0 s of 1.5 s: fractions 1/3..2/3.
    expect(fractions[1]).toBeGreaterThan(0.34);
    expect(fractions[1]).toBeLessThan(0.66);
  });

  it('covers one word with the whole block and nothing with no words', () => {
    expect(wordBoundaryFractions(['hello'], bursts(), RATE)).toEqual([0, 1]);
    expect(wordBoundaryFractions([], bursts(), RATE)).toEqual([0]);
  });

  it('falls back to length-proportional cuts on silence', () => {
    const silent = new Float32Array(RATE);
    expect(wordBoundaryFractions(['a', 'bb'], silent, RATE)).toEqual([0, 1 / 3, 1]);
  });

  it('keeps cuts ordered and covering on dense audio', () => {
    const dense = new Float32Array(RATE);
    for (let i = 0; i < dense.length; i += 1) {
      dense[i] = 0.4 * Math.sin((2 * Math.PI * (110 + (i % 331)) * i) / RATE);
    }
    const fractions = wordBoundaryFractions(['one', 'two', 'three', 'four'], dense, RATE);
    expect(fractions).toHaveLength(5);
    expect(fractions[0]).toBe(0);
    expect(fractions[4]).toBe(1);
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
  });
});

describe('applyBoundaries', () => {
  it('maps fractions onto the span in order', () => {
    const out = applyBoundaries(['a', 'bb', 'c'], [0, 0.25, 0.75, 1], 10, 20);
    expect(out.map((entry) => entry.word)).toEqual(['a', 'bb', 'c']);
    expect(out[0].start).toBe(10);
    expect(out[2].end).toBe(20);
    expect(out[1].start).toBeCloseTo(12.5, 9);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
    }
  });

  it('returns nothing for no words or a backwards span', () => {
    expect(applyBoundaries([], [0], 0, 1)).toEqual([]);
    expect(applyBoundaries(['a'], [0, 1], 5, 5)).toEqual([]);
  });
});

describe('synthesis alignment accuracy', () => {
  const RATE = 22050;

  /**
   * Speech-like word with known boundaries: a harmonic buzz with vibrato and
   * an attack/decay envelope, so cuts have real dips to find. One word hides
   * a 30 ms stop gap inside it — the adversarial case, where the deepest dip
   * near a cut is mid-word rather than between words.
   */
  function synthWord(seconds: number, f0: number, seed: number, stopGap: boolean): Float32Array {
    const length = Math.max(1, Math.round(seconds * RATE));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const t = i / RATE;
      const wobble = 1 + 0.02 * Math.sin(2 * Math.PI * 5 * t + seed);
      let sample =
        Math.sin(2 * Math.PI * f0 * wobble * t) +
        0.5 * Math.sin(2 * Math.PI * f0 * 2 * wobble * t + 1) +
        0.25 * Math.sin(2 * Math.PI * f0 * 3 * wobble * t + 2);
      const attack = Math.min(1, i / (RATE * 0.02));
      const release = Math.min(1, (length - i) / (RATE * 0.03));
      sample *= 0.4 * Math.min(attack, release);
      if (stopGap) {
        const gapAt = Math.round(length * 0.6);
        if (i >= gapAt && i < gapAt + Math.round(RATE * 0.03)) sample = 0;
      }
      out[i] = sample;
    }
    return out;
  }

  function silence(seconds: number): Float32Array {
    return new Float32Array(Math.max(1, Math.round(seconds * RATE)));
  }

  function concat(parts: Float32Array[]): { samples: Float32Array; bounds: number[] } {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const samples = new Float32Array(total);
    const bounds = [0];
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
      bounds.push(offset);
    }
    return { samples, bounds };
  }

  /** Unequal words so length-proportional targets land off the real gaps. */
  function fixture(): { words: string[]; block: Float32Array; truth: number[] } {
    const specs: Array<[string, number, number, boolean]> = [
      ['a', 0.12, 180, false],
      ['journey', 0.5, 140, true],
      ['of', 0.14, 200, false],
      ['thousand', 0.55, 120, false],
      ['miles', 0.4, 160, true],
    ];
    const gaps = [0.1, 0.25, 0.08, 0.3];
    const parts: Float32Array[] = [];
    const bounds: number[] = [0];
    const words: string[] = [];
    let offset = 0;
    specs.forEach(([text, seconds, f0, stopGap], index) => {
      const word = synthWord(seconds, f0, index + 1, stopGap);
      parts.push(word);
      offset += word.length;
      bounds.push(offset);
      words.push(text);
      if (index < gaps.length) {
        const gap = silence(gaps[index]);
        parts.push(gap);
        offset += gap.length;
      }
    });
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const block = new Float32Array(total);
    let at = 0;
    for (const part of parts) {
      block.set(part, at);
      at += part.length;
    }
    // Truth: internal word boundaries only, in seconds.
    return { words, block, truth: bounds.slice(1, -1).map((sample) => sample / RATE) };
  }

  function boundaryErrors(
    words: string[],
    samples: Float32Array,
    spanStart: number,
    spanEnd: number,
    truth: number[],
  ): number[] {
    const fractions = wordBoundaryFractions(words, samples, RATE);
    const timed = applyBoundaries(words, fractions, spanStart, spanEnd);
    // Internal boundaries: word i ends where word i+1 begins.
    return timed.slice(1).map((entry, i) => Math.abs(entry.start - truth[i]));
  }

  it('lands cuts near the true gaps on clean audio', () => {
    const { words, block, truth } = fixture();
    const errors = boundaryErrors(words, block, 0, block.length / RATE, truth);
    const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
    const max = Math.max(...errors);
    // eslint-disable-next-line no-console
    console.log(`clean-block boundary error: mean ${(mean * 1000).toFixed(1)} ms, max ${(max * 1000).toFixed(1)} ms`);
    expect(mean).toBeLessThan(0.1);
    expect(max).toBeLessThan(0.3);
  });

  it('holds up through the real finishing tail', () => {
    const first = fixture();
    const second = fixture();
    const blocks = [first.block, second.block];
    const pausesMs = [300, 0];
    const { audio: assembled, spans: assembledSpans } = assembleSpeechWithSpans(blocks, pausesMs, RATE, {
      strength: 0.75,
    });
    const beforeShape = masterSpeech(assembled, RATE, { strength: 0.75 });
    const pitched = transformVoice(beforeShape, RATE, { semitones: 0, formant: 0, brightness: 0 });
    const shaped = applyEq(
      pitched,
      RATE,
      [{ type: 'peak', frequency: 2600, gainDb: 1.6, q: 0.9 }],
      { compress: true },
    );
    let spans = rescaleSpans(assembledSpans, beforeShape.length, shaped.length);
    const preSpeed = shaped.length;
    const finished = timeStretch(shaped, 1 / 1.05, RATE);
    spans = rescaleSpans(spans, preSpeed, finished.length);

    const errors: number[] = [];
    [first, second].forEach((part, index) => {
      const span = spans[index];
      const scale = (span.end - span.start) / part.block.length;
      const truth = part.truth.map((t) => span.start / RATE + t * scale);
      errors.push(
        ...boundaryErrors(part.words, part.block, span.start / RATE, span.end / RATE, truth),
      );
    });
    const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
    const max = Math.max(...errors);
    // eslint-disable-next-line no-console
    console.log(`full-tail boundary error: mean ${(mean * 1000).toFixed(1)} ms, max ${(max * 1000).toFixed(1)} ms`);
    expect(mean).toBeLessThan(0.1);
    expect(max).toBeLessThan(0.3);
  });
});

describe('parseCues', () => {
  it('round-trips SRT back to cues', () => {
    const cues = [
      { start: 0, end: 1.2, text: 'Hello world' },
      { start: 1.5, end: 2.75, text: 'second line' },
    ];
    expect(parseCues(formatSRT(cues))).toEqual(cues);
  });

  it('reads VTT with a header and cue identifiers', () => {
    const cues = [
      { start: 65.5, end: 67.25, text: 'Hello world' },
      { start: 68, end: 70, text: 'line two\nline three' },
    ];
    expect(parseCues(formatVTT(cues))).toEqual(cues);
  });

  it('drops malformed blocks instead of the whole file', () => {
    const parsed = parseCues(
      '1\n00:00:00,000 --> 00:00:01,000\nKeep me\n\nno stamps here\n\n2\n00:00:02,000 --> 00:00:01,000\nBackwards\n',
    );
    expect(parsed).toEqual([{ start: 0, end: 1, text: 'Keep me' }]);
  });
});

describe('speaker-labeled cues', () => {
  it('never mixes voices in one cue', () => {
    const cues = wordsToCues([
      { word: 'Hello', start: 0, end: 0.4, speaker: 'Leah' },
      { word: 'there', start: 0.4, end: 0.8, speaker: 'Leah' },
      { word: 'Hi', start: 0.9, end: 1.2, speaker: 'Ryan' },
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ speaker: 'Leah', text: 'Hello there' });
    expect(cues[1]).toMatchObject({ speaker: 'Ryan', text: 'Hi' });
  });

  it('labels SRT with a Name: prefix and VTT with a voice tag', () => {
    const cues = [{ start: 0, end: 1, text: 'Hello', speaker: 'Leah' }];
    expect(formatSRT(cues)).toBe('1\n00:00:00,000 --> 00:00:01,000\nLeah: Hello\n');
    expect(formatVTT(cues)).toContain('<v Leah>Hello</v>');
  });

  it('round-trips speakers through both formats', () => {
    const cues = [
      { start: 0, end: 1, text: 'Hello', speaker: 'Leah' },
      { start: 1.5, end: 2.5, text: 'Hi back' },
    ];
    expect(parseCues(formatSRT(cues))).toEqual(cues);
    expect(parseCues(formatVTT(cues))).toEqual(cues);
  });

  it('leaves untagged cues exactly as before', () => {
    const cues = [{ start: 0, end: 1.2, text: 'Hello world' }];
    expect(parseCues(formatSRT(cues))).toEqual(cues);
    expect(formatSRT(cues)).toBe('1\n00:00:00,000 --> 00:00:01,200\nHello world\n');
  });
});

describe('offsetStoredCaptions', () => {
  it('shifts both formats by the head delta', () => {
    const cues = [
      { start: 0.1, end: 1.2, text: 'Hello world' },
      { start: 1.5, end: 2.5, text: 'Hi back', speaker: 'Leah' },
    ];
    const shifted = offsetStoredCaptions({ srt: formatSRT(cues), vtt: formatVTT(cues) }, 0.7);
    expect(parseCues(shifted.srt)).toEqual([
      { start: 0.8, end: 1.9, text: 'Hello world' },
      { start: 2.2, end: 3.2, text: 'Hi back', speaker: 'Leah' },
    ]);
    expect(parseCues(shifted.vtt)).toEqual(parseCues(shifted.srt));
  });

  it('clamps at zero and leaves tiny deltas alone', () => {
    const cues = [{ start: 0.1, end: 1.2, text: 'Hello world' }];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const clamped = offsetStoredCaptions(stored, -0.5);
    expect(parseCues(clamped.srt)[0]).toMatchObject({ start: 0, end: 0.7 });
    expect(offsetStoredCaptions(stored, 0.0005)).toBe(stored);
  });

  it('never drops a cue and keeps SRT equal to VTT across random lists and deltas', () => {
    // Deterministic PRNG (mulberry32): the same 60 cue lists every run, no flakes.
    let seed = 0xc0ffee;
    const rand = (): number => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const roundMs = (value: number): number => Math.round(value * 1000) / 1000;
    const WORDS = [
      'hello', 'world', 'second', 'line', 'caption', 'proof', 'dawn', 'fox',
      'quick', 'brown', 'journey', 'miles', 'audio', 'take', 'voice', 'still',
      'here', 'morning', 'chapter', 'read',
    ];
    const SPEAKERS = [undefined, 'Leah', 'Ryan'] as const;
    const DELTAS = [-3, -1.75, -0.75, -0.2, -0.05, -0.0009, 0, 0.0005, 0.05, 0.3, 0.71, 1.5, 4];
    // Millisecond-exact values still carry binary float dust across different
    // arithmetic paths (1359/1000 vs 1 + 359/1000), so every comparison below
    // normalizes through roundMs first.
    const norm = <T extends { start: number; end: number }>(list: T[]): T[] =>
      list.map((cue) => ({ ...cue, start: roundMs(cue.start), end: roundMs(cue.end) }));
    for (let c = 0; c < 60; c += 1) {
      const count = 1 + Math.floor(rand() * 4);
      const cues: { start: number; end: number; text: string; speaker?: string }[] = [];
      let cursor = roundMs(rand() * 3);
      for (let i = 0; i < count; i += 1) {
        const duration = 0.2 + rand() * 1.8;
        const start = roundMs(cursor);
        const end = roundMs(cursor + duration);
        const words = 1 + Math.floor(rand() * 4);
        const text = Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
        const speaker = SPEAKERS[Math.floor(rand() * SPEAKERS.length)];
        cues.push({ start, end, text, ...(speaker ? { speaker } : {}) });
        cursor = roundMs(end + rand() * 1.2);
      }
      const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
      // The generator itself round-trips: failures below blame the shift, not the fixture.
      expect(norm(parseCues(stored.srt))).toEqual(norm(cues));
      for (const delta of DELTAS) {
        const shifted = offsetStoredCaptions(stored, delta);
        if (!(Math.abs(delta) > 0.001)) {
          expect(shifted).toBe(stored);
          continue;
        }
        const srt = parseCues(shifted.srt);
        const vtt = parseCues(shifted.vtt);
        expect(srt).toHaveLength(cues.length);
        expect(vtt).toEqual(srt);
        for (let i = 0; i < cues.length; i += 1) {
          const original = cues[i];
          const got = srt[i];
          expect(got.start).toBeGreaterThanOrEqual(0);
          expect(got.end).toBeGreaterThan(got.start);
          expect(got.text).toBe(original.text);
          expect(got.speaker).toBe(original.speaker);
          if (original.end + delta <= 0) {
            expect(got.start).toBe(0);
            expect(roundMs(got.end)).toBe(roundMs(original.end - original.start));
          } else {
            expect(roundMs(got.start)).toBe(roundMs(Math.max(0, original.start + delta)));
            expect(roundMs(got.end)).toBe(roundMs(Math.max(0, original.end + delta)));
          }
        }
        for (let i = 1; i < srt.length; i += 1) {
          expect(srt[i].start).toBeGreaterThanOrEqual(srt[i - 1].start);
        }
      }
    }
  });

  it('pins a fully-shifted-out cue at the head instead of dropping it', () => {
    // A trim bigger than the cue would collapse [0.1, 0.5] to [0, 0], which
    // parseCues drops (end must exceed start) — silently losing text. Pin it
    // at zero with its duration preserved so it stays visible and editable.
    const cues = [
      { start: 0.1, end: 0.5, text: 'Hello world' },
      { start: 2.0, end: 2.6, text: 'Still here', speaker: 'Leah' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const shifted = offsetStoredCaptions(stored, -0.75);
    for (const text of [shifted.srt, shifted.vtt]) {
      const parsed = parseCues(text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ start: 0, end: 0.4, text: 'Hello world' });
      expect(parsed[1]).toMatchObject({
        start: 1.25,
        end: 1.85,
        text: 'Still here',
        speaker: 'Leah',
      });
    }
    expect(parseCues(shifted.vtt)).toEqual(parseCues(shifted.srt));
  });
});

describe('caption timing across the ACX head rebuild', () => {
  const RATE = 22050;
  const roundMs = (value: number): number => Math.round(value * 1000) / 1000;
  // Same ms-rounding clamp the caption editor uses on save.
  const clampTime = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.round(value * 1000) / 1000) : 0;

  /** Voiced core with digital-silent edges, like a fresh render or an unmatched take. */
  function edgedTake(headS: number, tailS: number, rate: number = RATE): Float32Array {
    const peak = Math.pow(10, -12 / 20);
    const head = new Float32Array(Math.round(headS * rate));
    const tail = new Float32Array(Math.round(tailS * rate));
    const body = new Float32Array(Math.round(1.5 * rate));
    for (let i = 0; i < body.length; i += 1) {
      body[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * peak;
    }
    const out = new Float32Array(head.length + body.length + tail.length);
    out.set(body, head.length);
    return out;
  }

  /** First sample sounding above the voice threshold, in seconds. */
  function voiceOnset(samples: Float32Array, rate: number = RATE): number {
    for (let i = 0; i < samples.length; i += 1) {
      if (Math.abs(samples[i]) >= 0.02) return i / rate;
    }
    throw new Error('no voice found');
  }

  it('keeps render block spans on the voice after the head rebuild', () => {
    const samples = edgedTake(0.04, 0.04);
    // The block span covers the voiced core, the way the queue measures it.
    const span = { start: Math.round(0.04 * RATE), end: samples.length - Math.round(0.04 * RATE) };
    const fixed = ensureAcxEnds(samples, RATE);
    // Exactly the render-tail arithmetic in dsp.worker: the padded head
    // shifts every span by the head delta in samples.
    const headDelta = Math.round((fixed.fix.headDeltaMs / 1000) * RATE);
    const shifted = { start: span.start + headDelta, end: span.end + headDelta };
    // A cue placed at the shifted span starts on the voice in the finished
    // audio, at the ACX head target — not back where the voice used to be.
    expect(Math.abs(shifted.start / RATE - voiceOnset(fixed.samples))).toBeLessThan(0.01);
    // At the ACX head target, give or take the one 10 ms measurement window of
    // true silence the trimmer keeps (it only ever cuts whole silent windows).
    expect(shifted.start / RATE).toBeCloseTo(ACX_HEAD_TARGET_MS / 1000, 1);
    expect(Math.abs(span.start / RATE - voiceOnset(fixed.samples))).toBeGreaterThan(0.5);
  });

  it('shifts a matched copy\u2019s stored captions by the worker head delta', () => {
    const samples = edgedTake(0.04, 0.04);
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const fixed = ensureAcxEnds(samples, RATE);
    // Exactly the LevelCheck/BatchMatch save-path arithmetic.
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    expect(headDeltaSeconds).toBeGreaterThan(0.5);
    const shifted = offsetStoredCaptions(stored, headDeltaSeconds);
    const srt = parseCues(shifted.srt);
    const vtt = parseCues(shifted.vtt);
    expect(srt.map((cue) => cue.start)).toEqual(
      cues.map((cue) => roundMs(cue.start + headDeltaSeconds)),
    );
    expect(srt.map((cue) => cue.end)).toEqual(
      cues.map((cue) => roundMs(cue.end + headDeltaSeconds)),
    );
    expect(vtt).toEqual(srt);
    // And the shifted cues are placed on the rebuilt audio: the first cue
    // opens on the voice, not floating in the new 0.75 s head.
    expect(Math.abs(srt[0].start - voiceOnset(fixed.samples))).toBeLessThan(0.02);
  });

  it('keeps render block spans on the voice when a long head is trimmed', () => {
    const samples = edgedTake(2.5, 0.04);
    const span = { start: Math.round(2.5 * RATE), end: samples.length - Math.round(0.04 * RATE) };
    const fixed = ensureAcxEnds(samples, RATE);
    // A 2.5 s head trims back to the 0.75 s target: negative delta.
    expect(fixed.fix.headDeltaMs).toBeLessThan(0);
    expect(fixed.fix.headDeltaMs / 1000).toBeCloseTo(ACX_HEAD_TARGET_MS / 1000 - 2.5, 2);
    // Same render-tail arithmetic as the padding case above.
    const headDelta = Math.round((fixed.fix.headDeltaMs / 1000) * RATE);
    expect(headDelta).toBeLessThan(0);
    const shifted = { start: span.start + headDelta, end: span.end + headDelta };
    expect(Math.abs(shifted.start / RATE - voiceOnset(fixed.samples))).toBeLessThan(0.01);
    expect(shifted.start / RATE).toBeCloseTo(ACX_HEAD_TARGET_MS / 1000, 1);
    // Without the shift the cue would sit 1.75 s into the voiced core.
    expect(Math.abs(span.start / RATE - voiceOnset(fixed.samples))).toBeGreaterThan(1);
  });

  it('shifts a trimmed copy\u2019s stored captions backwards by the worker head delta', () => {
    const samples = edgedTake(2.5, 0.04);
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const fixed = ensureAcxEnds(samples, RATE);
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    expect(headDeltaSeconds).toBeLessThan(0);
    const shifted = offsetStoredCaptions(stored, headDeltaSeconds);
    const srt = parseCues(shifted.srt);
    const vtt = parseCues(shifted.vtt);
    expect(srt.map((cue) => cue.start)).toEqual(
      cues.map((cue) => roundMs(cue.start + headDeltaSeconds)),
    );
    expect(srt.map((cue) => cue.end)).toEqual(
      cues.map((cue) => roundMs(cue.end + headDeltaSeconds)),
    );
    expect(vtt).toEqual(srt);
    // Speaker labels survive the negative shift in both formats.
    expect(srt.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    // The backwards-shifted cues still open on the voice in the trimmed audio.
    expect(Math.abs(srt[0].start - voiceOnset(fixed.samples))).toBeLessThan(0.02);
    expect(srt[0].start).toBeGreaterThan(0);
  });

  it('shifts edited (nudged) cues exactly once through a later Match', () => {
    // The CaptionEditor path: parse → nudge +0.1 s → save → a later Match
    // shifts by the worker head delta once (equality below already fails on
    // a double shift, so no separate guard is needed).
    const samples = edgedTake(0.04, 0.04);
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    // Editor nudge: first cue starts a tenth later, then saved to both formats.
    const edited = parseCues(formatSRT(cues)).map((cue, index) =>
      index === 0 ? { ...cue, start: clampTime(cue.start + 0.1) } : cue,
    );
    expect(edited[0].start).toBeCloseTo(roundMs(onset + 0.1), 9);
    const editedStored = { srt: formatSRT(edited), vtt: formatVTT(edited) };
    // Later Match: exactly the LevelCheck/BatchMatch save-path arithmetic.
    const fixed = ensureAcxEnds(samples, RATE);
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    expect(headDeltaSeconds).toBeGreaterThan(0.5);
    const matched = offsetStoredCaptions(editedStored, headDeltaSeconds);
    const srt = parseCues(matched.srt);
    const vtt = parseCues(matched.vtt);
    // Single shift: nudged time plus one head delta, speakers intact.
    expect(srt.map((cue) => cue.start)).toEqual(
      edited.map((cue) => roundMs(cue.start + headDeltaSeconds)),
    );
    expect(srt.map((cue) => cue.end)).toEqual(
      edited.map((cue) => roundMs(cue.end + headDeltaSeconds)),
    );
    expect(srt.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    expect(vtt).toEqual(srt);
  });

  it('clamps an edited cue at zero once through a trim Match', () => {
    // A −0.1 s editor nudge stays positive pre-Match; the later trim shift
    // clamps the early cue at zero once instead of going negative.
    const samples = edgedTake(2.5, 0.04);
    const onset = voiceOnset(samples);
    const cues = [
      { start: 1.0, end: 2.5, text: 'hello world', speaker: 'Leah' },
      { start: onset, end: onset + 0.4, text: 'caption proof line', speaker: 'Ryan' },
    ];
    // Editor nudge earlier, like CaptionEditor (still positive pre-Match).
    const edited = parseCues(formatSRT(cues)).map((cue, index) =>
      index === 0 ? { ...cue, start: clampTime(cue.start - 0.1) } : cue,
    );
    expect(edited[0].start).toBeCloseTo(0.9, 9);
    const editedStored = { srt: formatSRT(edited), vtt: formatVTT(edited) };
    const fixed = ensureAcxEnds(samples, RATE);
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    expect(headDeltaSeconds).toBeLessThan(0);
    const matched = offsetStoredCaptions(editedStored, headDeltaSeconds);
    const srt = parseCues(matched.srt);
    const vtt = parseCues(matched.vtt);
    expect(srt[0].start).toBe(0);
    expect(srt[0].end).toBe(roundMs(Math.max(0, edited[0].end + headDeltaSeconds)));
    expect(srt[1].start).toBe(roundMs(edited[1].start + headDeltaSeconds));
    expect(srt.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    expect(vtt).toEqual(srt);
  });

  it('shifts Whisper-backfilled cues exactly once through a later Match', () => {
    // The real backfill chain — chunk timestamps → normalizeWords →
    // wordsToCues → save — then a later Match shifts once via the save-path
    // arithmetic. The 0.9 s inter-chunk gap breaks the packing, so two cues
    // prove the per-cue shift.
    const samples = edgedTake(0.04, 0.04);
    const onset = voiceOnset(samples);
    const chunks = [
      { text: 'hello world', timestamp: [onset, onset + 0.4] as [number, number] },
      { text: 'second line here', timestamp: [onset + 1.3, onset + 1.45] as [number, number] },
    ];
    const backfilled = wordsToCues(normalizeWords(chunks));
    expect(backfilled).toHaveLength(2);
    expect(backfilled[0].start).toBeCloseTo(onset, 9);
    const stored = { srt: formatSRT(backfilled), vtt: formatVTT(backfilled) };
    const fixed = ensureAcxEnds(samples, RATE);
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    expect(headDeltaSeconds).toBeGreaterThan(0.5);
    const matched = offsetStoredCaptions(stored, headDeltaSeconds);
    const srt = parseCues(matched.srt);
    expect(srt).toHaveLength(backfilled.length);
    // Exact single shift with nothing clamped to zero: equality already
    // fails on a double shift or a clamped cue.
    expect(srt.map((cue) => cue.start)).toEqual(
      backfilled.map((cue) => roundMs(cue.start + headDeltaSeconds)),
    );
    expect(srt.map((cue) => cue.end)).toEqual(
      backfilled.map((cue) => roundMs(cue.end + headDeltaSeconds)),
    );
    for (const cue of srt) expect(cue.start).toBeGreaterThan(0);
    expect(parseCues(matched.vtt)).toEqual(srt);
    expect(Math.abs(srt[0].start - voiceOnset(fixed.samples))).toBeLessThan(0.02);
  });

  it('leaves an in-spec take byte-identical with no span shift', () => {
    // 16 kHz windows divide the ACX targets evenly (10 ms each), so a take
    // built exactly on target measures exactly on target — no quantization
    // drift, the way a passing take must behave through the rebuild.
    const SR = 16000;
    const samples = edgedTake(0.75, 2.0, SR);
    const headLen = Math.round(0.75 * SR);
    const bodyLen = Math.round(1.5 * SR);
    expect(checkEnds(measureEnds(samples, SR)).verdict).toBe('pass');
    const fixed = ensureAcxEnds(samples, SR);
    expect(checkEnds(measureEnds(fixed.samples, SR)).verdict).toBe('pass');
    // No edge moved, so neither call-site may shift captions.
    expect(fixed.fix.headDeltaMs).toBe(0);
    expect(fixed.fix.tailDeltaMs).toBe(0);
    const onset = voiceOnset(samples, SR);
    expect(onset).toBeGreaterThan(0);
    const cues = [{ start: onset, end: onset + 0.4, text: 'hello world' }];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    // Exactly the LevelCheck/BatchMatch save-path arithmetic: a zero delta
    // returns the same object, so the saved strings are byte-identical.
    expect(offsetStoredCaptions(stored, (fixed.fix.headDeltaMs ?? 0) / 1000)).toBe(stored);
    // Exactly the render-tail arithmetic in dsp.worker: zero delta shifts
    // no span.
    const headDelta = Math.round((fixed.fix.headDeltaMs / 1000) * SR);
    expect(headDelta).toBe(0);
    const span = { start: headLen, end: headLen + bodyLen };
    const shifted = { start: span.start + headDelta, end: span.end + headDelta };
    expect(shifted).toEqual(span);
  });

  it('leaves Ad Spot takes untouched since only audiobook rebuilds edges', () => {
    // dsp.worker only runs ensureAcxEnds for the audiobook standard, and the
    // LevelCheck/BatchMatch save path derives the shift from endsFix ?? 0 —
    // so an Ad Spot Match carries no head delta even on audio that audiobook
    // would pad.
    expect(LOUDNESS_STANDARDS.some((entry) => entry.id === 'ad')).toBe(true);
    const samples = edgedTake(0.04, 0.04);
    expect(ensureAcxEnds(samples, RATE).fix.headDeltaMs / 1000).toBeGreaterThan(0.5);
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    // Exactly the Ad Spot save-path arithmetic: no endsFix, so delta zero
    // returns the same object — byte-identical strings, no span shift.
    const matched: { endsFix?: { headDeltaMs: number } } = {};
    const headDeltaSeconds = (matched.endsFix?.headDeltaMs ?? 0) / 1000;
    expect(offsetStoredCaptions(stored, headDeltaSeconds)).toBe(stored);
    const span = { start: Math.round(0.04 * RATE), end: samples.length - Math.round(0.04 * RATE) };
    const headDelta = Math.round(headDeltaSeconds * RATE);
    expect(headDelta).toBe(0);
    expect({ start: span.start + headDelta, end: span.end + headDelta }).toEqual(span);
  });

  it('leaves re-matched captions byte-identical instead of drifting again', () => {
    // First Match on a short head shifts once; the rebuilt take already sits
    // inside the ACX windows, so a second Match is a no-op with zero delta —
    // this is the real 22050 Hz path, where a rebuild would otherwise
    // re-quantize the head to whole 10 ms windows and drift ~8 ms.
    const samples = edgedTake(0.04, 0.04);
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const first = ensureAcxEnds(samples, RATE);
    const firstDeltaSeconds = (first.fix.headDeltaMs ?? 0) / 1000;
    expect(firstDeltaSeconds).toBeGreaterThan(0.5);
    const matched = offsetStoredCaptions(stored, firstDeltaSeconds);
    expect(matched.srt).not.toBe(stored.srt);
    // Second Match runs on the rebuilt audio, exactly the save-path chain.
    const second = ensureAcxEnds(first.samples, RATE);
    expect(second.fix.headDeltaMs).toBe(0);
    expect(second.fix.tailDeltaMs).toBe(0);
    expect(second.samples).toBe(first.samples);
    expect(offsetStoredCaptions(matched, (second.fix.headDeltaMs ?? 0) / 1000)).toBe(matched);
    // And the render spans agree: the second head delta shifts no samples.
    expect(Math.round((second.fix.headDeltaMs / 1000) * RATE)).toBe(0);
    // The once-shifted cues still open on the voice in the rebuilt audio.
    const srt = parseCues(matched.srt);
    expect(Math.abs(srt[0].start - voiceOnset(first.samples))).toBeLessThan(0.02);
    expect(parseCues(matched.vtt)).toEqual(srt);
  });

  it('keeps a room-tone take stable across two matches', () => {
    // The realistic recorded-take path: a −65 dB bed counts as silence for
    // the edge meter yet qualifies as loopable room tone for the fill, so
    // the first rebuild pads with tone and the second must be a no-op.
    const bedPeak = Math.pow(10, -65 / 20);
    const voicePeak = Math.pow(10, -12 / 20);
    const headLen = Math.round(0.04 * RATE);
    const bodyLen = Math.round(1.5 * RATE);
    const tailLen = Math.round(0.04 * RATE);
    const samples = new Float32Array(headLen + bodyLen + tailLen);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * bedPeak;
    }
    for (let i = 0; i < bodyLen; i += 1) {
      samples[headLen + i] += Math.sin((2 * Math.PI * 220 * i) / RATE) * voicePeak;
    }
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const first = ensureAcxEnds(samples, RATE);
    expect(first.fix.roomTone).toBe(true);
    const firstDeltaSeconds = (first.fix.headDeltaMs ?? 0) / 1000;
    expect(firstDeltaSeconds).toBeGreaterThan(0.5);
    expect(checkEnds(measureEnds(first.samples, RATE)).verdict).toBe('pass');
    const matched = offsetStoredCaptions(stored, firstDeltaSeconds);
    expect(matched.srt).not.toBe(stored.srt);
    // Second Match on the tone-filled audio: no re-pad, no second shift.
    const second = ensureAcxEnds(first.samples, RATE);
    expect(second.fix.headDeltaMs).toBe(0);
    expect(second.fix.tailDeltaMs).toBe(0);
    expect(second.samples).toBe(first.samples);
    expect(offsetStoredCaptions(matched, (second.fix.headDeltaMs ?? 0) / 1000)).toBe(matched);
    const srt = parseCues(matched.srt);
    expect(srt.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    expect(Math.abs(srt[0].start - voiceOnset(first.samples))).toBeLessThan(0.02);
    expect(parseCues(matched.vtt)).toEqual(srt);
  });

  it('never shifts captions on loud-tone takes, on any run', () => {
    // A −50 dB bed is louder than the silence threshold, so no fill could
    // ever satisfy the meter: both runs are the no-op and the stored captions
    // come back byte-identical instead of drifting +0.75 s per Match.
    const bedPeak = Math.pow(10, -50 / 20);
    const voicePeak = Math.pow(10, -12 / 20);
    const headLen = Math.round(0.04 * RATE);
    const bodyLen = Math.round(1.5 * RATE);
    const tailLen = Math.round(0.04 * RATE);
    const samples = new Float32Array(headLen + bodyLen + tailLen);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * bedPeak;
    }
    for (let i = 0; i < bodyLen; i += 1) {
      samples[headLen + i] += Math.sin((2 * Math.PI * 220 * i) / RATE) * voicePeak;
    }
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    const first = ensureAcxEnds(samples, RATE);
    expect(first.fix.headDeltaMs).toBe(0);
    expect(first.samples).toBe(samples);
    expect(offsetStoredCaptions(stored, 0)).toBe(stored);
    const second = ensureAcxEnds(first.samples, RATE);
    expect(second.fix.headDeltaMs).toBe(0);
    expect(second.samples).toBe(samples);
    expect(offsetStoredCaptions(stored, (second.fix.headDeltaMs ?? 0) / 1000)).toBe(stored);
  });

  it('keeps every cue inside the audio when a long tail is trimmed', () => {
    const samples = edgedTake(0.04, 6);
    expect(checkEnds(measureEnds(samples, RATE)).verdict).toBe('fail');
    const fixed = ensureAcxEnds(samples, RATE);
    // A 6 s tail trims back to the 2 s target: negative tail delta.
    expect(fixed.fix.tailDeltaMs).toBeLessThan(0);
    expect(fixed.fix.tailDeltaMs / 1000).toBeCloseTo(ACX_TAIL_TARGET_MS / 1000 - 6, 1);
    expect(checkEnds(measureEnds(fixed.samples, RATE)).verdict).toBe('pass');
    const duration = fixed.samples.length / RATE;
    const onset = voiceOnset(samples);
    const cues = [
      { start: onset, end: onset + 0.4, text: 'hello world', speaker: 'Leah' },
      { start: onset + 0.5, end: onset + 1.0, text: 'caption proof line', speaker: 'Ryan' },
    ];
    const stored = { srt: formatSRT(cues), vtt: formatVTT(cues) };
    // Same Match save-path arithmetic: tail work never moves cue starts.
    const headDeltaSeconds = (fixed.fix.headDeltaMs ?? 0) / 1000;
    const shifted = offsetStoredCaptions(stored, headDeltaSeconds);
    const srt = parseCues(shifted.srt);
    const vtt = parseCues(shifted.vtt);
    expect(vtt).toEqual(srt);
    expect(srt.map((cue) => cue.speaker)).toEqual(['Leah', 'Ryan']);
    for (const cue of srt) {
      expect(cue.end).toBeLessThanOrEqual(duration + 0.001);
      expect(cue.start).toBeLessThan(cue.end);
    }
    // The voice itself still ends with the full target tail behind it: the
    // cues only cover its first second, so measure against the body.
    const voiceEnd = headDeltaSeconds + 0.04 + 1.5;
    expect(duration - voiceEnd).toBeCloseTo(ACX_TAIL_TARGET_MS / 1000, 1);
  });
});

describe('formatters', () => {
  it('writes numbered SRT blocks', () => {
    const srt = formatSRT([{ start: 0, end: 1.2, text: 'Hello world' }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,200\nHello world\n');
  });

  it('writes a WEBVTT header', () => {
    const vtt = formatVTT([{ start: 0, end: 1.2, text: 'Hello world' }]);
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.200');
  });
});
