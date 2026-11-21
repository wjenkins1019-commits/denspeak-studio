// Single-flight proxy for the DSP worker. Calls are cheap to make but the
// worker is one thread, so callers (the render queue) go one job at a time and
// this just pairs each request with its response.
import type {
  AnalyzeRequest,
  DspRequest,
  DspResponse,
  EndsRequest,
  MatchRequest,
  Mp3Request,
} from './dsp.worker';
import type { AcxEnds, AcxEndsFix } from './acx';
import { MP3_BITRATE_KBPS } from './mp3';
import type { LoudnessReport } from './loudness';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (response: DspResponse) => void; reject: (error: Error) => void }
>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./dsp.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<DspResponse>) => {
      const response = event.data;
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (response.ok) waiter.resolve(response);
      else waiter.reject(new Error(response.error || 'Audio finishing failed.'));
    };
    worker.onerror = (event) => {
      const failure = new Error(`Audio worker failed: ${event.message || 'unknown error'}`);
      for (const waiter of pending.values()) waiter.reject(failure);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export interface FinishedAudio {
  wav: Blob;
  rawWav: Blob | null;
  sampleCount: number;
  sampleRate: number;
  /** Where each render block landed, in finished samples. */
  blockSpans: { start: number; end: number }[];
}

/** Run the DSP tail in the worker; block buffers are transferred, not copied. */
export function finishAudio(request: Omit<DspRequest, 'id'>): Promise<FinishedAudio> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {
      resolve: (response) => {
        if (!response.ok || !response.wav || response.sampleCount === undefined) {
          reject(new Error(response.error || 'Audio finishing failed.'));
          return;
        }
        resolve({
          wav: new Blob([response.wav], { type: 'audio/wav' }),
          rawWav: response.rawWav ? new Blob([response.rawWav], { type: 'audio/wav' }) : null,
          sampleCount: response.sampleCount,
          sampleRate: request.sampleRate,
          blockSpans: response.blockSpans ?? [],
        });
      },
      reject,
    });
    try {
      const transfer = request.blocks.map((block) => block.buffer as ArrayBuffer);
      ensureWorker().postMessage({ ...request, id }, transfer);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Encode a take's WAV bytes as MP3 in the worker, so long takes don't freeze
 * the UI. The input buffer is transferred, not copied.
 */
export function encodeMp3(wav: Blob | ArrayBuffer, bitrate: number = MP3_BITRATE_KBPS): Promise<Blob> {
  const bytes = wav instanceof Blob ? wav.arrayBuffer() : Promise.resolve(wav);
  return bytes.then(
    (buffer) =>
      new Promise<Blob>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve: (response) => {
            if (!response.ok || !response.mp3) {
              reject(new Error(response.error || 'MP3 encoding failed.'));
              return;
            }
            resolve(new Blob([response.mp3], { type: 'audio/mpeg' }));
          },
          reject,
        });
        try {
          const request: Omit<Mp3Request, 'id'> & { id: number } = {
            kind: 'mp3',
            id,
            wav: buffer,
            bitrate,
          };
          ensureWorker().postMessage(request, [buffer]);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
}

export interface MatchedTake {
  wav: Blob;
  before: LoudnessReport;
  after: LoudnessReport;
  gainDb: number;
  peakLimited: boolean;
  /** ACX edges, present when the worker could measure them. */
  beforeEnds?: AcxEnds;
  afterEnds?: AcxEnds;
  endsFix?: AcxEndsFix;
}

/**
 * Fix a take's gain and peaks to a delivery standard in the worker: the fix
 * is measured before and after, so the UI can show the honest result. The
 * input buffer is transferred, not copied.
 */
export function matchTake(wav: Blob | ArrayBuffer, standardId: string): Promise<MatchedTake> {
  const bytes = wav instanceof Blob ? wav.arrayBuffer() : Promise.resolve(wav);
  return bytes.then(
    (buffer) =>
      new Promise<MatchedTake>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve: (response) => {
            if (
              !response.ok ||
              !response.wav ||
              !response.before ||
              !response.after ||
              response.gainDb === undefined ||
              response.peakLimited === undefined
            ) {
              reject(new Error(response.error || 'Matching failed.'));
              return;
            }
            resolve({
              wav: new Blob([response.wav], { type: 'audio/wav' }),
              before: response.before,
              after: response.after,
              gainDb: response.gainDb,
              peakLimited: response.peakLimited,
              ...(response.beforeEnds ? { beforeEnds: response.beforeEnds } : {}),
              ...(response.afterEnds ? { afterEnds: response.afterEnds } : {}),
              ...(response.endsFix ? { endsFix: response.endsFix } : {}),
            });
          },
          reject,
        });
        try {
          const request: Omit<MatchRequest, 'id'> & { id: number } = {
            kind: 'match',
            id,
            wav: buffer,
            standardId,
          };
          ensureWorker().postMessage(request, [buffer]);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
}

/**
 * Measure a take's peak, RMS and noise floor in the worker, so long chapters
 * don't freeze the UI. The input buffer is transferred, not copied.
 */
export function analyzeTake(wav: Blob | ArrayBuffer): Promise<LoudnessReport> {
  const bytes = wav instanceof Blob ? wav.arrayBuffer() : Promise.resolve(wav);
  return bytes.then(
    (buffer) =>
      new Promise<LoudnessReport>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve: (response) => {
            if (!response.ok || !response.analyze) {
              reject(new Error(response.error || 'Level check failed.'));
              return;
            }
            resolve(response.analyze);
          },
          reject,
        });
        try {
          const request: Omit<AnalyzeRequest, 'id'> & { id: number } = {
            kind: 'analyze',
            id,
            wav: buffer,
          };
          ensureWorker().postMessage(request, [buffer]);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
}

/**
 * Measure a take's ACX head/tail edges in the worker. Best-effort next to the
 * loudness check: silence has no edges, and the caller treats a failure as
 * "no edge data", never as a failed check.
 */
export function measureTakeEnds(wav: Blob | ArrayBuffer): Promise<AcxEnds> {
  const bytes = wav instanceof Blob ? wav.arrayBuffer() : Promise.resolve(wav);
  return bytes.then(
    (buffer) =>
      new Promise<AcxEnds>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve: (response) => {
            if (!response.ok || !response.ends) {
              reject(new Error(response.error || 'Edge check failed.'));
              return;
            }
            resolve(response.ends);
          },
          reject,
        });
        try {
          const request: Omit<EndsRequest, 'id'> & { id: number } = {
            kind: 'ends',
            id,
            wav: buffer,
          };
          ensureWorker().postMessage(request, [buffer]);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
}

/** For tests: drop the worker so the next call starts a fresh one. */
export function terminateAudioWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
