// Voice trainer: build a better cloned voice by analysing several samples and
// cloning from the cleanest one.
//
// This is not model training — the engine is zero-shot, so nothing learns from
// repeated use. What it does control is the reference: a clean, well-leveled,
// single-speaker clip produces a noticeably better clone than a noisy 8-second
// phone recording, and re-cloning from a better clip is how a voice "improves".

import { decodeToMono } from './audio';
import { analyseVoice } from './voiceAnalysis';
import { cloneVoiceFromSample } from './clone';

export interface ClipAnalysis {
  name: string;
  seconds: number;
  sampleRate: number;
  /** Loudest sample, 0..1. */
  peak: number;
  /** Root mean square of the whole clip, 0..1. */
  rms: number;
  /** Share of samples at or beyond full scale, 0..1. */
  clipping: number;
  /** Share of 20 ms frames that are effectively silent, 0..1. */
  silence: number;
  /** Estimated noise floor in dBFS. */
  noiseFloorDb: number;
  /** Speech level minus noise floor, in dB. */
  snrDb: number;
  /** 0..100, higher is a better cloning reference. */
  score: number;
  /** Median speaking pitch, Hz (0 when nothing voiced was found). */
  pitchHz: number;
  /** Spectral centroid, Hz. */
  brightnessHz: number;
  advice: string[];
}

export interface AnalysedClip extends ClipAnalysis {
  blob: Blob;
}

export interface VoiceProfile {
  name: string;
  createdAt: number;
  clipCount: number;
  seconds: number;
  /** Score of the clip that was actually used for cloning. */
  score: number;
  expressiveness: number;
}

const MIN_SECONDS = 3;
const MAX_SECONDS = 20;
const FRAME_SECONDS = 0.02;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percentileFromFrames(frames: number[], fraction: number): number {
  if (frames.length === 0) return 0;
  const sorted = [...frames].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

/** Measure a clip and score it as a cloning reference. */
export async function analyseClip(blob: Blob, name: string): Promise<AnalysedClip> {
  const decoded = await decodeToMono(blob);
  const { samples, sampleRate } = decoded;

  const frameLength = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameLevels: number[] = [];
  let peak = 0;
  let total = 0;
  let clipped = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= 0.995) clipped += 1;
    total += samples[i] * samples[i];
  }

  for (let start = 0; start + frameLength <= samples.length; start += frameLength) {
    let sum = 0;
    for (let i = start; i < start + frameLength; i += 1) sum += samples[i] * samples[i];
    frameLevels.push(Math.sqrt(sum / frameLength));
  }

  const rms = samples.length > 0 ? Math.sqrt(total / samples.length) : 0;
  // The quiet end of the distribution, but not the very quietest frame: a single
  // digital-silence frame would otherwise read as a 90 dB SNR.
  const noiseFloor = percentileFromFrames(frameLevels, 0.05);
  const speechLevel = percentileFromFrames(frameLevels, 0.9);
  const noiseFloorDb = 20 * Math.log10(noiseFloor + 1e-9);
  const speechDb = 20 * Math.log10(speechLevel + 1e-9);
  const snrDb = Math.max(0, speechDb - noiseFloorDb);
  const silence = frameLevels.length
    ? frameLevels.filter((level) => level < 0.0025).length / frameLevels.length
    : 0;
  const clipping = samples.length ? clipped / samples.length : 0;
  const seconds = samples.length / sampleRate;

  // Duration is scored on the 5-15 s sweet spot the engine documents.
  let durationFit = 1;
  if (seconds < MIN_SECONDS) durationFit = clamp01(seconds / MIN_SECONDS) * 0.5;
  else if (seconds < 5) durationFit = 0.8;
  else if (seconds > MAX_SECONDS) durationFit = 0.6;

  const peakFit = peak >= 0.15 && peak <= 0.97 ? 1 : peak < 0.15 ? clamp01(peak / 0.15) : 0.6;

  const score = Math.round(
    clamp01((snrDb - 5) / 25) * 45 +
      durationFit * 25 +
      (1 - clamp01(clipping * 200)) * 10 +
      (1 - clamp01(silence * 2)) * 10 +
      peakFit * 10,
  );

  const advice: string[] = [];
  if (snrDb < 15) advice.push('Background noise is high — record somewhere quieter.');
  if (seconds < MIN_SECONDS) advice.push(`Only ${seconds.toFixed(1)} s; aim for 5–15 s of speech.`);
  if (seconds > MAX_SECONDS) advice.push('Longer than 20 s; the engine only uses a short window.');
  if (clipping > 0.001) advice.push('The level clips — lower the input gain and re-record.');
  if (peak < 0.15) advice.push('Very quiet recording; raise the input gain.');
  if (silence > 0.5) advice.push('Mostly silence — trim it or record continuous speech.');

  const metrics = analyseVoice(samples, sampleRate);

  return {
    name,
    seconds,
    sampleRate,
    peak,
    pitchHz: metrics.pitchHz,
    brightnessHz: metrics.brightnessHz,
    rms,
    clipping,
    silence,
    noiseFloorDb,
    snrDb,
    score,
    advice,
    blob,
  };
}

