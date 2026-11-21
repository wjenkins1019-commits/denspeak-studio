import {
  formatSRT,
  formatVTT,
  normalizeWords,
  wordsToCues,
  type TimedChunk,
} from './captions';
import type { Take } from './library';

export interface StoredCaptions {
  srt: string;
  vtt: string;
}

/**
 * Takes eligible for backfill: everything without stored cues except Song
 * mixes (a mix blob is not the take's timing, so persisting it would corrupt
 * the take — same reason the Player skips the write-back for songs).
 */
export function needsCaptions(take: Take): boolean {
  return take.kind !== 'song' && !take.captions;
}

export interface BackfillProgress {
  /** Takes finished (saved or failed) so far. */
  done: number;
  total: number;
  currentName: string;
  status: string;
}

export interface BackfillResult {
  captioned: number;
  failed: { name: string; error: string }[];
  cancelled: boolean;
}

/**
 * Caption every take missing cues, one at a time: the transcription worker
 * runs a single job anyway, and sequential keeps memory flat on long
 * libraries. One take's failure never stops the rest; the caller reports the
 * failures together at the end.
 */
export async function backfillMissingCaptions(
  takes: Take[],
  model: string,
  deps: {
    transcribeTimed: (
      blob: Blob,
      model: string,
      onProgress?: (progress: { status: string; percent: number | null }) => void,
    ) => Promise<TimedChunk[]>;
    saveCaptions: (id: string, captions: StoredCaptions) => Promise<void>;
    onProgress?: (progress: BackfillProgress) => void;
    shouldCancel?: () => boolean;
  },
): Promise<BackfillResult> {
  const queue = takes.filter(needsCaptions);
  const result: BackfillResult = { captioned: 0, failed: [], cancelled: false };

  for (let index = 0; index < queue.length; index += 1) {
    if (deps.shouldCancel?.()) {
      result.cancelled = true;
      break;
    }
    const take = queue[index];
    deps.onProgress?.({ done: index, total: queue.length, currentName: take.name, status: 'Starting…' });
    try {
      const chunks = await deps.transcribeTimed(take.blob, model, (progress) => {
        deps.onProgress?.({
          done: index,
          total: queue.length,
          currentName: take.name,
          status: progress.status,
        });
      });
      if (deps.shouldCancel?.()) {
        result.cancelled = true;
        break;
      }
      const cues = wordsToCues(normalizeWords(chunks));
      if (cues.length === 0) throw new Error('Could not hear any speech to caption.');
      await deps.saveCaptions(take.id, { srt: formatSRT(cues), vtt: formatVTT(cues) });
      result.captioned += 1;
    } catch (error) {
      result.failed.push({
        name: take.name,
        error: error instanceof Error ? error.message : 'Captioning failed.',
      });
    }
    deps.onProgress?.({
      done: index + 1,
      total: queue.length,
      currentName: take.name,
      status: 'Done.',
    });
  }

  return result;
}
