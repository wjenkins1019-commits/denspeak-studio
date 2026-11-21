// Worker entry point for speech to text.
//
// Loading a Whisper model and decoding a clip both take seconds (or minutes for
// a long file on WASM), so the pipeline lives here and the window stays
// responsive. Models come from the Hub on first use and are then read from the
// renderer's cache, exactly like the cloned-voice engine.
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

interface TranscribeRequest {
  id: number;
  model: string;
  /** Transferred: mono 16 kHz PCM. */
  samples: Float32Array;
  /** Caption mode: ask the model for word timings. */
  timestamps?: boolean;
}

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{
  text: string;
  chunks?: Array<{ text: string; timestamp: [number, number] | null }>;
}>;

const loaded = new Map<string, Transcriber>();

function percentFrom(progress: unknown): number | null {
  const info = progress as { progress?: unknown } | null;
  const value = info?.progress;
  return typeof value === 'number' && Number.isFinite(value) ? value / 100 : null;
}

function statusFrom(progress: unknown): string {
  const info = progress as { status?: unknown; file?: unknown } | null;
  const file = typeof info?.file === 'string' ? info.file.split('/').pop() : null;
  return file ? `Loading ${file}…` : 'Loading the model…';
}

async function load(model: string, id: number): Promise<Transcriber> {
  const cached = loaded.get(model);
  if (cached) return cached;

  const report = (status: string, percent: number | null) =>
    self.postMessage({ id, type: 'progress', status, percent });

  report('Loading the model…', null);
  const asr = (await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (progress: unknown) => {
      report(statusFrom(progress), percentFrom(progress));
    },
  })) as unknown as Transcriber;

  loaded.set(model, asr);
  return asr;
}

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  const { id, model, samples } = event.data;
  const post = (message: Record<string, unknown>) => self.postMessage({ id, ...message });

  try {
    const asr = await load(model, id);
    post({ type: 'progress', status: 'Transcribing…', percent: null });
    const options = { chunk_length_s: 30, stride_length_s: 5 };
    let output;
    if (!event.data.timestamps) {
      output = await asr(samples, { ...options, return_timestamps: false });
    } else {
      try {
        // Word timings; some quantized builds were exported without the cross
        // attentions this needs, so a chunk-level pass is the fallback.
        output = await asr(samples, { ...options, return_timestamps: 'word' });
      } catch (timed) {
        if (!/cross attentions|output_attentions/i.test(String(timed))) throw timed;
        post({ type: 'progress', status: 'Word timings unavailable — using chunks…', percent: null });
        output = await asr(samples, { ...options, return_timestamps: true });
      }
    }
    post({ type: 'result', text: output.text.trim(), words: output.chunks ?? [] });
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
