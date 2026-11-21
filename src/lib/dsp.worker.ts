// Heavy DSP tail of a narration job, off the main thread.
//
// TTS stays on the window thread (the engines manage their own workers, OPFS
// and download progress there), but assembling, mastering, shaping, speed and
// WAV encoding are pure math on big buffers — exactly the part that used to
// freeze the UI on long renders. The math here mirrors the old inline tail of
// renderNarration sample-for-sample, so moving it changes timing, not audio.
import {
  assembleSpeechWithSpans,
  type BlockSpan,
  concatSpeechWithSpans,
  masterSpeech,
  rescaleSpans,
} from './humanize';
import { applyEq, type EqBand } from './eq';
import { decodeWavPcm, encodeWav, timeStretch, transformVoice } from './audio';
import { encodeMp3Pcm } from './mp3';
import { LOUDNESS_STANDARDS, measureLoudness, type LoudnessReport } from './loudness';
import { matchSamples } from './match';
import {
  ensureAcxEnds,
  measureEnds,
  type AcxEnds,
  type AcxEndsFix,
} from './acx';

export interface DspRequest {
  kind?: 'dsp';
  id: number;
  /** Transferred: unusable on the sender side after posting. */
  blocks: Float32Array[];
  pausesMs: number[];
  sampleRate: number;
  humanize: boolean;
  strength: number;
  semitones: number;
  formant: number;
  brightness: number;
  /** Resolved on the window thread (custom styles live in localStorage). */
  eqBands: EqBand[];
  eqLevel: boolean | undefined;
  speed: number;
  /** Delivery bar to master to at render time; null/undefined skips it. */
  mastering?: string | null;
}

export interface DspResponse {
  id: number;
  ok: boolean;
  wav?: ArrayBuffer;
  rawWav?: ArrayBuffer | null;
  sampleCount?: number;
  /** Where each render block landed, in finished samples. Absent for MP3 jobs. */
  blockSpans?: BlockSpan[];
  mp3?: ArrayBuffer;
  analyze?: LoudnessReport;
  ends?: AcxEnds;
  before?: LoudnessReport;
  after?: LoudnessReport;
  beforeEnds?: AcxEnds;
  afterEnds?: AcxEnds;
  endsFix?: AcxEndsFix;
  gainDb?: number;
  peakLimited?: boolean;
  error?: string;
}

/** MP3 export of an existing take: decode its WAV, encode, send back bytes. */
export interface Mp3Request {
  kind: 'mp3';
  id: number;
  /** Transferred: unusable on the sender side after posting. */
  wav: ArrayBuffer;
  bitrate: number;
}

/** Loudness check of an existing take: decode its WAV, measure, send numbers. */
export interface AnalyzeRequest {
  kind: 'analyze';
  id: number;
  /** Transferred: unusable on the sender side after posting. */
  wav: ArrayBuffer;
}

/** Match a take to a delivery standard: decode, fix gain/peaks, re-measure. */
export interface MatchRequest {
  kind: 'match';
  id: number;
  /** Transferred: unusable on the sender side after posting. */
  wav: ArrayBuffer;
  standardId: string;
}

/** Measure ACX head/tail edges of an existing take: decode, measure, send ms. */
export interface EndsRequest {
  kind: 'ends';
  id: number;
  /** Transferred: unusable on the sender side after posting. */
  wav: ArrayBuffer;
}

