import { checkLoudness, LOUDNESS_STANDARDS, type LoudnessReport } from './loudness';
import { checkEnds, ENDS_FIX_NOTE_MIN_MS, type AcxEnds, type AcxEndsFix } from './acx';
import type { Take } from './library';

export interface BatchMatchedAudio {
  wav: Blob;
  before: LoudnessReport;
  after: LoudnessReport;
  gainDb: number;
  peakLimited: boolean;
  /** ACX edge fix, present when an audiobook match moved the edges. */
  endsFix?: AcxEndsFix;
}

export type BatchMatchStatus = 'passed' | 'matched' | 'needs-work' | 'failed';

export interface BatchMatchEntry {
  id: string;
  name: string;
  status: BatchMatchStatus;
  before?: LoudnessReport;
  after?: LoudnessReport;
  gainDb?: number;
  peakLimited?: boolean;
  savedName?: string;
  /** Short edge-fix note for audiobook matches, e.g. who the fill came from. */
  endsNote?: string;
  /** True when the take's stored captions rode the ACX head shift onto the copy. */
  captionsShifted?: boolean;
  error?: string;
}

export interface BatchMatchProgress {
  done: number;
  total: number;
  currentName: string;
  status: string;
}

export interface BatchMatchResult {
  entries: BatchMatchEntry[];
  matched: number;
  passed: number;
  needsWork: number;
  failed: number;
  cancelled: boolean;
}

/**
 * Takes eligible for batch Match: everything except Song mixes. A mix is
 * mastered music, not a voice take, so Audiobook/Ad Spot bars don't apply —
 * same exclusion the caption backfill uses.
 */
export function isMatchableTake(take: Take): boolean {
  return take.kind !== 'song';
}

export interface BatchMatchDeps {
  analyze: (blob: Blob) => Promise<LoudnessReport>;
  /** ACX edges for audiobook takes; absent keeps the old loudness-only pass. */
  measureEndsAudio?: (blob: Blob) => Promise<AcxEnds>;
  matchAudio: (blob: Blob, standardId: string) => Promise<BatchMatchedAudio>;
  saveMatched: (
    take: Take,
    matched: BatchMatchedAudio,
    savedName: string,
  ) => Promise<unknown>;
  onProgress?: (progress: BatchMatchProgress) => void;
  shouldCancel?: () => boolean;
}

/**
 * Bring every matchable take into spec, one at a time: the audio worker is a
 * single thread and sequential keeps memory flat on long libraries. Takes
 * already inside the standard are reported as passed with no new take; a
 * failing take gets matched and saved as a `processed` copy (the original is
 * never touched, captions and voice travel onto the copy). A take whose
 * fixed audio still fails — usually recorded room tone no gain can remove —
 * is saved but reported as needs-work, honestly. One take's failure never
 * stops the rest.
 */
export async function batchMatchTakes(
  takes: Take[],
  standardId: string,
  deps: BatchMatchDeps,
): Promise<BatchMatchResult> {
  const standard =
    LOUDNESS_STANDARDS.find((entry) => entry.id === standardId) ?? LOUDNESS_STANDARDS[0];
  const queue = takes.filter(isMatchableTake);
  const entries: BatchMatchEntry[] = [];
  const result: BatchMatchResult = {
    entries,
    matched: 0,
    passed: 0,
    needsWork: 0,
    failed: 0,
    cancelled: false,
  };

  for (let index = 0; index < queue.length; index += 1) {
    if (deps.shouldCancel?.()) {
      result.cancelled = true;
      break;
    }
    const take = queue[index];
    deps.onProgress?.({
      done: index,
      total: queue.length,
      currentName: take.name,
      status: 'Checking…',
    });
    try {
      const before = await deps.analyze(take.blob);
      if (deps.shouldCancel?.()) {
        result.cancelled = true;
        break;
      }
      if (checkLoudness(before, standard).verdict === 'pass') {
        // Audiobook takes must also hold the ACX head/tail windows: a take
        // with good levels but 40 ms edges is not shippable, so it matches
        // instead of passing. Edges are best-effort like LevelCheck — an
        // unreadable take (silence) falls back to the loudness verdict.
        let edgesOk = true;
        if (standard.id === 'audiobook' && deps.measureEndsAudio) {
          try {
            const ends = await deps.measureEndsAudio(take.blob);
            if (deps.shouldCancel?.()) {
              result.cancelled = true;
              break;
            }
            edgesOk = checkEnds(ends).verdict === 'pass';
          } catch {
            edgesOk = true;
          }
        }
        if (edgesOk) {
          entries.push({ id: take.id, name: take.name, status: 'passed', before });
          result.passed += 1;
          continue;
        }
        // Else fall through to matching below.
      }
      deps.onProgress?.({
        done: index,
        total: queue.length,
        currentName: take.name,
        status: 'Matching…',
      });
      const matched = await deps.matchAudio(take.blob, standard.id);
      if (deps.shouldCancel?.()) {
        result.cancelled = true;
        break;
      }
      const savedName = `${take.name} — ${standard.name} match`;
      await deps.saveMatched(take, matched, savedName);
      // The copy is saved with shifted captions either way, so one shared
      // gate feeds the matched and needs-work branches below.
      const endsFix = matched.endsFix;
      const edgesMoved =
        standard.id === 'audiobook' &&
        endsFix !== undefined &&
        (Math.abs(endsFix.headDeltaMs) > ENDS_FIX_NOTE_MIN_MS ||
          Math.abs(endsFix.tailDeltaMs) > ENDS_FIX_NOTE_MIN_MS);
      const captionsShifted = Boolean(take.captions) && edgesMoved;
      const afterVerdict = checkLoudness(matched.after, standard).verdict;
      if (afterVerdict === 'pass') {
        const endsNote =
          edgesMoved && endsFix
            ? endsFix.roomTone
              ? 'Edges fixed with your room tone.'
              : 'Edges fixed (digital silence).'
            : undefined;
        entries.push({
          id: take.id,
          name: take.name,
          status: 'matched',
          before,
          after: matched.after,
          gainDb: matched.gainDb,
          peakLimited: matched.peakLimited,
          savedName,
          ...(endsNote ? { endsNote } : {}),
          ...(captionsShifted ? { captionsShifted } : {}),
        });
        result.matched += 1;
      } else {
        entries.push({
          id: take.id,
          name: take.name,
          status: 'needs-work',
          before: matched.before,
          after: matched.after,
          gainDb: matched.gainDb,
          peakLimited: matched.peakLimited,
          savedName,
          ...(captionsShifted ? { captionsShifted } : {}),
          error: 'Still outside the standard — usually recorded room tone gain cannot remove.',
        });
        result.needsWork += 1;
      }
    } catch (error) {
      entries.push({
        id: take.id,
        name: take.name,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Matching failed.',
      });
      result.failed += 1;
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
