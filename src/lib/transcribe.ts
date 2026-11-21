// Speech to text for a recording.
//
// Whisper runs through the Transformers.js build the app already ships for
// cloned voices, inside a worker so a long clip does not freeze the window.
// The model is downloaded once from the Hub and then served from the renderer's
// cache; the audio itself never leaves the machine.
import { decodeToMono } from './audio';

/** What Whisper expects; anything else is resampled before it is handed over. */
export const WHISPER_SAMPLE_RATE = 16000;

export interface TranscribeModel {
  id: string;
  label: string;
  note: string;
}

export const TRANSCRIBE_MODELS: TranscribeModel[] = [
  { id: 'onnx-community/whisper-tiny.en', label: 'Tiny', note: 'Fastest · English only' },
  { id: 'onnx-community/whisper-base.en', label: 'Base', note: 'Balanced · English only' },
  { id: 'onnx-community/whisper-small.en', label: 'Small', note: 'Most accurate · English only' },
  { id: 'onnx-community/whisper-base', label: 'Multilingual', note: 'Detects the language itself' },
];

export interface TranscribeProgress {
  status: string;
  /** 0..1 while a model file is downloading, null otherwise. */
  percent: number | null;
}

export interface TimedChunk {
  text: string;
  timestamp: [number, number] | null;
}

interface Pending {
  resolve: (result: { text: string; words: TimedChunk[] }) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: TranscribeProgress) => void;
}

type WorkerMessage =
  | { id: number; type: 'progress'; status: string; percent: number | null }
  | { id: number; type: 'result'; text: string; words: TimedChunk[] }
  | { id: number; type: 'error'; message: string };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      if (message.type === 'progress') {
        waiter.onProgress?.({ status: message.status, percent: message.percent });
        return;
      }
      pending.delete(message.id);
      if (message.type === 'result') waiter.resolve({ text: message.text, words: message.words ?? [] });
      else waiter.reject(new Error(message.message || 'Transcription failed.'));
    };
    worker.onerror = (event) => {
      const failure = new Error(`Transcription worker failed: ${event.message || 'unknown error'}`);
      for (const waiter of pending.values()) waiter.reject(failure);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/** Decode any audio the browser can read, mono, resampled to 16 kHz. */
async function toWhisperSamples(blob: Blob): Promise<Float32Array> {
  const decoded = await decodeToMono(blob);
  if (decoded.sampleRate === WHISPER_SAMPLE_RATE) return decoded.samples;

  const frames = Math.max(1, Math.ceil((decoded.samples.length * WHISPER_SAMPLE_RATE) / decoded.sampleRate));
  const context = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
  const buffer = context.createBuffer(1, decoded.samples.length, decoded.sampleRate);
  buffer.copyToChannel(decoded.samples as Float32Array<ArrayBuffer>, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/** Run one clip through the worker, with or without word timestamps. */
function runTranscription(
  blob: Blob,
  model: string,
  timestamps: boolean,
  onProgress?: (progress: TranscribeProgress) => void,
): Promise<{ text: string; words: TimedChunk[] }> {
  onProgress?.({ status: 'Reading the audio…', percent: null });
  return toWhisperSamples(blob).then(
    (samples) =>
      new Promise<{ text: string; words: TimedChunk[] }>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject, onProgress });
        try {
          ensureWorker().postMessage({ id, model, samples, timestamps }, [samples.buffer]);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
}

/** Transcribe one clip. Resolves to the recognised text. */
export async function transcribe(
  blob: Blob,
  model: string,
  onProgress?: (progress: TranscribeProgress) => void,
): Promise<string> {
  const { text } = await runTranscription(blob, model, false, onProgress);
  return text;
}

/**
 * Transcribe one clip with word timings for captioning. Resolves to the timed
 * words (possibly chunk-granular when the model will not give word timings).
 */
export async function transcribeTimed(
  blob: Blob,
  model: string,
  onProgress?: (progress: TranscribeProgress) => void,
): Promise<TimedChunk[]> {
  const { words } = await runTranscription(blob, model, true, onProgress);
  return words;
}

/** For tests: drop the worker so the next call starts a fresh one. */
export function terminateTranscribeWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
