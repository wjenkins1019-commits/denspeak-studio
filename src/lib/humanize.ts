// Naturalness work that sits on top of the Piper engine.
//
// The engine gives us a clean but flat read: given a long paragraph it drifts
// into one even, metronomic cadence, and its output is thin at the top. That
// metronome is what listeners call "robotic". This module adds the things
// people actually read as human:
//
//   1. structure  — hand the engine short, sentence-aligned blocks instead of
//                   whole paragraphs (Piper paces two or three sentences far
//                   better than thirty), and put real air between them;
//   2. phrase     — vary each block the way a reader does: a slightly different
//                   tempo, a slightly different pitch centre, a slightly
//                   different level, and pauses that are never twice the same;
//   3. mastering  — high-pass rumble, a little low-shelf body, a presence lift
//                   so consonants stay forward, a gentle high shelf instead of
//                   a de-harshing cut, light compression that keeps the
//                   dynamics, and a peak-safe normalisation.
//
// All of it is plain arrays: no Web Audio graph, no native deps, so it runs in
// the renderer and can be unit-tested.

import { shiftPitch, timeStretch } from './audio';
import { applyBiquad, compressSamples, makeBiquad, normalizePeak } from './dsp';
import { extractVoiceTagWithSpeaker, type CastMember } from './cast';

export interface SpeechBlock {
  text: string;
  /** Silence to insert after this block, before the next one. */
  pauseAfterMs: number;
}

export interface HumanizeOptions {
  /** 0 = off, 1 = full. Interpolates every step of the chain. */
  strength: number;
}

const PARAGRAPH_PAUSE_MS = 700;
const SENTENCE_PAUSE_MS = 310;
const CLAUSE_PAUSE_MS = 190;
/**
 * Blocks the engine is asked to read in one go. Piper's prosody is noticeably
 * better on two or three sentences than on a whole paragraph, so this is much
 * shorter than the old 700; the extra predict() calls are paid for by the
 * render queue, and each block is also a finer crash checkpoint.
 */
const MAX_BLOCK_CHARS = 320;
/** A shorter tail than this reads better attached to the block before it. */
const MIN_BLOCK_CHARS = 90;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Split a paragraph at sentence ends, keeping the punctuation. */
function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [paragraph];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

