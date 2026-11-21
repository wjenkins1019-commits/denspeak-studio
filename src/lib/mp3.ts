// MP3 encoding for the Save As flow, via a pure-JS LAME port (no native
// dependencies, works offline in the packaged app). The actual encode runs in
// the audio worker; this module is the pure function both sides could share.
import { Mp3Encoder } from '@breezystack/lamejs';

/** Mono voice recordings sound transparent well below stereo music rates. */
export const MP3_BITRATE_KBPS = 128;

/** LAME processes this many samples per frame. */
const FRAME_SIZE = 1152;

/** Encode mono float samples (-1..1) as a complete MP3 file's bytes. */
export function encodeMp3Pcm(
  samples: Float32Array,
  sampleRate: number,
  bitrate: number = MP3_BITRATE_KBPS,
): ArrayBuffer {
  if (samples.length === 0) throw new Error('Nothing to encode.');
  const encoder = new Mp3Encoder(1, sampleRate, bitrate);
  const parts: Uint8Array[] = [];
  const frame = new Int16Array(FRAME_SIZE);

  for (let offset = 0; offset < samples.length; offset += FRAME_SIZE) {
    const count = Math.min(FRAME_SIZE, samples.length - offset);
    for (let i = 0; i < count; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[offset + i]));
      frame[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    frame.fill(0, count);
    const encoded = encoder.encodeBuffer(frame);
    if (encoded.length > 0) parts.push(new Uint8Array(encoded));
  }

  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    output.set(part, position);
    position += part.length;
  }
  return output.buffer as ArrayBuffer;
}
