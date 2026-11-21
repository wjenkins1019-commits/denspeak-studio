// One narration job in two halves.
//
// The speech blocks are rendered on the window thread (the engines manage
// their own workers, OPFS and download progress there); everything after that
// — assembling, mastering, shaping, speed, WAV encoding — runs in the DSP
// worker, so long renders no longer freeze the UI. The render queue drives
// both halves; there is no other caller.
import { renderSpeech } from './tts';
import { decodeToMono } from './audio';
import { synthesizeWithClonedVoice } from './clone';
import { planSpeech, planVoicedBlocks, trimSilence } from './humanize';
import type { CastMember } from './cast';
import { finishAudio } from './dspClient';
import type { EqBand } from './eq';

export interface NarrationVoice {
  baseVoiceId: string;
  isClone: boolean;
  cloneName: string;
}

export interface NarrationSettings {
  voice: NarrationVoice;
  speed: number;
  humanize: boolean;
  strength: number;
  expressiveness: number;
  semitones: number;
  formant: number;
  brightness: number;
  eqPresetId: string;
  /**
   * The bands as they were on the graph when the job was queued. Absent on jobs
   * from older builds, which then fall back to the preset's own bands.
   */
  eqBands?: EqBand[];
  eqLevel?: boolean;
  /**
   * Delivery bar mastered at render time ('audiobook' | 'ad'). Set by the
   * render presets; null/undefined means no mastering, exactly the old path.
   * Part of the fingerprint, so changing it re-renders instead of adopting a
   * stale take.
   */
  mastering?: string | null;
  /**
   * Multi-voice cast: tagged paragraphs render in their cast voice.
   * Part of the fingerprint, so a cast edit re-renders instead of adopting
   * a stale take. Absent on jobs from older builds, which render single-voice.
   */
  cast?: CastMember[];
}

export interface NarrationUpdate {
  status: string;
  /** 0..1 model-download progress, or null when not downloading. */
  download: number | null;
  /** Paragraphs finished / total. */
  block: number;
  blocks: number;
}

export interface SpeechBlocks {
  blocks: Float32Array[];
  pausesMs: number[];
  sampleRate: number;
  /** The exact text read into each block, in order. Tags already stripped. */
  blockTexts: string[];
  /** Cast display name per block, in order; null means plain narration. */
  blockSpeakers: (string | null)[];
}

export interface FinishedNarration {
  wav: Blob;
  /** Unshaped copy for the A/B view; null when nothing was shaped. */
  rawWav: Blob | null;
  sampleRate: number;
  duration: number;
  /** Where each render block landed, in finished samples. */
  blockSpans: { start: number; end: number }[];
}

/** Thrown when `shouldCancel` fires; the queue treats this as a clean stop. */
export class NarrationCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'NarrationCancelled';
  }
}

export interface ResumeState {
  /** Paragraphs the queue already finished (e.g. reloaded from checkpoints). */
  done: Map<number, { samples: Float32Array; sampleRate: number }>;
  /** Called for every newly rendered paragraph so the queue can checkpoint it. */
  onBlock?: (index: number, samples: Float32Array, sampleRate: number) => void;
}

/** Render every paragraph to trimmed blocks. Stays on the window thread. */
export async function renderSpeechBlocks(
  text: string,
  settings: NarrationSettings,
  onUpdate?: (update: NarrationUpdate) => void,
  shouldCancel?: () => boolean,
  resume?: ResumeState,
): Promise<SpeechBlocks> {
  const report = (status: string, download: number | null = null, block = 0, blocks = 0) =>
    onUpdate?.({ status, download, block, blocks });

  const plan =
    settings.cast && settings.cast.length > 0
      ? planVoicedBlocks(text, settings.cast)
      : planSpeech(text).map((block) => ({
          ...block,
          voiceId: null as string | null,
          speaker: null as string | null,
        }));
  const blocks: Float32Array[] = [];
  let sampleRate = 22050;

  for (let index = 0; index < plan.length; index += 1) {
    if (shouldCancel?.()) throw new NarrationCancelled();
    const cached = resume?.done.get(index);
    if (cached) {
      // A reloaded job: the paragraph is already on disk, count it and move on.
      blocks.push(cached.samples);
      sampleRate = cached.sampleRate;
      report(`Rendering ${index + 1} of ${plan.length}…`, null, index, plan.length);
      continue;
    }
    const of = plan.length > 1 ? ` ${index + 1} of ${plan.length}` : '';
    report(`Rendering${of}…`, null, index, plan.length);

    let trimmed: Float32Array;
    // A tagged block carries its bank voice; null keeps the job's own voice,
    // clone default included.
    const override = plan[index].voiceId;
    const voice = override
      ? { baseVoiceId: override, isClone: false, cloneName: '' }
      : settings.voice;
    if (voice.isClone) {
      const speech = await synthesizeWithClonedVoice({
        text: plan[index].text,
        voiceName: voice.cloneName,
        expressiveness: settings.expressiveness,
      });
      sampleRate = speech.sampleRate;
      trimmed = trimSilence(speech.samples, speech.sampleRate);
    } else {
      const wav = await renderSpeech(plan[index].text, voice.baseVoiceId, (update) => {
        const file = update.url.split('/').pop() ?? 'model';
        report(
          `Downloading ${file}${of}…`,
          update.total > 0 ? update.loaded / update.total : null,
          index,
          plan.length,
        );
      });
      const decoded = await decodeToMono(wav);
      sampleRate = decoded.sampleRate;
      trimmed = trimSilence(decoded.samples, decoded.sampleRate);
    }
    blocks.push(trimmed);
    resume?.onBlock?.(index, trimmed, sampleRate);
  }

  return {
    blocks,
    pausesMs: plan.map((block) => block.pauseAfterMs),
    sampleRate,
    blockTexts: plan.map((block) => block.text),
    blockSpeakers: plan.map((block) => block.speaker),
  };
}

/**
 * Assemble, master, shape, speed and encode in the DSP worker. `eq` is
 * resolved by the caller: custom styles live in localStorage, which workers
 * cannot read.
 */
export async function finishBlocks(
  speech: SpeechBlocks,
  settings: NarrationSettings,
  eq: { bands: EqBand[]; level: boolean | undefined },
  onUpdate?: (status: string) => void,
): Promise<FinishedNarration> {
  onUpdate?.(settings.humanize ? 'Shaping the read…' : 'Assembling audio…');
  const finished = await finishAudio({
    blocks: speech.blocks,
    pausesMs: speech.pausesMs,
    sampleRate: speech.sampleRate,
    humanize: settings.humanize,
    strength: settings.strength,
    semitones: settings.semitones,
    formant: settings.formant,
    brightness: settings.brightness,
    eqBands: eq.bands,
    eqLevel: eq.level,
    speed: settings.speed,
    mastering: settings.mastering ?? null,
  });
  return {
    wav: finished.wav,
    rawWav: finished.rawWav,
    sampleRate: finished.sampleRate,
    duration: finished.sampleCount / finished.sampleRate,
    blockSpans: finished.blockSpans,
  };
}
