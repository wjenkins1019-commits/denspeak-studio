// Custom pronunciations: "read X as Y", applied to the text of every render.
// Matching is case-insensitive across whole words, so "St" never rewrites
// "Sting", and the longest match wins ("St. Mary" beats a bare "St").
export interface Pronunciation {
  id: string;
  /** What to look for, e.g. "NGO" or "Dr.". */
  match: string;
  /** What the voice should read instead, e.g. "N G O" or "Doctor". */
  sayAs: string;
}

const STORAGE_KEY = 'chatterbox.pronunciations';
const MAX_ENTRIES = 200;
const MAX_TEXT = 80;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/** Drop anything malformed; never throw on foreign data. */
export function sanitizePronunciations(list: unknown): Pronunciation[] {
  if (!Array.isArray(list)) return [];
  const out: Pronunciation[] = [];
  for (const item of list) {
    if (out.length >= MAX_ENTRIES) break;
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { id?: unknown; match?: unknown; sayAs?: unknown };
    const match = clean(record.match);
    const sayAs = clean(record.sayAs);
    if (!match || !sayAs) continue;
    out.push({
      id: typeof record.id === 'string' && record.id ? record.id.slice(0, 40) : `p${out.length}`,
      match,
      sayAs,
    });
  }
  return out;
}

export function loadPronunciations(): Pronunciation[] {
  try {
    return sanitizePronunciations(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function savePronunciations(list: Pronunciation[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizePronunciations(list)));
  } catch {
    // Storage can be unavailable (private window); the list then lasts the session.
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RewriteRule {
  pattern: RegExp;
  sayAsByMatch: Map<string, string>;
}

/** Longest match wins; the first entry claims a case-insensitive duplicate. */
function buildRewrite(entries: Pronunciation[]): RewriteRule | null {
  const valid = entries.filter((entry) => entry.match && entry.sayAs);
  if (valid.length === 0) return null;
  const ordered = [...valid].sort((a, b) => b.match.length - a.match.length);
  const sayAsByMatch = new Map<string, string>();
  for (const entry of ordered) {
    const key = entry.match.toLowerCase();
    if (!sayAsByMatch.has(key)) sayAsByMatch.set(key, entry.sayAs);
  }
  return {
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${ordered.map((entry) => escapeRegExp(entry.match)).join('|')})(?![\\p{L}\\p{N}_])`,
      'giu',
    ),
    sayAsByMatch,
  };
}

/**
 * Rewrite `text` using the pronunciation list. One pass: entries are tried
 * longest-first, and the replacement is inserted verbatim (no `$` patterns).
 * Pass an explicit list in tests; renders read the stored list by default.
 */
export function applyPronunciations(text: string, list?: Pronunciation[]): string {
  const rule = buildRewrite(list ?? loadPronunciations());
  if (!rule || !text) return text;
  return text.replace(rule.pattern, (found) => rule.sayAsByMatch.get(found.toLowerCase()) ?? found);
}

export interface PronunciationSegment {
  text: string;
  /** True when this span is a replacement the voice will read. */
  changed: boolean;
}

/**
 * The same rewrite as `applyPronunciations`, split into spans so the UI can
 * highlight what the voice will actually read. Joining every span's text
 * always equals `applyPronunciations(text, list)`.
 */
export function segmentPronunciations(text: string, list?: Pronunciation[]): PronunciationSegment[] {
  const rule = buildRewrite(list ?? loadPronunciations());
  if (!rule || !text) return [{ text, changed: false }];

  const segments: PronunciationSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  // The pattern is freshly built above, so its lastIndex starts at zero.
  while ((match = rule.pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), changed: false });
    }
    segments.push({
      text: rule.sayAsByMatch.get(match[0].toLowerCase()) ?? match[0],
      changed: true,
    });
    cursor = match.index + match[0].length;
    // Entries always have a non-empty match, but a zero-length step would
    // loop forever, so guard against a future caller breaking that invariant.
    if (match[0].length === 0) rule.pattern.lastIndex += 1;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), changed: false });
  return segments;
}