/** Break a single over-long sentence at word boundaries, preferring clauses. */
function splitClauses(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];

  const words = sentence.split(' ');
  const parts: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > max && current) {
      parts.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Greedily pack sentences into blocks of at most `max` characters. */
function groupSentences(sentences: string[], max: number, min: number): string[] {
  const blocks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    for (const piece of splitClauses(sentence, max)) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (current && candidate.length > max) {
        blocks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) blocks.push(current);

  // Fold a very short tail ("Yes.", "Continue.") into the block before it so
  // the engine does not have to start a new session for four words.
  while (blocks.length > 1 && blocks[blocks.length - 1].length < min) {
    const tail = blocks.pop() as string;
    blocks[blocks.length - 1] = `${blocks[blocks.length - 1]} ${tail}`;
  }

  return blocks;
}

/** Pause after a block, chosen from the punctuation it ends with. */
function pauseFor(text: string, paragraphEnd: boolean): number {
  if (paragraphEnd) return PARAGRAPH_PAUSE_MS;
  return /[.!?…]["')\]]*$/.test(text) ? SENTENCE_PAUSE_MS : CLAUSE_PAUSE_MS;
}

/**
 * Turn a script into render blocks: paragraph, then sentence-aligned groups
 * short enough for the engine to keep a convincing cadence.
 */
export function planSpeech(script: string): SpeechBlock[] {
  const paragraphs = script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const blocks: SpeechBlock[] = [];

  for (const paragraph of paragraphs) {
    const grouped = groupSentences(splitSentences(paragraph), MAX_BLOCK_CHARS, MIN_BLOCK_CHARS);
    grouped.forEach((text, index) => {
      blocks.push({ text, pauseAfterMs: pauseFor(text, index === grouped.length - 1) });
    });
  }

  if (blocks.length > 0) blocks[blocks.length - 1].pauseAfterMs = 0;
  return blocks;
}

export interface VoicedBlock extends SpeechBlock {
  /** Bank voice for this block; null means the job's default voice. */
  voiceId: string | null;
  /** Cast display name for captions; null means plain narration. */
  speaker: string | null;
}

/**
 * planSpeech with per-paragraph cast tags resolved: same normalization,
 * grouping and pauses, plus the tagged voice on each block. Tag-only
 * paragraphs (nothing left after the strip) are dropped.
 */
export function planVoicedBlocks(script: string, cast: CastMember[]): VoicedBlock[] {
  const paragraphs = script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const blocks: VoicedBlock[] = [];

  for (const paragraph of paragraphs) {
    const { voiceId, speaker, text } = extractVoiceTagWithSpeaker(paragraph, cast);
    if (!text) continue;
    const grouped = groupSentences(splitSentences(text), MAX_BLOCK_CHARS, MIN_BLOCK_CHARS);
    grouped.forEach((blockText, index) => {
      blocks.push({
        text: blockText,
        pauseAfterMs: pauseFor(blockText, index === grouped.length - 1),
        voiceId,
        speaker,
      });
    });
  }

  if (blocks.length > 0) blocks[blocks.length - 1].pauseAfterMs = 0;
  return blocks;
}

/** Sample offsets of one render block inside the assembled audio. */
export interface BlockSpan {
  start: number;
  end: number;
}

/**
 * Carry block spans through a tail stage that only ever rescales the whole
 * mix (shaping, the global speed change): one linear map keeps every span
 * placed within tens of milliseconds, which is plenty for cueing.
 */
export function rescaleSpans(spans: BlockSpan[], fromLength: number, toLength: number): BlockSpan[] {
  if (fromLength <= 0 || fromLength === toLength) return spans;
  const ratio = toLength / fromLength;
  return spans.map((span) => ({ start: Math.round(span.start * ratio), end: Math.round(span.end * ratio) }));
}

export interface AssembledSpeech {
  audio: Float32Array;
  /** One span per block, in order, in assembled samples. */
  spans: BlockSpan[];
}

/**
 * Straight concatenation, used when naturalness is off. `gapSamples` of silence
 * goes between blocks: blocks are sentence groups now, so butting two of them
 * together would run one sentence straight into the next.
 */
export function concatSpeechWithSpans(blocks: Float32Array[], gapSamples = 0): AssembledSpeech {
  const gap = Math.max(0, Math.round(gapSamples));
  const spans: BlockSpan[] = [];
  let total = 0;
  for (const block of blocks) {
    spans.push({ start: total, end: total + block.length });
    total += block.length + gap;
  }
  if (blocks.length > 0) total -= gap;
  const output = new Float32Array(total);
  let offset = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    output.set(blocks[i], offset);
    offset += blocks[i].length + gap;
  }
  return { audio: output, spans };
}

export function concatSpeech(blocks: Float32Array[], gapSamples = 0): Float32Array {
  return concatSpeechWithSpans(blocks, gapSamples).audio;
}

/** Deterministic 0..1 value, so a re-render of the same script sounds the same. */
function seededRandom(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** Deterministic -spread..spread value for phrase-to-phrase variation. */
function jitter(seed: number, spread: number): number {
  return (seededRandom(seed) * 2 - 1) * spread;
}

function applyEdgeFades(samples: Float32Array, sampleRate: number): void {
  const fade = Math.min(Math.round(sampleRate * 0.012), Math.floor(samples.length / 2));
  for (let i = 0; i < fade; i += 1) {
    const gain = i / fade;
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
}

/**
 * Join rendered blocks with silence. Each block gets its own tempo, pitch and
 * level so the read sounds like a person varying their delivery rather than one
 * metronomic take repeated, and the pauses between blocks are never identical.
 *
 * The span variant also reports where each block landed, so word timings
 * measured on the blocks can be placed on the finished take.
 */
export function assembleSpeechWithSpans(
  blocks: Float32Array[],
  pausesMs: number[],
  sampleRate: number,
  options: HumanizeOptions,
): AssembledSpeech {
  const strength = clamp01(options.strength);

  const prepared = blocks.map((block, index) => {
    if (strength <= 0 || blocks.length < 2) {
      return block.slice();
    }

    // A reader never delivers two clauses at exactly the same speed. Up to
    // ±3.5% is enough to break the metronome without sounding unsteady.
    const tempo = 1 + jitter(index * 3 + 1, 0.035 * strength);
    const stretched = timeStretch(block, tempo);

    // Up to ±0.55 semitones — audible as "another phrase", not another person.
    const drift = jitter(index * 3 + 2, 0.55 * strength);
    const shifted = shiftPitch(stretched, drift);

    // Micro-dynamics: ±0.6 dB per phrase, plus a paragraph-final settle.
    const settle = (pausesMs[index] ?? 0) >= PARAGRAPH_PAUSE_MS * 0.8 ? -0.06 : 0;
    const gain = Math.pow(10, (jitter(index * 3 + 3, 0.07 * strength) + settle * strength) / 20);
    for (let i = 0; i < shifted.length; i += 1) shifted[i] *= gain;

    applyEdgeFades(shifted, sampleRate);
    return shifted;
  });

  const pauseSamples = pausesMs.map((ms, index) => {
    if (ms <= 0) return 0;
    const scaled = ms * (0.65 + 0.35 * strength);
    const varied = strength > 0 ? scaled * (1 + jitter(index * 3 + 4, 0.12 * strength)) : scaled;
    return Math.max(0, Math.round((varied / 1000) * sampleRate));
  });

  const total =
    prepared.reduce((sum, block) => sum + block.length, 0) +
    pauseSamples.reduce((sum, count) => sum + count, 0);

  const output = new Float32Array(total);
  const spans: BlockSpan[] = [];
  let offset = 0;
  for (let i = 0; i < prepared.length; i += 1) {
    spans.push({ start: offset, end: offset + prepared[i].length });
    output.set(prepared[i], offset);
    offset += prepared[i].length;

    // Silence is already zeroed; just advance past it.
    offset += pauseSamples[i] ?? 0;
  }

  return { audio: output, spans };
}

export function assembleSpeech(
  blocks: Float32Array[],
  pausesMs: number[],
  sampleRate: number,
  options: HumanizeOptions,
): Float32Array {
  return assembleSpeechWithSpans(blocks, pausesMs, sampleRate, options).audio;
}

/**
 * Tone and level shaping for the assembled read. `strength` scales every step,
 * so 0 leaves the audio untouched.
 */
export function masterSpeech(
  samples: Float32Array,
  sampleRate: number,
  options: HumanizeOptions,
): Float32Array {
  const strength = clamp01(options.strength);
  if (strength <= 0 || samples.length === 0) return samples;

  const output = samples.slice();

  applyBiquad(output, makeBiquad('highPass', sampleRate, 75, 0, 0.707));
  applyBiquad(output, makeBiquad('lowShelf', sampleRate, 200, 1.4 * strength));
  // Presence: keeps consonants forward, which is most of what "synthetic"
  // sounds like after a de-harshing cut has taken the top end away.
  applyBiquad(output, makeBiquad('peak', sampleRate, 2600, 1.6 * strength, 0.9));
  applyBiquad(output, makeBiquad('highShelf', sampleRate, 7200, -1.3 * strength));
  // Light and slow: speech already has dynamics, and heavy compression flattens
  // exactly the level changes that make a read feel alive.
  compressSamples(output, sampleRate, {
    thresholdDb: -24,
    ratio: 1 + 0.55 * strength,
    attackMs: 15,
    releaseMs: 180,
  });
  normalizePeak(output, -1);

  return output;
}

/** Trim leading/trailing near-silence so takes start and end cleanly. */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const window = Math.max(1, Math.round(sampleRate * 0.01));
  const threshold = 0.0025;

  let start = 0;
  while (start + window < samples.length) {
    let loud = false;
    for (let i = start; i < start + window; i += 1) {
      if (Math.abs(samples[i]) > threshold) {
        loud = true;
        break;
      }
    }
    if (loud) break;
    start += window;
  }

  let end = samples.length;
  while (end - window > start) {
    let loud = false;
    for (let i = end - window; i < end; i += 1) {
      if (Math.abs(samples[i]) > threshold) {
        loud = true;
        break;
      }
    }
    if (loud) break;
    end -= window;
  }

  const pad = Math.round(sampleRate * 0.04);
  return samples.slice(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}