const scope = self as unknown as {
  onmessage:
    | ((event: MessageEvent<DspRequest | Mp3Request | AnalyzeRequest | MatchRequest | EndsRequest>) => void)
    | null;
  postMessage: (message: DspResponse, options?: { transfer?: Transferable[] }) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.kind === 'analyze') {
      // One linear pass over minutes of audio; the window thread never feels it.
      const pcm = decodeWavPcm(request.wav);
      const analyze = measureLoudness(pcm.samples, pcm.sampleRate);
      let ends: AcxEnds | undefined;
      try {
        ends = measureEnds(pcm.samples, pcm.sampleRate);
      } catch {
        ends = undefined;
      }
      scope.postMessage({ id: request.id, ok: true, analyze, ...(ends ? { ends } : {}) });
      return;
    }
    if (request.kind === 'ends') {
      const pcm = decodeWavPcm(request.wav);
      const ends = measureEnds(pcm.samples, pcm.sampleRate);
      scope.postMessage({ id: request.id, ok: true, ends });
      return;
    }
    if (request.kind === 'match') {
      const pcm = decodeWavPcm(request.wav);
      const before = measureLoudness(pcm.samples, pcm.sampleRate);
      const standard =
        LOUDNESS_STANDARDS.find((entry) => entry.id === request.standardId) ?? LOUDNESS_STANDARDS[0];
      let beforeEnds: AcxEnds | undefined;
      try {
        beforeEnds = measureEnds(pcm.samples, pcm.sampleRate);
      } catch {
        beforeEnds = undefined;
      }
      // Edges first, gain second: padding silence after the gain is planned
      // would dilute the RMS back out of the window on short takes. The room
      // tone is read off the pre-gain audio — gain changes nothing about
      // which window is quietest.
      let samples: Float32Array = pcm.samples.slice();
      let endsFix: AcxEndsFix | undefined;
      if (standard.id === 'audiobook') {
        const fixed = ensureAcxEnds(samples, pcm.sampleRate);
        samples = fixed.samples;
        endsFix = fixed.fix;
      }
      const { gainDb, peakLimited } = matchSamples(samples, pcm.sampleRate, standard);
      const wav = encodeWav(samples, pcm.sampleRate);
      const after = measureLoudness(samples, pcm.sampleRate);
      let afterEnds: AcxEnds | undefined;
      try {
        afterEnds = measureEnds(samples, pcm.sampleRate);
      } catch {
        afterEnds = undefined;
      }
      scope.postMessage(
        {
          id: request.id,
          ok: true,
          wav,
          before,
          after,
          gainDb,
          peakLimited,
          ...(beforeEnds ? { beforeEnds } : {}),
          ...(afterEnds ? { afterEnds } : {}),
          ...(endsFix ? { endsFix } : {}),
        },
        { transfer: [wav] },
      );
      return;
    }
    if (request.kind === 'mp3') {
      // Long takes encode for seconds; this thread is the background one.
      const pcm = decodeWavPcm(request.wav);
      const mp3 = encodeMp3Pcm(pcm.samples, pcm.sampleRate, request.bitrate);
      scope.postMessage({ id: request.id, ok: true, mp3 }, { transfer: [mp3] });
      return;
    }
    const assembledSpeech = request.humanize
      ? assembleSpeechWithSpans(request.blocks, request.pausesMs, request.sampleRate, {
          strength: request.strength,
        })
      : concatSpeechWithSpans(request.blocks, request.sampleRate * 0.14);
    const assembled = assembledSpeech.audio;

    const beforeShape = request.humanize
      ? masterSpeech(assembled, request.sampleRate, { strength: request.strength })
      : assembled;

    const shaping =
      Math.abs(request.semitones) > 0.05 ||
      Math.abs(request.formant) > 0.01 ||
      Math.abs(request.brightness) > 0.01;
    const needsShape = shaping || request.eqBands.length > 0;

    let samples = beforeShape;
    if (needsShape) {
      const pitched = shaping
        ? transformVoice(beforeShape, request.sampleRate, {
            semitones: request.semitones,
            formant: request.formant,
            brightness: request.brightness,
          })
        : beforeShape;
      samples =
        request.eqBands.length > 0
          ? applyEq(pitched, request.sampleRate, request.eqBands, { compress: request.eqLevel })
          : pitched;
    }

    const needsSpeed = Math.abs(request.speed - 1) > 0.01;
    // Unshaped copy for the A/B. It follows the same speed change, so both
    // sides stay the same length.
    const rawSamples = needsShape
      ? needsSpeed
        ? timeStretch(beforeShape, 1 / request.speed, request.sampleRate)
        : beforeShape
      : null;

    // Word timings are measured on the blocks, so carry their spans through
    // the tail: shaping and the global speed change only ever rescale the
    // whole mix, so one linear map per stage keeps every span placed for
    // cueing (within tens of milliseconds).
    let spans = rescaleSpans(assembledSpeech.spans, beforeShape.length, samples.length);

    if (needsSpeed) {
      const preSpeedLength = samples.length;
      samples = timeStretch(samples, 1 / request.speed, request.sampleRate);
      spans = rescaleSpans(spans, preSpeedLength, samples.length);
    }

    // Preset mastering: the same honest fix as Match (compress, gain to the
    // window centre, peak ceiling), but at render time so the take lands in
    // spec. Silence has nothing to fix — matchSamples refuses it, and a
    // render of real speech is never silent, so let that error end the job
    // instead of shipping silence. Audiobook renders also get the ACX
    // head/tail (0.75 s / 2 s, silence for synth takes): the old tail shipped
    // ~40 ms edges, a guaranteed reject. Edges go in before the gain so the
    // planned level includes the padding, and the block spans shift by the
    // added head so word timings stay placed.
    if (request.mastering) {
      const standard =
        LOUDNESS_STANDARDS.find((entry) => entry.id === request.mastering) ??
        LOUDNESS_STANDARDS[0];
      if (standard.id === 'audiobook') {
        const fixed = ensureAcxEnds(samples, request.sampleRate);
        const headDelta = Math.round((fixed.fix.headDeltaMs / 1000) * request.sampleRate);
        samples = fixed.samples;
        if (headDelta !== 0) {
          spans = spans.map((span) => ({ start: span.start + headDelta, end: span.end + headDelta }));
        }
      }
      matchSamples(samples, request.sampleRate, standard);
    }

    const wav = encodeWav(samples, request.sampleRate);
    const rawWav = rawSamples ? encodeWav(rawSamples, request.sampleRate) : null;
    const transfer: Transferable[] = [wav];
    if (rawWav) transfer.push(rawWav);
    scope.postMessage(
      {
        id: request.id,
        ok: true,
        wav,
        rawWav,
        sampleCount: samples.length,
        blockSpans: spans,
      },
      { transfer },
    );
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
