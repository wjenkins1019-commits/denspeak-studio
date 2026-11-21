import { describe, expect, it } from 'vitest';
import {
  ACX_HEAD_TARGET_MS,
  ACX_TAIL_TARGET_MS,
  checkEnds,
  ensureAcxEnds,
  extractRoomTone,
  measureEnds,
} from './acx';

const RATE = 22050;

function tone(seconds: number, peakDb: number): Float32Array {
  const peak = Math.pow(10, peakDb / 20);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * peak;
  }
  return out;
}

/** Speech with exact silent edges: head + tone + tail. */
function take(headS: number, tailS: number): Float32Array {
  const head = new Float32Array(Math.round(headS * RATE));
  const tail = new Float32Array(Math.round(tailS * RATE));
  const body = tone(2, -12);
  const out = new Float32Array(head.length + body.length + tail.length);
  out.set(body, head.length);
  return out;
}

describe('measureEnds', () => {
  it('reads leading and trailing silence', () => {
    const ends = measureEnds(take(0.75, 2), RATE);
    expect(ends.headMs).toBeCloseTo(750, -2);
    expect(ends.tailMs).toBeCloseTo(2000, -2);
  });

  it('refuses silence', () => {
    expect(() => measureEnds(new Float32Array(RATE), RATE)).toThrow('No audible speech');
  });
});

describe('checkEnds', () => {
  it('passes the ACX windows', () => {
    expect(checkEnds({ headMs: 750, tailMs: 2000 }).verdict).toBe('pass');
  });

  it('fails short heads and long tails', () => {
    const result = checkEnds({ headMs: 40, tailMs: 8000 });
    expect(result.verdict).toBe('fail');
    expect(result.checks[0].detail).toMatch(/0\.50–1\.00 s/);
    expect(result.checks[1].detail).toMatch(/1–5 s/);
  });
});

describe('ensureAcxEnds', () => {
  it('pads short edges to the targets', () => {
    const { samples, fix } = ensureAcxEnds(take(0.04, 0.04), RATE);
    expect(fix.roomTone).toBe(false);
    const ends = measureEnds(samples, RATE);
    expect(ends.headMs).toBeCloseTo(ACX_HEAD_TARGET_MS, -2);
    expect(ends.tailMs).toBeCloseTo(ACX_TAIL_TARGET_MS, -2);
    expect(fix.headDeltaMs).toBeGreaterThan(0);
    expect(checkEnds(ends).verdict).toBe('pass');
  });

  it('trims long edges back inside the windows', () => {
    const { samples, fix } = ensureAcxEnds(take(3, 8), RATE);
    const ends = measureEnds(samples, RATE);
    expect(checkEnds(ends).verdict).toBe('pass');
    expect(fix.headDeltaMs).toBeLessThan(0);
    expect(fix.tailDeltaMs).toBeLessThan(0);
  });

  it('fills from the take’s own room tone when it has one', () => {
    // A -65 dB bed counts as silence for the edge meter yet qualifies as
    // loopable room tone: voiced core plus quiet hiss at the ends.
    const bed = tone(4, -65);
    const core = tone(2, -12);
    bed.set(core, RATE);
    const { samples, fix } = ensureAcxEnds(bed, RATE);
    expect(fix.roomTone).toBe(true);
    expect(checkEnds(measureEnds(samples, RATE)).verdict).toBe('pass');
  });

  it('leaves loud-tone takes alone instead of re-padding forever', () => {
    // A -50 dB bed never reads as silence, so a tone fill could never satisfy
    // the meter: rebuilding would pad another 0.75 s / 2.0 s on every Match.
    const bed = tone(4, -50);
    const core = tone(2, -12);
    bed.set(core, RATE);
    const first = ensureAcxEnds(bed, RATE);
    expect(first.fix).toEqual({ headDeltaMs: 0, tailDeltaMs: 0, roomTone: false });
    expect(first.samples).toBe(bed);
    // A second run sees the same input and is the same no-op: stable.
    const second = ensureAcxEnds(first.samples, RATE);
    expect(second.fix).toEqual({ headDeltaMs: 0, tailDeltaMs: 0, roomTone: false });
    expect(second.samples).toBe(bed);
  });

  it('leaves already-good edges byte-identical in length class', () => {
    const { samples } = ensureAcxEnds(take(0.75, 2), RATE);
    const ends = measureEnds(samples, RATE);
    expect(ends.headMs).toBeCloseTo(ACX_HEAD_TARGET_MS, -2);
    expect(ends.tailMs).toBeCloseTo(ACX_TAIL_TARGET_MS, -2);
  });
});

describe('extractRoomTone', () => {
  it('returns null for digital-silent gaps', () => {
    expect(extractRoomTone(take(0.75, 2), RATE)).toBeNull();
  });
});

describe('ensureAcxEnds idempotence sweep', () => {
  // Every head/tail length class × every bed kind: the two guards (skip when
  // passing, bail when the fill could never read as silence) must make the
  // rebuild converge everywhere — the output either passes the edge check or
  // was honestly left alone, and a second run is always a no-op. At 22050 Hz
  // the 10 ms windows don't divide the targets, so this also sweeps the
  // quantization that once drifted re-matches by ~8 ms.
  const HEADS = [0, 0.04, 0.75, 2.5];
  const TAILS = [0, 0.04, 2.0, 6];
  const BEDS: Array<{ label: string; db: number | null }> = [
    { label: 'digital silence', db: null },
    { label: 'quiet tone', db: -65 },
    { label: 'loud tone', db: -50 },
  ];
  const cases: Array<[number, number, number | null, string]> = [];
  for (const headS of HEADS) {
    for (const tailS of TAILS) {
      for (const bed of BEDS) cases.push([headS, tailS, bed.db, bed.label]);
    }
  }

  it.each(cases)('head %ss / tail %ss / %s converges and never re-pads', (headS, tailS, bedDb) => {
    const peak = bedDb === null ? 0 : Math.pow(10, bedDb / 20);
    const headLen = Math.round(headS * RATE);
    const tailLen = Math.round(tailS * RATE);
    const bodyLen = Math.round(1.5 * RATE);
    const samples = new Float32Array(headLen + bodyLen + tailLen);
    if (peak > 0) {
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * peak;
      }
    }
    const voicePeak = Math.pow(10, -12 / 20);
    for (let i = 0; i < bodyLen; i += 1) {
      samples[headLen + i] += Math.sin((2 * Math.PI * 220 * i) / RATE) * voicePeak;
    }
    const first = ensureAcxEnds(samples, RATE);
    const untouched = first.samples === samples;
    // Either it passes now, or it was honestly left alone (loud fill that
    // could never satisfy the meter) — never a still-failing rebuild.
    expect(untouched || checkEnds(measureEnds(first.samples, RATE)).verdict === 'pass').toBe(
      true,
    );
    // A second run on the output is always a no-op: no re-pad, zero deltas.
    const second = ensureAcxEnds(first.samples, RATE);
    expect(second.fix).toEqual({ headDeltaMs: 0, tailDeltaMs: 0, roomTone: false });
    expect(second.samples).toBe(first.samples);
  });
});
