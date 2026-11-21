// Caption cues from transcribed word timings, plus SRT/VTT formatting.
// Cue text is what the transcription heard; timings are measured from the
// finished audio, so mastering shifts cannot drift them.
export interface TimedWord {
  word: string;
  start: number;
  end: number;
  /** Cast display name for this word; absent means plain narration. */
  speaker?: string;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
  /** One speaker per cue — wordsToCues never mixes voices in a cue. */
  speaker?: string;
}

/** A cue's raw chunk from a model that would not give word timings. */
export interface TimedChunk {
  text: string;
  timestamp: [number, number] | null;
}

/**
 * Flatten model chunks to words, dropping anything without a timestamp. A
 * chunk holding a whole sentence (the chunk-level fallback) is spread across
 * its tokens proportional to their length — approximate but far more useful
 * for cueing than one 30-second block, so every model degrades gracefully.
 */
export function normalizeWords(chunks: TimedChunk[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const chunk of chunks) {
    if (!chunk.timestamp) continue;
    const [start, end] = chunk.timestamp;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const text = chunk.text.trim();
    if (!text) continue;
    const tokens = text.split(/\s+/);
    if (tokens.length <= 1) {
      out.push({ word: text, start, end });
      continue;
    }
    const total = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
    let cursor = start;
    tokens.forEach((token, index) => {
      const share = ((end - start) * token.length) / total;
      const wordEnd = index === tokens.length - 1 ? end : cursor + share;
      out.push({ word: token, start: cursor, end: wordEnd });
      cursor = wordEnd;
    });
  }
  return out;
}

/**
 * Split spoken text the way the cue builder tokenizes it: same rule as
 * normalizeWords uses on transcription chunks, so synthesis-timed words and
 * Whisper-timed words pack into identical cues.
 */
export function splitCaptionWords(text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

/** RMS window for the energy curve word boundaries snap to. */
const ALIGN_WINDOW_S = 0.01;
/** A boundary never moves further than this chasing a dip in energy. */
const ALIGN_SNAP_S = 0.15;

/**
 * Where each word of a render block starts and ends, as fractions of the
 * block (N+1 entries from 0 to 1). Targets are proportional to word length,
 * then each internal boundary snaps to the nearest dip in the block's own
 * audio energy — word gaps are quieter than words, so the real PCM pulls
 * most cuts onto the breaths. Approximate: measured against known boundaries
 * through the real finishing tail, cuts land within ~60 ms on average and
 * ~200 ms worst case (a stop consonant near the cut can steal it).
 * Deterministic, instant, offline: the text is the script (never misheard),
 * and cue edges — what SRT/VTT actually carry — only inherit the outer cuts.
 */
export function wordBoundaryFractions(
  words: string[],
  samples: Float32Array,
  sampleRate: number,
): number[] {
  const fractions = [0];
  if (words.length === 0) return fractions;
  const total = words.reduce((sum, word) => sum + word.length, 0) || 1;
  let cursor = 0;
  for (let i = 0; i < words.length - 1; i += 1) {
    cursor += words[i].length;
    fractions.push(cursor / total);
  }
  fractions.push(1);
  if (words.length === 1 || samples.length === 0 || !(sampleRate > 0)) return fractions;

  const window = Math.max(1, Math.round(sampleRate * ALIGN_WINDOW_S));
  const frameCount = Math.ceil(samples.length / window);
  const energy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const from = frame * window;
    const count = Math.min(window, samples.length - from);
    let sum = 0;
    for (let i = 0; i < count; i += 1) {
      const value = samples[from + i];
      sum += value * value;
    }
    energy[frame] = Math.sqrt(sum / count);
  }
  let peak = 0;
  for (const value of energy) peak = Math.max(peak, value);
  if (!(peak > 0)) return fractions;

  const blockSeconds = samples.length / sampleRate;
  const snapFraction = blockSeconds > 0 ? ALIGN_SNAP_S / blockSeconds : 0;
  for (let i = 1; i < fractions.length - 1; i += 1) {
    const target = fractions[i];
    const fromFrame = Math.max(0, Math.floor(((target - snapFraction) * samples.length) / window));
    const toFrame = Math.min(frameCount - 1, Math.ceil(((target + snapFraction) * samples.length) / window));
    let best = -1;
    let bestEnergy = Infinity;
    for (let frame = fromFrame; frame <= toFrame; frame += 1) {
      if (energy[frame] < bestEnergy) {
        bestEnergy = energy[frame];
        best = frame;
      }
    }
    if (best < 0) continue;
    const snapped = (best * window + window / 2) / samples.length;
    // Stay between the neighbours: snapped cuts stay ordered no matter what
    // the energy curve looks like.
    fractions[i] = Math.min(Math.max(snapped, fractions[i - 1]), fractions[i + 1]);
  }
  // A late snap can still overtake a later target; sweep forward once so the
  // cuts are monotonic and cover the block exactly.
  for (let i = 1; i < fractions.length; i += 1) {
    fractions[i] = Math.min(Math.max(fractions[i], fractions[i - 1]), 1);
  }
  return fractions;
}

