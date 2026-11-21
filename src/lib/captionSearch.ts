// Full-text search over stored take captions.
//
// Every take with captions carries its own timed cues (SRT from the
// synthesis, or transcribed later), so search is plain data work in node:
// parse each take's cues once, then match lowercased tokens per cue. A cue
// matches when it holds every query token — multi-word queries narrow
// instead of widening, which is what "where did she say X" wants.
import { parseCues } from './captions';
import type { Take } from './library';

export interface CaptionHit {
  takeId: string;
  takeName: string;
  /** Cue start/end in seconds — the Player seeks here on jump. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/** At most this many hits per take, so one long chapter can't flood the list. */
export const SEARCH_MAX_PER_TAKE = 8;
/** At most this many hits overall, newest takes first. */
export const SEARCH_MAX_TOTAL = 50;

/** Lowercased query words; empty when there is nothing to look for. */
export function searchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function cueHaystack(text: string, speaker?: string): string {
  return speaker ? `${speaker} ${text}`.toLowerCase() : text.toLowerCase();
}

/**
 * Every cue of one take holding all query tokens, in time order. Takes
 * without stored captions contribute nothing — the Library nudges toward the
 * backfill button for those instead of pretending they were searched.
 */
export function searchTakeCaptions(
  take: Take,
  tokens: string[],
  maxPerTake: number = SEARCH_MAX_PER_TAKE,
): CaptionHit[] {
  if (tokens.length === 0 || !take.captions) return [];
  const cues = parseCues(take.captions.srt || take.captions.vtt);
  const hits: CaptionHit[] = [];
  for (const cue of cues) {
    if (hits.length >= maxPerTake) break;
    const haystack = cueHaystack(cue.text, cue.speaker);
    if (!tokens.every((token) => haystack.includes(token))) continue;
    hits.push({
      takeId: take.id,
      takeName: take.name,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      ...(cue.speaker ? { speaker: cue.speaker } : {}),
    });
  }
  return hits;
}

/** Search every take, newest first; empty query searches nothing. */
export function searchCaptions(
  takes: Take[],
  query: string,
  maxTotal: number = SEARCH_MAX_TOTAL,
): CaptionHit[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];
  const hits: CaptionHit[] = [];
  for (const take of takes) {
    if (hits.length >= maxTotal) break;
    hits.push(...searchTakeCaptions(take, tokens).slice(0, maxTotal - hits.length));
  }
  return hits;
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * Split cue text on the query tokens for <mark> rendering. Case-insensitive;
 * overlapping tokens resolve left to right, and text without tokens comes
 * back as one plain part.
 */
export function splitHighlight(text: string, tokens: string[]): HighlightPart[] {
  const words = tokens.filter((token) => token.length > 0);
  if (words.length === 0) return [{ text, hit: false }];
  const escaped = words.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  if (parts.length === 0) return [{ text, hit: false }];
  return parts;
}
