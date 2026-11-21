import { useCallback, useState } from 'react';
import { ACTIVE_PROJECT_KEY, PROJECTS_KEY } from './projects';

const KEYS = {
  voice: 'chatterbox.voice',
  speed: 'chatterbox.speed',
  draft: 'chatterbox.draft',
  humanize: 'chatterbox.humanize',
  humanizeStrength: 'chatterbox.humanizeStrength',
  expressiveness: 'chatterbox.expressiveness',
  eq: 'chatterbox.eqPreset',
  eqDraft: 'chatterbox.eqDraft',
  semitones: 'chatterbox.semitones',
  formant: 'chatterbox.formant',
  brightness: 'chatterbox.brightness',
  transcribeModel: 'chatterbox.transcribeModel',
  loudnessStandard: 'chatterbox.loudnessStandard',
  cast: 'chatterbox.cast',
  mastering: 'chatterbox.mastering',
  notifyRenders: 'chatterbox.notifyRenders',
  projects: PROJECTS_KEY,
  activeProject: ACTIVE_PROJECT_KEY,
  theme: 'chatterbox.theme',
} as const;

export const SETTING_KEYS = KEYS;

/**
 * Fresh profiles start on a high-quality voice, not the small medium one: the
 * model is the single biggest reason a read sounds synthetic. Stored choices
 * always win, so this never moves anyone off the voice they already picked.
 */
export const DEFAULT_VOICE = 'en_US-lessac-high';

/** Naturalness strength for fresh profiles, in the 70-80% band that reads best. */
export const DEFAULT_STRENGTH = 0.75;

/** The UI theme is an attribute on <html>; index.html restores it before paint. */
export type Theme = 'dark' | 'light';
export const DEFAULT_THEME: Theme = 'dark';

export type SetValue<T> = (next: T | ((previous: T) => T)) => void;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private window); settings then stay in memory.
  }
}

/** A localStorage-backed piece of state, kept in the same keys the old build used. */
export function useSetting<T>(key: string, fallback: T): [T, SetValue<T>] {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  const update = useCallback<SetValue<T>>(
    (next) => {
      setValue((previous) => {
        const resolved =
          typeof next === 'function' ? (next as (current: T) => T)(previous) : next;
        write(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, update];
}
