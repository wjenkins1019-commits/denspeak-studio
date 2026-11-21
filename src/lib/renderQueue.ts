// Global background render queue.
//
// Every long render — a Studio narration or an audiobook chapter — is a job
// here instead of a component-local loop. Jobs survive navigation (the runner
// lives in this module, not in a view) and reloads (descriptors and finished
// paragraphs persist in IndexedDB), report progress to any subscriber, and
// can be cancelled between paragraphs or while a model downloads. Heavy DSP
// already runs in the audio worker; the queue keeps the TTS half ordered so
// the engines are never driven two at a time.
import { useSyncExternalStore } from 'react';
import {
  NarrationCancelled,
  finishBlocks,
  renderSpeechBlocks,
  type NarrationSettings,
} from './narrate';
import { describeCloneError } from './clone';
import { notifyRenderFinished } from './notify';
import { styleById } from './eq';
import { listTakes, saveTake, type Take } from './library';
import {
  applyBoundaries,
  formatSRT,
  formatVTT,
  splitCaptionWords,
  wordBoundaryFractions,
  wordsToCues,
  type TimedWord,
} from './captions';
import type { ParsedBook } from './ebook';
import {
  checkpointKey,
  deleteCheckpoints,
  deleteCheckpointsNotIn,
  deleteJob as deletePersistedJob,
  jobFingerprint,
  loadAudiobook,
  loadCheckpoints,
  loadJobs,
  saveAudiobook,
  saveCheckpoint,
  saveJob,
  type PersistedJob,
} from './queuePersist';

export type QueueJobState = 'queued' | 'working' | 'done' | 'failed' | 'cancelled';

export interface QueueJob {
  /** Stable across reloads, so checkpoints stay attached to their job. */
  id: string;
  /** 'studio' for single narrations, 'audiobook:<key>' for book chapters. */
  group: string;
  /** Chapter index, or -1 for a single narration. */
  chapterIndex: number;
  /** Short label for progress displays, e.g. "Chapter 3 — Name". */
  label: string;
  takeName: string;
  text: string;
  settings: NarrationSettings;
  voiceId: string;
  voiceName?: string;
  /** Fingerprint of text + settings + voice; matches takes and checkpoints. */
  sourceHash: string;
  state: QueueJobState;
  status: string;
  download: number | null;
  block: number;
  blocks: number;
  error?: string;
  take?: Take;
  /** Unshaped copy for the A/B view; null when nothing was shaped. */
  rawBlob?: Blob | null;
  cancelRequested: boolean;
}

export interface QueueJobInput {
  group: string;
  chapterIndex: number;
  label: string;
  takeName: string;
  text: string;
  settings: NarrationSettings;
  voiceId: string;
  voiceName?: string;
}

let jobs: QueueJob[] = [];
let version = 0;
let running = false;
let restoreStarted = false;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

