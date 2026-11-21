// One-off generator: pulls the voice catalog out of the original compiled bundle
// (legacy-build/) and writes a typed src/voices.ts. Kept for reference; safe to delete.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundle = fs.readFileSync(
  path.join(root, 'legacy-build/app/assets/index-DJ-ZLA4s.js'),
  'utf8',
);

const ids = [
  ...new Set(
    [...bundle.matchAll(/[a-z]{2,3}_[A-Z]{2,3}-[A-Za-z0-9_]+-(?:x_low|low|medium|high)/g)].map(
      (m) => m[0],
    ),
  ),
].sort();

const curated = {};
for (const m of bundle.matchAll(
  /\{id:"([^"]+)",name:"([^"]+)",language:"[^"]+",languageName:"[^"]+",gender:"([^"]+)",quality:"([^"]+)",sample:"([^"]*)"\}/g,
)) {
  curated[m[1]] = { name: m[2], gender: m[3], quality: m[4], sample: m[5] };
}

const titleCase = (s) =>
  s.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

const rows = ids.map((id) => {
  const [locale, voice, quality] = id.split('-');
  const known = curated[id];
  const name = known ? known.name : titleCase(voice);
  const gender = known?.gender ? ` gender: ${JSON.stringify(known.gender)},` : '';
  return `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, language: ${JSON.stringify(
    locale.replace('_', '-'),
  )}, quality: ${JSON.stringify(quality)},${gender} sample: ${JSON.stringify(known?.sample ?? '')} },`;
});

const file = `// The voices the studio can speak with. Each id is a Piper/VITS model that
// vits-web downloads once and then keeps in the origin private file system.
// Curated names/samples come from the original app; the rest are derived from the
// model id.

export type VoiceQuality = 'x_low' | 'low' | 'medium' | 'high';

export interface Voice {
  /** Piper model id — also the key vits-web uses. */
  id: string;
  name: string;
  /** BCP-47-ish tag, e.g. "en-US". */
  language: string;
  quality: VoiceQuality;
  gender?: 'female' | 'male' | 'neutral';
  /** A short line the voice can read aloud as a preview. */
  sample: string;
}

export const VOICES: Voice[] = [
${rows.join('\n')}
];

export const VOICES_BY_ID = new Map(VOICES.map((voice) => [voice.id, voice]));

const displayNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'language' })
    : null;

/** "en-US" -> "English (US)". */
export function languageName(tag: string): string {
  const [language, region] = tag.split('-');
  const base = displayNames?.of(language) ?? language;
  return region ? \`\${base} (\${region})\` : base;
}

export function voiceLabel(voice: Voice): string {
  return \`\${voice.name} — \${languageName(voice.language)} (\${voice.quality.replace('_', ' ')})\`;
}
`;

fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/voices.ts'), file);
console.log(`wrote src/voices.ts — ${ids.length} voices (${Object.keys(curated).length} curated)`);
