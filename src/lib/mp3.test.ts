// Smoke test for the MP3 encoder: valid frame sync, MIME-ready bytes, and a
// much smaller file than the PCM it came from. Half a second keeps it fast.
import { describe, expect, it } from 'vitest';
import { encodeWav } from './audio';
import { encodeMp3Pcm } from './mp3';

describe('encodeMp3Pcm', () => {
  it('encodes a tone to smaller valid MP3 bytes', () => {
    const rate = 22_050;
    const samples = new Float32Array(rate / 2);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    }

    const mp3 = new Uint8Array(encodeMp3Pcm(samples, rate));
    expect(mp3.length).toBeGreaterThan(1000);
    // MPEG frame sync: 11 set bits across the first two bytes.
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1] & 0xe0).toBe(0xe0);
    expect(mp3.length).toBeLessThan(encodeWav(samples, rate).byteLength / 2);
  });

  it('refuses empty input', () => {
    expect(() => encodeMp3Pcm(new Float32Array(0), 22_050)).toThrow(/Nothing to encode/);
  });
});
