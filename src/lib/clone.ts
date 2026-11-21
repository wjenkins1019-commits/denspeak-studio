// Cloned voices: zero-shot text-to-speech from an uploaded sample.
//
// Piper cannot do this — its voices are fixed models with no adaptation step — so
// this is a second engine: Chatterbox ONNX through Transformers.js, via the
// `voxshot` package. Everything runs locally; the only network use is the one
// time ~1.5 GB model download, which the browser then caches.
//
// Trade-offs worth knowing:
//   * English only (the bundled checkpoint has no CJK/kana tokens);
//   * the model is a retired research release, and every output carries
//     Resemble's inaudible PerTh watermark;
//   * generation is much slower than Piper — seconds per sentence, not instant.

import {
  ChatterboxEngine,
  IndexedDbVoiceStore,
  VoxShot,
  WorkerSynthesisEngine,
} from 'voxshot';
import { applyPronunciations } from './pronounce';

/** Voice ids for cloned speakers are prefixed so the picker can tell them apart. */
export const CLONE_PREFIX = 'clone:';

export interface CloneStatus {
  phase: 'download' | 'compile' | 'ready' | 'working';
  label: string;
  /** Download completion 0-100, when known. */
  percent?: number;
}

export interface ClonedSpeech {
  samples: Float32Array;
  sampleRate: number;
}

type Listener = (status: CloneStatus) => void;
const listeners = new Set<Listener>();

function publish(status: CloneStatus): void {
  for (const listener of listeners) listener(status);
}

/** Listen for load/generate progress from the cloning engine. */
export function subscribeCloneStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// One store shared by our listing code and by VoxShot, so a voice saved by the
// engine is the same one the picker lists.
const store = new IndexedDbVoiceStore({ databaseName: 'chatterbox-clones' });

export async function listClonedVoices(): Promise<string[]> {
  try {
    return await store.list();
  } catch {
    return [];
  }
}

export async function deleteClonedVoice(name: string): Promise<void> {
  try {
    await store.delete(name);
  } catch {
    // Nothing stored under that name; the UI refreshes either way.
  }
}

let enginePromise: Promise<VoxShot> | null = null;

function handleEvent(event: Record<string, unknown>): void {
  const status = String(event.status ?? '');

  if (status === 'load-start') {
    publish({ phase: 'download', label: `Loading the voice model (${String(event.plan ?? 'auto')})…` });
    return;
  }
  if (status === 'load-fallback') {
    publish({ phase: 'compile', label: `Retrying on another backend (${String(event.reason ?? 'unavailable')})…` });
    return;
  }
  if (status === 'load-ready') {
    publish({ phase: 'ready', label: 'Voice model ready' });
    return;
  }
  if (status === 'synthesize-truncated') {
    publish({ phase: 'working', label: 'A chunk ran long and was cut short.' });
    return;
  }

  if (typeof event.progress === 'number' && typeof event.file === 'string') {
    const file = event.file.split('/').pop() ?? 'model';
    publish({
      phase: 'download',
      label: `Downloading ${file}…`,
      percent: Math.round(Number(event.progress)),
    });
  }
}

async function createEngine(forceCpu = false): Promise<VoxShot> {
  let worker: Worker;

  // Only fall back to the window thread when workers are unavailable at all.
  // Retrying a *failed load* there would block the UI for minutes and re-fetch
  // weights that are already cached, so a load error is surfaced to the caller
  // instead.
  try {
    worker = new Worker(new URL('./clone-worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    console.warn('[clone] workers unavailable, running the engine in the window thread', error);
    publish({ phase: 'compile', label: 'Running the cloning engine in the window thread…' });
    const engine = new ChatterboxEngine({
      onProgress: (event) => handleEvent(event as unknown as Record<string, unknown>),
      stallTimeoutMs: 1_800_000,
      // Same local-weights configuration as the worker; dynamic so the library
      // is only fetched when this rare fallback actually runs.
      loadModule: async () => {
        const transformers = await import('@huggingface/transformers');
        transformers.env.allowRemoteModels = false;
        transformers.env.allowLocalModels = true;
        transformers.env.localModelPath = '/models/';
        transformers.env.useBrowserCache = false;
        return transformers as unknown as never;
      },
    });
    return VoxShot.create({
      engine,
      voiceStore: store,
      minChunkLength: 20,
      device: forceCpu ? 'wasm' : 'auto',
    });
  }

  const engine = new WorkerSynthesisEngine(worker, { onProgress: handleEvent });
  try {
    return await VoxShot.create({
      engine,
      voiceStore: store,
      minChunkLength: 20,
      device: forceCpu ? 'wasm' : 'auto',
    });
  } catch (error) {
    engine.disconnect();
    worker.terminate();
    throw error;
  }
}

/** Turn an engine failure into something worth showing a user. */
export function describeCloneError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/network|fetch|failed to load/i.test(message)) {
    return 'The voice model could not be downloaded. Check the connection and try again — files that finished are kept, so a retry picks up where it stopped.';
  }
  return message;
}

let cpuEnginePromise: Promise<VoxShot> | null = null;

/** `localStorage['chatterbox.cpu'] = '1'` pins cloning to the CPU. */
function cpuPinned(): boolean {
  try {
    return localStorage.getItem('chatterbox.cpu') === '1';
  } catch {
    return false;
  }
}

/** Load (once) the cloning engine, downloading the model the first time. */
export function loadCloneEngine(forceCpu = cpuPinned()): Promise<VoxShot> {
  if (forceCpu) {
    if (!cpuEnginePromise) {
      cpuEnginePromise = createEngine(true).catch((error) => {
        cpuEnginePromise = null;
        throw error;
      });
    }
    return cpuEnginePromise;
  }

  if (!enginePromise) {
    enginePromise = createEngine(false).catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

/** Does this failure look like the GPU refusing the model rather than a real error? */
function isGpuFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /webgpu|wgpu|d3d|shader|OrtRun|GPUBuffer/i.test(message);
}

/**
 * Run against the GPU engine, and if that specific failure appears, retry once
 * on the CPU. Some drivers (this machine's included) load the model fine and
 * then fail compiling its compute shaders at inference time.
 */
async function withEngineFallback<T>(run: (tts: VoxShot) => Promise<T>): Promise<T> {
  try {
    return await run(await loadCloneEngine());
  } catch (error) {
    if (!isGpuFailure(error)) throw error;
    publish({
      phase: 'compile',
      label: 'The graphics card cannot run this model — switching to the CPU…',
    });
    return await run(await loadCloneEngine(true));
  }
}

/** Clone a voice from an uploaded sample and persist it under `name`. */
export async function cloneVoiceFromSample(sample: Blob, name: string): Promise<void> {
  await withEngineFallback(async (tts) => {
    publish({ phase: 'working', label: 'Reading the sample…' });
    await tts.cloneVoice(sample);
    await tts.saveVoice(name);
  });
  publish({ phase: 'ready', label: `Voice "${name}" added` });
}

/** Render text in a previously saved cloned voice. */
export async function synthesizeWithClonedVoice(options: {
  text: string;
  voiceName: string;
  expressiveness?: number;
  signal?: AbortSignal;
}): Promise<ClonedSpeech> {
  const audio = await withEngineFallback(async (tts) => {
    await tts.useVoice(options.voiceName);
    publish({ phase: 'working', label: 'Generating speech…' });
    return tts.speak(applyPronunciations(options.text), {
      expressiveness: options.expressiveness,
      signal: options.signal,
    });
  });
  return { samples: audio.samples, sampleRate: audio.sampleRate };
}