/** Re-render subscribers whenever the queue changes. */
export function useRenderQueue(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

export function getJobs(): QueueJob[] {
  return jobs;
}

export function getActiveJob(): QueueJob | undefined {
  return jobs.find((job) => job.state === 'working') ?? jobs.find((job) => job.state === 'queued');
}

/**
 * The book behind the audiobook card. Views unmount on navigation, so this
 * lives here next to the jobs: returning to Studio mid-run restores the
 * chapter list instead of a blank card. Cleared with the group; takes already
 * saved stay in the library either way.
 */
let audiobook: { title: string; book: ParsedBook } | null = null;

export function getAudiobook(): { title: string; book: ParsedBook } | null {
  return audiobook;
}

export function setAudiobook(next: { title: string; book: ParsedBook } | null): void {
  audiobook = next;
  emit();
  void saveAudiobook(next);
}

function toPersistedJob(job: QueueJob): PersistedJob {
  return {
    id: job.id,
    group: job.group,
    chapterIndex: job.chapterIndex,
    label: job.label,
    takeName: job.takeName,
    text: job.text,
    settings: job.settings,
    voiceId: job.voiceId,
    voiceName: job.voiceName,
    sourceHash: job.sourceHash,
    state: job.state === 'failed' ? 'failed' : job.state === 'working' ? 'working' : job.state === 'done' ? 'done' : 'queued',
    takeId: job.take?.id,
    error: job.error,
    block: job.block,
    blocks: job.blocks,
    status: job.status,
    cancelRequested: job.cancelRequested,
  };
}

/** Queue jobs, replacing any unfinished job for the same chapter slot. */
export function enqueueJobs(inputs: QueueJobInput[]): string[] {
  const slotOf = (group: string, chapterIndex: number): string => `${group}	${chapterIndex}`;
  const keys = new Set(inputs.map((input) => slotOf(input.group, input.chapterIndex)));
  // Other groups' jobs (a narration behind an audiobook, or vice versa) simply
  // wait their turn; only the same chapter slots are replaced. Done jobs are
  // replaced too, so a restored 'done' never shadows a fresh render.
  const dropped = jobs.filter((job) => keys.has(slotOf(job.group, job.chapterIndex)));
  jobs = jobs.filter((job) => !keys.has(slotOf(job.group, job.chapterIndex)));
  for (const job of dropped) {
    void deletePersistedJob(job.id);
    void deleteCheckpoints(job.id);
  }
  const ids: string[] = [];
  for (const input of inputs) {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    ids.push(id);
    const job: QueueJob = {
      ...input,
      id,
      sourceHash: jobFingerprint(input),
      state: 'queued',
      status: 'Queued…',
      download: null,
      block: 0,
      blocks: 0,
      cancelRequested: false,
    };
    jobs.push(job);
    void saveJob(toPersistedJob(job));
  }
  emit();
  void ensureRunning();
  return ids;
}

export function cancelJob(id: string): void {
  const job = jobs.find((entry) => entry.id === id);
  if (job && (job.state === 'queued' || job.state === 'working')) {
    job.cancelRequested = true;
    void saveJob(toPersistedJob(job));
  }
  emit();
}

export function cancelGroup(group: string): void {
  for (const job of jobs) {
    if (job.group === group && (job.state === 'queued' || job.state === 'working')) {
      job.cancelRequested = true;
      void saveJob(toPersistedJob(job));
    }
  }
  emit();
}

/** Forget a book's (or the Studio's) jobs entirely; takes already saved stay. */
export function clearGroup(group: string): void {
  const removed = jobs.filter((job) => job.group === group);
  jobs = jobs.filter((job) => job.group !== group);
  for (const job of removed) {
    void deletePersistedJob(job.id);
    void deleteCheckpoints(job.id);
  }
  emit();
}

async function runJob(job: QueueJob): Promise<void> {
  job.state = 'working';
  job.status = 'Preparing voice…';
  job.download = null;
  emit();
  void saveJob(toPersistedJob(job));

  const update = (status: string, download: number | null, block: number, blocks: number) => {
    job.status = status;
    job.download = download;
    job.block = block;
    job.blocks = blocks;
    emit();
  };

  // Cancelled jobs leave nothing behind: no descriptor, no checkpoints.
  const finishPersisted = (): void => {
    void deletePersistedJob(job.id);
    void deleteCheckpoints(job.id);
  };

  try {
    // A previous run may have saved the take before the interruption (reload
    // between save and state update, or a retried duplicate). The fingerprint
    // proves the take is this exact render, so adopt it instead of doubling it.
    try {
      const takes = await listTakes();
      const match = takes.find(
        (take) =>
          take.kind === 'render' && take.name === job.takeName && take.sourceHash === job.sourceHash,
      );
      if (match && !job.cancelRequested) {
        job.take = match;
        job.rawBlob = null;
        job.state = 'done';
        job.status = 'Saved to your library.';
        job.download = null;
        emit();
        notifyRenderFinished({ takeName: job.takeName, ok: true });
        void saveJob(toPersistedJob(job));
        void deleteCheckpoints(job.id);
        return;
      }
    } catch {
      // The library is unreadable; render anyway rather than refusing.
    }

    // Paragraphs checkpointed before the interruption are already on disk.
    const cached = new Map<number, { samples: Float32Array; sampleRate: number }>();
    try {
      const records = await loadCheckpoints(job.id);
      for (const record of records) {
        if (record.fingerprint === job.sourceHash) {
          cached.set(record.index, { samples: record.samples, sampleRate: record.sampleRate });
        }
      }
    } catch {
      // Checkpoints are best-effort; without them the job renders from zero.
    }
    if (cached.size > 0 && !job.cancelRequested) {
      job.status = `Resumed — ${cached.size} part${cached.size === 1 ? '' : 's'} already done…`;
      emit();
    }

    const speech = await renderSpeechBlocks(
      job.text,
      job.settings,
      (progress) => update(progress.status, progress.download, progress.block, progress.blocks),
      () => job.cancelRequested,
      {
        done: cached,
        onBlock: (index, samples, sampleRate) => {
          void saveCheckpoint({
            key: checkpointKey(job.id, index),
            jobId: job.id,
            index,
            fingerprint: job.sourceHash,
            samples,
            sampleRate,
          });
          void saveJob(toPersistedJob(job));
        },
      },
    );
    if (job.cancelRequested) throw new NarrationCancelled();

    // Word timings are measured on the blocks here: finishBlocks transfers
    // the buffers to the worker, which neuters them on this side. Fractions
    // survive the trip; the finished spans place them on the take.
    const boundaries = speech.blockTexts.map((text, index) =>
      wordBoundaryFractions(
        splitCaptionWords(text),
        speech.blocks[index] ?? new Float32Array(0),
        speech.sampleRate,
      ),
    );

    // The job carries the bands it was queued with, so tweaking the graph after
    // pressing Render cannot change a take that is already in the queue.
    const style = styleById(job.settings.eqPresetId);
    const finished = await finishBlocks(
      speech,
      job.settings,
      { bands: job.settings.eqBands ?? style.bands, level: job.settings.eqLevel ?? style.level },
      (status) => update(status, null, job.blocks, job.blocks),
    );
    if (job.cancelRequested) throw new NarrationCancelled();

    // Captions from the synthesis itself: the script's own words (never
    // misheard), placed on the real block spans with energy-snapped word
    // cuts. Instant and offline — no transcription pass. Measured accuracy:
    // word cuts land within ~60 ms of the true gaps on average (~200 ms
    // worst case near stop consonants); see the benchmark in captions.test.
    const timed: TimedWord[] = [];
    for (let index = 0; index < speech.blockTexts.length; index += 1) {
      const words = splitCaptionWords(speech.blockTexts[index]);
      const span = finished.blockSpans[index];
      if (!span || words.length === 0) continue;
      timed.push(
        ...applyBoundaries(
          words,
          boundaries[index],
          span.start / finished.sampleRate,
          span.end / finished.sampleRate,
          speech.blockSpeakers[index] ?? null,
        ),
      );
    }
    const cues = wordsToCues(timed);
    const take = await saveTake({
      name: job.takeName,
      duration: finished.duration,
      kind: 'render',
      voiceId: job.voiceId,
      voiceName: job.voiceName,
      sourceHash: job.sourceHash,
      blob: finished.wav,
      ...(cues.length > 0 ? { captions: { srt: formatSRT(cues), vtt: formatVTT(cues) } } : {}),
    });
    job.take = take;
    job.rawBlob = finished.rawWav;
    job.state = 'done';
    notifyRenderFinished({ takeName: job.takeName, ok: true });
    job.status = 'Saved to your library.';
    job.download = null;
    // Done descriptors persist (with the take id) so chapter state survives a
    // reload; only the bulky checkpoints are dropped.
    void saveJob(toPersistedJob(job));
    void deleteCheckpoints(job.id);
  } catch (problem) {
    if (problem instanceof NarrationCancelled || job.cancelRequested) {
      job.state = 'cancelled';
      job.status = 'Cancelled.';
      finishPersisted();
    } else {
      job.state = 'failed';
      job.error = describeCloneError(problem);
      notifyRenderFinished({ takeName: job.takeName, ok: false, error: job.error });
      job.status = 'Failed.';
      void saveJob(toPersistedJob(job));
    }
    job.download = null;
  }
  emit();
}

async function ensureRunning(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = jobs.find((job) => job.state === 'queued');
      if (!next) return;
      await runJob(next);
    }
  } finally {
    running = false;
  }
}

