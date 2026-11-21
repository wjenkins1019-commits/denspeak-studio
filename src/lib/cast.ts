// Multi-voice casting: paragraphs tagged with `Name:` are read by the cast
// member of that name. Matching is case-insensitive; a leading backslash
// escapes the tag so `\Name:` reads literally. Anything else — including a
// `Name:` with no cast member — is untouched default-voice text, so an
// untagged script renders exactly as it always has.
export interface CastMember {
  name: string;
  voiceId: string;
}

/** Longest name that can still open a tag; keeps prose colons safe. */
const MAX_NAME = 40;

export function extractVoiceTag(
  paragraph: string,
  cast: CastMember[],
): { voiceId: string | null; text: string } {
  const match = /^(\\)?([^:\n]{1,40}):\s*/.exec(paragraph);
  if (!match) return { voiceId: null, text: paragraph };
  const [, escaped, rawName] = match;
  const name = rawName.trim();
  if (escaped || name.length === 0 || name.length > MAX_NAME) {
    // Literal: strip one backslash when escaped, keep everything otherwise.
    return { voiceId: null, text: escaped ? paragraph.slice(1) : paragraph };
  }
  const member = cast.find(
    (entry) => entry.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (!member) return { voiceId: null, text: paragraph };
  return { voiceId: member.voiceId, text: paragraph.slice(match[0].length) };
}

/**
 * Same tag match, but keeping the cast member's display name so captions can
 * carry who says what. extractVoiceTag stays exactly shaped for its callers.
 */
export function extractVoiceTagWithSpeaker(
  paragraph: string,
  cast: CastMember[],
): { voiceId: string | null; speaker: string | null; text: string } {
  const { voiceId, text } = extractVoiceTag(paragraph, cast);
  if (voiceId === null) return { voiceId, speaker: null, text };
  const match = /^(\\)?([^:\n]{1,40}):\s*/.exec(paragraph);
  const name = (match?.[2] ?? '').trim();
  const member = cast.find(
    (entry) => entry.name.trim().toLowerCase() === name.toLowerCase(),
  );
  return { voiceId, speaker: member ? member.name.trim() : null, text };
}

/**
 * The script as listeners hear it: tags stripped, tag-only lines gone,
 * everything else byte-identical. Used for take titles so the cast tags
 * never leak into library names.
 */
export function stripCastTags(script: string, cast: CastMember[]): string {
  return script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .map((paragraph) => extractVoiceTag(paragraph, cast).text.trim())
    .filter(Boolean)
    .join('\n\n');
}
