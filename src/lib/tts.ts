// Thin wrapper around vits-web so the rest of the app never imports the engine
// directly. vits-web downloads a Piper model on first use and caches it in the
// origin private file system, then runs inference through ONNX Runtime (WASM).
import * as tts from '@diffusionstudio/vits-web';
import type { VoiceId } from '@diffusionstudio/vits-web';
import { applyPronunciations } from './pronounce';

/**
 * The engine keys its models with a literal union. Every id in `src/voices.ts` is
 * checked against it, so narrowing here is safe and keeps the catalog plain data
 * instead of a 121-member type.
 */
function engineVoiceId(voiceId: string): VoiceId {
  return voiceId as VoiceId;
}

export interface DownloadProgress {
  url: string;
  loaded: number;
  total: number;
}

export type ProgressHandler = (progress: DownloadProgress) => void;

const HF_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';

/**
 * Piper reads its inference scales from the model's config and vits-web exposes
 * no way to pass them in, yet they are the strongest remaining lever on how
 * synthetic a read sounds: `noise_w` varies phoneme durations (the rhythm),
 * `noise_scale` varies the samples around them (the timbre) and `length_scale`
 * sets the base tempo. The shipped values (0.8 / 0.667 / 1.0) are tuned for a
 * clean neutral read; these are nudged towards a person actually reading, which
 * adds the small within-phrase variation that is otherwise missing.
 */
const TUNED_SCALES: Record<string, number> = {
  noise_scale: 0.72,
  noise_w: 0.9,
  length_scale: 1.03,
};

let configPaths: Promise<Map<string, string>> | null = null;

/** Model config path per voice, from the engine's own voice manifest. */
function configPath(voiceId: string): Promise<string | undefined> {
  configPaths ??= tts
    .voices()
    .then((voices) => {
      const paths = new Map<string, string>();
      for (const voice of voices) {
        const json = Object.keys(voice.files).find((key) => key.endsWith(`/${voice.key}.onnx.json`));
        if (json) paths.set(voice.key, json);
      }
      return paths;
    })
    .catch(() => new Map<string, string>());
  return configPaths.then((paths) => paths.get(voiceId));
}

/**
 * Write a config with the tuned scales into the model cache, so predict() picks
 * it up instead of the one it would download. Untouched keys (espeak voice,
 * sample rate, phoneme type, speaker map) are preserved verbatim.
 */
async function tuneVoice(voiceId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('piper', { create: true });
    // The engine caches the config next to the model, as <voice>.onnx.json.
    const fileName = `${voiceId}.onnx.json`;

    let text: string | null = null;
    try {
      text = await (await (await dir.getFileHandle(fileName)).getFile()).text();
    } catch {
      // Not cached yet (first render of this voice): fetch it now, so even the
      // first take is tuned and the model download stays the only network use.
      const path = await configPath(voiceId);
      if (!path) return;
      const response = await fetch(`${HF_BASE}/${path}`);
      if (!response.ok) return;
      text = await response.text();
    }

    const config = JSON.parse(text) as { inference?: Record<string, number> };
    if (!config.inference) return;

    let changed = false;
    for (const [key, value] of Object.entries(TUNED_SCALES)) {
      if (!(key in config.inference) || Math.abs(config.inference[key] - value) < 1e-4) continue;
      config.inference[key] = value;
      changed = true;
    }
    if (!changed) return;

    const writable = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
    await writable.write(JSON.stringify(config));
    await writable.close();
  } catch {
    // Tuning is a nicety: if the cache or the mirror is unavailable, the render
    // still runs, just with the engine's own scales.
  }
}

/** Synthesize `text` with a Piper voice. Resolves to a WAV blob. */
export async function renderSpeech(
  text: string,
  voiceId: string,
  onProgress?: ProgressHandler,
): Promise<Blob> {
  const spoken = applyPronunciations(text);
  await tuneVoice(voiceId);
  return tts.predict({ text: spoken, voiceId: engineVoiceId(voiceId) }, (progress) => {
    onProgress?.({ url: progress.url, loaded: progress.loaded, total: progress.total });
  });
}

/** Model ids already cached in OPFS. */
export async function cachedVoiceIds(): Promise<string[]> {
  try {
    return [...(await tts.stored())];
  } catch {
    return [];
  }
}

export interface VoiceCacheEntry {
  id: string;
  /** On-disk bytes: model plus its config. */
  bytes: number;
}

/**
 * Per-voice disk use from OPFS: the engine caches `<id>.onnx` next to
 * `<id>.onnx.json`, so both count. Biggest first.
 */
export async function voiceCacheUsage(): Promise<VoiceCacheEntry[]> {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('piper');
    const sizes = new Map<string, number>();
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    for (const name of names) {
      const id = name.endsWith('.onnx.json')
        ? name.slice(0, -'.onnx.json'.length)
        : name.endsWith('.onnx')
          ? name.slice(0, -'.onnx'.length)
          : null;
      if (!id) continue;
      try {
        const bytes = (await (await dir.getFileHandle(name)).getFile()).size;
        sizes.set(id, (sizes.get(id) ?? 0) + bytes);
      } catch {
        // A file vanishing mid-scan just drops out of the totals.
      }
    }
    return [...sizes.entries()]
      .map(([id, bytes]) => ({ id, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
  } catch {
    return [];
  }
}

export async function removeVoice(voiceId: string): Promise<void> {
  await tts.remove(engineVoiceId(voiceId));
}

export async function clearAllVoices(): Promise<void> {
  await tts.flush();
}