/**
 * Reload descriptors, the audiobook, and take matches after a restart, then
 * resume the queue. Runs once at module load; a requested cancel that never
 * landed is honoured, and takes already saved are adopted instead of doubled.
 */
async function restoreQueue(): Promise<void> {
  if (restoreStarted) return;
  restoreStarted = true;

  const book = await loadAudiobook();
  if (book) audiobook = book;

  let saved: PersistedJob[] = [];
  try {
    saved = await loadJobs();
  } catch {
    saved = [];
  }
  if (saved.length === 0) {
    emit();
    return;
  }

  let takes: Take[] = [];
  try {
    takes = await listTakes();
  } catch {
    takes = [];
  }

  const live = new Set<string>();
  for (const record of saved) {
    if (record.state !== 'queued' && record.state !== 'working' && record.state !== 'failed' && record.state !== 'done') {
      continue;
    }
    if (record.cancelRequested) {
      jobs.push({
        ...record,
        take: undefined,
        rawBlob: null,
        state: 'cancelled',
        status: 'Cancelled.',
        download: null,
        cancelRequested: false,
      });
      void deletePersistedJob(record.id);
      void deleteCheckpoints(record.id);
      continue;
    }
    // Prefer the exact take by id; fall back to the fingerprint match for a
    // take saved after the last descriptor write.
    const match =
      takes.find((take) => take.id === record.takeId) ??
      takes.find(
        (take) =>
          take.kind === 'render' && take.name === record.takeName && take.sourceHash === record.sourceHash,
      );
    if (match) {
      jobs.push({
        ...record,
        take: match,
        rawBlob: null,
        state: 'done',
        status: 'Saved to your library.',
        download: null,
        cancelRequested: false,
      });
      void deleteCheckpoints(record.id);
      continue;
    }
    if (record.state === 'done') {
      // Its take is gone (deleted from the library); drop the husk.
      void deletePersistedJob(record.id);
      continue;
    }
    jobs.push({
      ...record,
      take: undefined,
      rawBlob: null,
      state: record.state === 'failed' ? 'failed' : 'queued',
      status: record.state === 'failed' ? 'Failed.' : 'Queued — resumes after reload.',
      download: null,
      cancelRequested: false,
    });
    live.add(record.id);
  }

  // Checkpoints whose job finished between its last write and the
  // interruption would otherwise linger; drop anything unclaimed.
  await deleteCheckpointsNotIn(live);

  emit();
  void ensureRunning();
}

void restoreQueue();