/** Place words carrying boundary fractions onto an absolute span in seconds. */
export function applyBoundaries(
  words: string[],
  fractions: number[],
  start: number,
  end: number,
  speaker?: string | null,
): TimedWord[] {
  if (words.length === 0 || !(end > start)) return [];
  const out: TimedWord[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const from = fractions[i] ?? 0;
    const to = fractions[i + 1] ?? 1;
    out.push({
      word: words[i],
      start: start + from * (end - start),
      end: start + to * (end - start),
      ...(speaker ? { speaker } : {}),
    });
  }
  return out;
}

const MAX_CHARS = 84;
const MAX_DURATION_S = 7;
/** A pause this long always starts a new cue, so cuts land on breaths. */
const GAP_BREAK_S = 0.8;
/** Past this length a sentence end may close the cue. */
const MIN_SENTENCE_CHARS = 20;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function stamp(total: number, millis: string): string {
  // Round once up front: 1.2 s must print as x,200, never x,199.
  const whole = Math.max(0, Math.round(total * 1000));
  const hours = Math.floor(whole / 3600000);
  const minutes = Math.floor((whole % 3600000) / 60000);
  const seconds = Math.floor((whole % 60000) / 1000);
  const ms = whole % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${millis}${pad(ms, 3)}`;
}

export function formatTimestampSRT(total: number): string {
  return stamp(total, ',');
}

export function formatTimestampVTT(total: number): string {
  return stamp(total, '.');
}

/** Greedily pack words into cue-sized lines. */
export function wordsToCues(
  inputWords: TimedWord[],
  opts: { maxChars?: number; maxDuration?: number } = {},
): Cue[] {
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const maxDuration = opts.maxDuration ?? MAX_DURATION_S;
  const cues: Cue[] = [];
  let current: TimedWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const speaker = current[0].speaker;
    cues.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((entry) => entry.word).join(' '),
      ...(speaker ? { speaker } : {}),
    });
    current = [];
  };

  for (const entry of inputWords) {
    if (current.length > 0) {
      const previous = current[current.length - 1];
      const gap = entry.start - previous.end;
      const text = `${current.map((part) => part.word).join(' ')} ${entry.word}`;
      const endsSentence = /[.!?…]["')\]]?$/.test(previous.word);
      // A voice change always starts a new cue, so one cue never mixes
      // speakers and the SRT/VTT label stays unambiguous.
      const voiceChanged = (previous.speaker ?? null) !== (entry.speaker ?? null);
      if (
        voiceChanged ||
        gap >= GAP_BREAK_S ||
        text.length > maxChars ||
        entry.end - current[0].start > maxDuration ||
        (endsSentence && text.length >= MIN_SENTENCE_CHARS)
      ) {
        flush();
      }
    }
    current.push(entry);
  }
  flush();
  return cues;
}

/** Parse a timestamp printed by formatTimestampSRT/VTT; null when unparseable. */
export function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  const match = /^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,3})$/.exec(trimmed);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, '0'));
  if (
    ![hours, minutes, seconds, millis].every(Number.isFinite) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * Recover the speaker from cue text. VTT voice tags round-trip exactly;
 * SRT convention is a Name: prefix on the first line. Plain prose with a
 * colon reads back as a speaker rather than failing — the editor shows it,
 * so a bad guess is one keystroke from fixed instead of silent data loss.
 */
function withSpeaker(cueText: string): { text: string; speaker?: string } {
  const voice = /^<v\s+([^<>]+)>([\s\S]*?)(<\/v>)?$/.exec(cueText.trim());
  if (voice) {
    const speaker = cleanSpeaker(voice[1]);
    const text = voice[2].trim();
    if (speaker && text) return { text, speaker };
    return { text: cueText };
  }
  const lines = cueText.split('\n');
  const prefix = /^([^:<>]{1,40}):\s+(.+)$/.exec(lines[0] ?? '');
  if (prefix) {
    const speaker = cleanSpeaker(prefix[1]);
    const rest = [prefix[2], ...lines.slice(1)].join('\n').trim();
    if (speaker && rest) return { text: rest, speaker };
  }
  return { text: cueText };
}

/** Parse cue blocks back out of saved SRT/VTT text. VTT headers, cue
 * identifiers, and NOTE blocks are skipped; malformed blocks are dropped so
 * one bad cue never loses the whole file. */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const normalized = text.replace(/\r\n?/g, '\n');
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line, index) => line.trim() !== '' || index === 0);
    const nonEmpty = lines.filter((line) => line.trim() !== '');
    if (nonEmpty.length === 0) continue;
    if (/^WEBVTT/i.test(nonEmpty[0].trim())) {
      nonEmpty.shift();
      if (nonEmpty.length === 0) continue;
    }
    if (/^NOTE(\s|$)/i.test(nonEmpty[0].trim())) continue;
    let stampIndex = nonEmpty.findIndex((line) => line.includes('-->'));
    if (stampIndex < 0) continue;
    const stampMatch = /(.+?)\s*-->\s*(.+)/.exec(nonEmpty[stampIndex]);
    if (!stampMatch) continue;
    const start = parseTimestamp(stampMatch[1]);
    const end = parseTimestamp(stampMatch[2].split(/\s+/)[0]);
    if (start === null || end === null || !(end > start) || start < 0) continue;
    const cueText = nonEmpty
      .slice(stampIndex + 1)
      .join('\n')
      .trim();
    if (!cueText) continue;
    const labeled = withSpeaker(cueText);
    cues.push({ start, end, ...labeled });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Speaker names come from cast tags; keep them to one safe line. */
function cleanSpeaker(raw: string): string {
  return raw
    .replace(/[\r\n<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function formatSRT(cues: Cue[]): string {
  return cues
    .map((cue, index) => {
      const speaker = cue.speaker ? cleanSpeaker(cue.speaker) : '';
      // Prefix the first line only, so multi-line bodies keep their shape.
      const [first, ...rest] = cue.text.split('\n');
      const body = speaker ? [`${speaker}: ${first}`, ...rest].join('\n') : cue.text;
      return `${index + 1}\n${formatTimestampSRT(cue.start)} --> ${formatTimestampSRT(cue.end)}\n${body}\n`;
    })
    .join('\n');
}

/**
 * Shift stored captions by a fixed offset, in seconds. Matched copies pad or
 * trim the head to the ACX target, so every cue moves by the head delta —
 * carrying the old times over unchanged would leave them early or late by up
 * to seconds. Positive moves cues later (padded head), negative earlier.
 * Parse failures come back unchanged rather than wiping the take's captions.
 */
export function offsetStoredCaptions(
  captions: { srt: string; vtt: string },
  deltaSeconds: number,
): { srt: string; vtt: string } {
  if (!(Math.abs(deltaSeconds) > 0.001)) return captions;
  const shift = (text: string, format: (cues: Cue[]) => string): string | null => {
    const cues = parseCues(text);
    if (cues.length === 0) return null;
    return format(
      cues.map((cue) => {
        const start = cue.start + deltaSeconds;
        const end = cue.end + deltaSeconds;
        // A cue shifted entirely before zero would collapse to [0, 0] and be
        // dropped on re-parse, silently losing text. Pin it at the head with
        // its duration preserved so it stays visible and editable instead.
        if (end <= 0) return { ...cue, start: 0, end: cue.end - cue.start };
        return { ...cue, start: Math.max(0, start), end: Math.max(0, end) };
      }),
    );
  };
  return {
    srt: shift(captions.srt, formatSRT) ?? captions.srt,
    vtt: shift(captions.vtt, formatVTT) ?? captions.vtt,
  };
}

export function formatVTT(cues: Cue[]): string {
  const body = cues
    .map((cue) => {
      const speaker = cue.speaker ? cleanSpeaker(cue.speaker) : '';
      const text = speaker ? `<v ${speaker}>${cue.text}</v>` : cue.text;
      return `${formatTimestampVTT(cue.start)} --> ${formatTimestampVTT(cue.end)}\n${text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