/** Highest-scoring clip, preferring ones that clear the minimum bar. */
function bestClip(clips: AnalysedClip[]): AnalysedClip | undefined {
  return [...clips].sort((a, b) => b.score - a.score)[0];
}

/** Build (or rebuild) a cloned voice from the best of the supplied clips. */
export async function trainVoice(name: string, clips: AnalysedClip[]): Promise<VoiceProfile> {
  const best = bestClip(clips);
  if (!best) throw new Error('Add at least one sample first.');
  if (best.score < 25) {
    throw new Error(
      `The best sample only scores ${best.score}/100. ${best.advice[0] ?? 'Try a cleaner recording.'}`,
    );
  }

  await cloneVoiceFromSample(best.blob, name);

  const profile: VoiceProfile = {
    name,
    createdAt: Date.now(),
    clipCount: clips.length,
    seconds: Math.round(clips.reduce((sum, clip) => sum + clip.seconds, 0) * 10) / 10,
    score: best.score,
    expressiveness: 0.5,
  };
  await saveProfile(profile);
  await saveSample(name, best.blob);
  return profile;
}

// ---------------------------------------------------------------------------
// Storage: profiles and the clip that produced them, in their own database so
// the take library and cloned embeddings stay independent.
// ---------------------------------------------------------------------------

const DB_NAME = 'chatter-box-voices';
const DB_VERSION = 1;
const PROFILES = 'profiles';
const SAMPLES = 'samples';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(SAMPLES)) db.createObjectStore(SAMPLES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the voice trainer store'));
  });

  return dbPromise;
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Voice trainer request failed'));
  });
}

export async function listProfiles(): Promise<VoiceProfile[]> {
  try {
    const db = await openDb();
    const rows = await toPromise(db.transaction(PROFILES, 'readonly').objectStore(PROFILES).getAll() as IDBRequest<VoiceProfile[]>);
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveProfile(profile: VoiceProfile): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(PROFILES, 'readwrite').objectStore(PROFILES).put(profile));
}

export async function deleteProfile(name: string): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(PROFILES, 'readwrite').objectStore(PROFILES).delete(name));
  await toPromise(db.transaction(SAMPLES, 'readwrite').objectStore(SAMPLES).delete(name));
}

async function saveSample(name: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(SAMPLES, 'readwrite').objectStore(SAMPLES).put(blob, name));
}

/** The clip the current clone was built from, so it can be re-analysed later. */
export async function loadSample(name: string): Promise<Blob | undefined> {
  try {
    const db = await openDb();
    return await toPromise(db.transaction(SAMPLES, 'readonly').objectStore(SAMPLES).get(name) as IDBRequest<Blob | undefined>);
  } catch {
    return undefined;
  }
}
