// Tests for block span tracking: the spans have to tile the assembled audio
// exactly, or synthesis-timed captions would drift off the take.
import { describe, expect, it } from 'vitest';
import { assembleSpeechWithSpans, concatSpeechWithSpans } from './humanize';

function block(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.sin((i + seed) / 7) * 0.3;
  return out;
}

describe('concatSpeechWithSpans', () => {
  it('tiles blocks with the exact gap', () => {
    const { audio, spans } = concatSpeechWithSpans([block(100), block(200), block(50)], 10);
    expect(spans).toEqual([
      { start: 0, end: 100 },
      { start: 110, end: 310 },
      { start: 320, end: 370 },
    ]);
    expect(audio.length).toBe(370);
  });

  it('handles no blocks', () => {
    const { audio, spans } = concatSpeechWithSpans([], 10);
    expect(audio.length).toBe(0);
    expect(spans).toEqual([]);
  });
});

describe('assembleSpeechWithSpans', () => {
  it('tiles exactly with naturalness off', () => {
    const rate = 1000;
    const { audio, spans } = assembleSpeechWithSpans(
      [block(500), block(300)],
      [200, 0],
      rate,
      { strength: 0 },
    );
    // Pauses scale by 0.65 at strength 0: 200 ms -> 130 samples at 1 kHz.
    expect(spans).toEqual([
      { start: 0, end: 500 },
      { start: 630, end: 930 },
    ]);
    expect(audio.length).toBe(930);
    expect(spans[spans.length - 1].end).toBe(audio.length);
  });

  it('stays ordered, disjoint and in bounds when shaped', () => {
    const rate = 22050;
    const { audio, spans } = assembleSpeechWithSpans(
      [block(4000), block(3000), block(5000)],
      [300, 700, 0],
      rate,
      { strength: 0.75 },
    );
    expect(spans).toHaveLength(3);
    expect(spans[0].start).toBe(0);
    for (const span of spans) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(audio.length);
    }
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
    expect(spans[spans.length - 1].end).toBe(audio.length);
  });
});
