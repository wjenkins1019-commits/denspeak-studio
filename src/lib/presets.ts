// Saved voices / presets.
//
// A saved voice is a *recipe*: a base voice plus the processing that was applied
// to it (pitch, formant, brightness, EQ, speed, naturalness). Saving one puts it
// in the voice bank, so it can be picked again and re-rendered as if it were a
// built-in voice, and tweaking it further and saving again makes a new entry
// rather than overwriting.

import { transformVoice } from './audio';
import { applyStyle, styleById } from './eq';

export interface SavedVoice {
  id: string;
  name: string;
  createdAt: number;
  /** Base voice id — a bank model id, or `clone:<name>` for a cloned voice. */
  base: string;
  semitones: number;
  formant: number;
  brightness: number;
  eqPresetId: string;
  speed: number;
  humanize: boolean;
  strength: number;
}

/** Prefix used in the voice pickers so a saved voice is distinguishable. */
export const SAVED_VOICE_PREFIX = 'voice:';

export function isSavedVoice(voiceId: string): boolean {
  return voiceId.startsWith(SAVED_VOICE_PREFIX);
}

export function savedVoiceId(voiceId: string): string {
  return voiceId.slice(SAVED_VOICE_PREFIX.length);
}

export interface ShapeSettings {
  semitones: number;
  formant: number;
  brightness: number;
  eqPresetId: string;
}

/** Pitch/formant/brightness shaping followed by the EQ style. Length is preserved. */
export function shapeSamples(
  samples: Float32Array,
  sampleRate: number,
  shape: ShapeSettings,
): Float32Array {
  // Skip the transform when nothing is pitched, so an EQ-only style keeps the
  // sample count exactly (a zero-semitone pass still resamples by a few ms).
  const shaping = Math.abs(shape.semitones) > 0.05 || Math.abs(shape.formant) > 0.01 || Math.abs(shape.brightness) > 0.01;
  const pitched = shaping
    ? transformVoice(samples, sampleRate, {
        semitones: shape.semitones,
        formant: shape.formant,
        brightness: shape.brightness,
      })
    : samples;

  const eq = styleById(shape.eqPresetId);
  return eq.bands.length > 0 ? applyStyle(pitched, sampleRate, eq) : pitched;
}

const DB_NAME = 'chatter-box-presets';
const DB_VERSION = 1;
const STORE = 'voices';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the saved voices'));
  });

  return dbPromise;
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Saved voice request failed'));
  });
}

export async function listSavedVoices(): Promise<SavedVoice[]> {
  try {
    const db = await openDb();
    const rows = await toPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<SavedVoice[]>,
    );
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export type NewSavedVoice = Omit<SavedVoice, 'id' | 'createdAt'>;

export async function saveSavedVoice(input: NewSavedVoice): Promise<SavedVoice> {
  const db = await openDb();
  const voice: SavedVoice = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
  await toPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(voice));
  return voice;
}

export async function deleteSavedVoice(id: string): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
}

/** A short human summary, for lists. */
export function describeSavedVoice(voice: SavedVoice): string {
  const parts: string[] = [];
  if (Math.abs(voice.semitones) >= 0.1) {
    parts.push(`${voice.semitones > 0 ? '+' : ''}${voice.semitones.toFixed(1)} st`);
  }
  if (Math.abs(voice.formant) >= 0.02) parts.push(`formant ${voice.formant.toFixed(2)}`);
  if (Math.abs(voice.brightness) >= 0.02) parts.push(`brightness ${voice.brightness.toFixed(2)}`);
  if (voice.eqPresetId !== 'flat') parts.push(styleById(voice.eqPresetId).label);
  if (Math.abs(voice.speed - 1) >= 0.01) parts.push(`${voice.speed.toFixed(2)}×`);
  if (voice.humanize) parts.push(`naturalness ${Math.round(voice.strength * 100)}%`);
  return parts.length > 0 ? parts.join(' · ') : 'unprocessed';
}
