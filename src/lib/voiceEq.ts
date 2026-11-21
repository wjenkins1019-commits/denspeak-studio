// Per-voice EQ memory.
//
// A voice is a model; the EQ style is how that model is finished. Once you pick
// a style for a voice, switching away and back should bring that style with it,
// so this keeps a small `voiceId -> styleId` map in localStorage. Saved voices
// store their own style inside the saved-voice record, so they are not part of
// this map.

const KEY = 'chatterbox.voiceEq';

type Profiles = Record<string, string>;

function read(): Profiles {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const profiles: Profiles = {};
    for (const [voiceId, styleId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof styleId === 'string' && styleId.length > 0) profiles[voiceId] = styleId;
    }
    return profiles;
  } catch {
    return {};
  }
}

function write(profiles: Profiles): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profiles));
  } catch {
    // Storage unavailable; the profile just will not persist.
  }
}

/** The style last used with this voice, if any. */
export function voiceEqFor(voiceId: string): string | undefined {
  return read()[voiceId];
}

/** Remember the style for a voice. No-op when it is already the stored one. */
export function rememberVoiceEq(voiceId: string, styleId: string): void {
  const profiles = read();
  if (profiles[voiceId] === styleId) return;
  profiles[voiceId] = styleId;
  write(profiles);
}
