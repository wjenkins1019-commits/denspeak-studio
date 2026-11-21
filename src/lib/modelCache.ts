// Disk use of downloaded transcription models.
//
// Whisper runs with the renderer's browser cache (Cache Storage, key
// `transformers-cache`), one entry per Hub file URL. Sizes come from the stored
// content-length headers, so measuring never re-reads model bodies. Entries
// whose URL contains none of the known transcription model ids (e.g. the
// cloned-voice engine's files, which share the cache) count as other.
import { TRANSCRIBE_MODELS } from './transcribe';

const CACHE_KEY = 'transformers-cache';

export interface TranscriptionCacheEntry {
  id: string;
  label: string;
  bytes: number;
  files: number;
}

export interface TranscriptionCacheUsage {
  models: TranscriptionCacheEntry[];
  otherBytes: number;
  otherFiles: number;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE_KEY);
  } catch {
    return null;
  }
}

/** Bytes per cached transcription model, plus anything else in the cache. */
export async function transcriptionCacheUsage(): Promise<TranscriptionCacheUsage> {
  const empty: TranscriptionCacheUsage = { models: [], otherBytes: 0, otherFiles: 0 };
  const cache = await openCache();
  if (!cache) return empty;
  try {
    const totals = new Map<string, { bytes: number; files: number }>();
    let otherBytes = 0;
    let otherFiles = 0;
    const keys = await cache.keys();
    for (const request of keys) {
      const url = request.url;
      const model = TRANSCRIBE_MODELS.find((entry) => url.includes(entry.id));
      let bytes = 0;
      try {
        const response = await cache.match(request);
        const header = response?.headers.get('content-length');
        const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
        bytes = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      } catch {
        // An unreadable entry still counts as a file, just with unknown size.
      }
      if (model) {
        const total = totals.get(model.id) ?? { bytes: 0, files: 0 };
        total.bytes += bytes;
        total.files += 1;
        totals.set(model.id, total);
      } else {
        otherBytes += bytes;
        otherFiles += 1;
      }
    }
    return {
      models: TRANSCRIBE_MODELS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        bytes: totals.get(entry.id)?.bytes ?? 0,
        files: totals.get(entry.id)?.files ?? 0,
      })),
      otherBytes,
      otherFiles,
    };
  } catch {
    return empty;
  }
}

/** Forget one transcription model: its files download again when next used. */
export async function removeTranscriptionModel(id: string): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  try {
    const keys = await cache.keys();
    await Promise.all(
      keys.filter((request) => request.url.includes(id)).map((request) => cache.delete(request)),
    );
  } catch {
    // Best effort; the refresh after this shows what is left.
  }
}

/** Forget every cached transcription file, including other engines' files. */
export async function clearTranscriptionCache(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    await caches.delete(CACHE_KEY);
  } catch {
    // Best effort; the refresh after this shows what is left.
  }
}

/** Whole-origin estimate (models, takes, caches) when the browser reports it. */
export async function estimateStorage(): Promise<{ usage?: number; quota?: number }> {
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage, quota: estimate.quota };
  } catch {
    return {};
  }
}
