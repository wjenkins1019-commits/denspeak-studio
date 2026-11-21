import { useRef, useState } from 'react';
import { analyzeTake, matchTake, measureTakeEnds, type MatchedTake } from '../lib/dspClient';
import type { AcxEnds } from '../lib/acx';
import { saveTake, type Take } from '../lib/library';
import { LOUDNESS_STANDARDS, formatDb } from '../lib/loudness';
import { offsetStoredCaptions } from '../lib/captions';
import { SETTING_KEYS, useSetting } from '../lib/settings';
import {
  batchMatchTakes,
  isMatchableTake,
  type BatchMatchProgress,
  type BatchMatchResult,
} from '../lib/batchMatch';

type BatchState =
  | { status: 'idle' }
  | { status: 'working'; progress: BatchMatchProgress | null }
  | { status: 'done'; result: BatchMatchResult; standardName: string }
  | { status: 'error'; message: string };

/**
 * Batch Match for the whole library: checks every voice take against the
 * chosen Audiobook/Ad Spot bar, matches the ones outside it on-device, and
 * reports each take — passed, matched, still needs work (usually recorded
 * room tone), or failed. Originals are never touched; fixes land as new
 * `processed` takes with captions and voice carried over. Song mixes are
 * skipped: mastering music to a speech bar would corrupt it.
 *
 * Runs sequentially with cancel, like the caption backfill. The analyzer,
 * matcher and saver are injectable so tests drive the UI without a worker.
 */
export function BatchMatch({
  takes,
  onDone,
  analyze = analyzeTake,
  measureEndsAudio = measureTakeEnds,
  matchAudio = matchTake,
  saveMatchedTake = (take: Take, matched: MatchedTake, savedName: string) =>
    saveTake({
      name: savedName,
      duration: matched.after.seconds,
      blob: matched.wav,
      kind: 'processed',
      // The ACX edge rebuild moves every cue by the head delta; carry the
      // shifted times over so the new take's captions stay placed.
      ...(take.captions
        ? {
            captions: offsetStoredCaptions(
              take.captions,
              (matched.endsFix?.headDeltaMs ?? 0) / 1000,
            ),
          }
        : {}),
      ...(take.voiceId ? { voiceId: take.voiceId } : {}),
      ...(take.voiceName ? { voiceName: take.voiceName } : {}),
    }),
}: {
  takes: Take[];
  /** Called after the run so the library list picks up the new takes. */
  onDone?: () => void;
  analyze?: (blob: Blob) => Promise<MatchedTake['before']>;
  measureEndsAudio?: (blob: Blob) => Promise<AcxEnds>;
  matchAudio?: (blob: Blob, standardId: string) => Promise<MatchedTake>;
  saveMatchedTake?: (take: Take, matched: MatchedTake, savedName: string) => Promise<unknown>;
}) {
  const [standardId, setStandardId] = useSetting<string>(SETTING_KEYS.loudnessStandard, 'audiobook');
  const [state, setState] = useState<BatchState>({ status: 'idle' });
  const cancel = useRef(false);

  const matchable = takes.filter(isMatchableTake);
  const standard =
    LOUDNESS_STANDARDS.find((entry) => entry.id === standardId) ?? LOUDNESS_STANDARDS[0];

  async function handleRun(): Promise<void> {
    if (state.status === 'working' || matchable.length === 0) return;
    cancel.current = false;
    setState({ status: 'working', progress: null });
    try {
      const result = await batchMatchTakes(matchable, standard.id, {
        analyze,
        measureEndsAudio,
        matchAudio,
        saveMatched: (take, matched, savedName) => saveMatchedTake(take, matched, savedName),
        onProgress: (progress) =>
          setState({ status: 'working', progress }),
        shouldCancel: () => cancel.current,
      });
      setState({ status: 'done', result, standardName: standard.name });
      onDone?.();
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Batch match failed.',
      });
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <select
          aria-label="Batch compliance standard"
          value={standard.id}
          disabled={state.status === 'working'}
          onChange={(event) => setStandardId(event.target.value)}
        >
          {LOUDNESS_STANDARDS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} — {entry.blurb}
            </option>
          ))}
        </select>
        {state.status === 'working' ? (
          <button className="btn ghost" onClick={() => void (cancel.current = true)}>
            Cancel batch match
          </button>
        ) : (
          <button
            className="btn"
            disabled={matchable.length === 0}
            title="Check every voice take against the standard and fix the ones outside it. Song mixes are skipped."
            onClick={() => void handleRun()}
          >
            {matchable.length > 0 ? `Match project (${matchable.length})` : 'Nothing to match'}
          </button>
        )}
      </div>

      {state.status === 'working' && (
        <p className="status" role="status">
          {state.progress
            ? `Matching ${state.progress.done + 1} of ${state.progress.total}… ${state.progress.currentName} — ${state.progress.status}`
            : 'Starting…'}
        </p>
      )}

      {state.status === 'done' && (
        <div className="stack">
          <small className="muted">
            {state.standardName}: matched {state.result.matched}, already in spec{' '}
            {state.result.passed}
            {state.result.needsWork > 0 && `, still needs work ${state.result.needsWork}`}
            {state.result.failed > 0 && `, failed ${state.result.failed}`}
            {state.result.cancelled && ' — cancelled, the rest were left alone'}. Fixes are new
            takes; originals are untouched.
          </small>
          {state.result.entries.map((entry) => (
            <div className="row between" key={entry.id}>
              <span>
                <strong>{entry.name}</strong>
                <br />
                <small className="muted">
                  {entry.before ? `was ${formatDb(entry.before.rmsDb)} RMS` : 'could not be read'}
                  {entry.after ? ` → now ${formatDb(entry.after.rmsDb)} RMS` : ''}
                  {entry.endsNote ? ` ${entry.endsNote}` : ''}
                  {entry.captionsShifted ? ' Captions shifted with the new head.' : ''}
                  {entry.gainDb !== undefined
                    ? ` (${entry.gainDb >= 0 ? '+' : ''}${entry.gainDb.toFixed(1)} dB${entry.peakLimited ? ', peak limited' : ''})`
                    : ''}
                  {entry.savedName ? ` · saved “${entry.savedName}”` : ''}
                  {entry.error && entry.status === 'needs-work' ? ` · ${entry.error}` : ''}
                </small>
              </span>
              <span
                className={
                  entry.status === 'matched' || entry.status === 'passed'
                    ? 'good'
                    : entry.status === 'needs-work'
                      ? 'warn'
                      : 'bad'
                }
              >
                {entry.status === 'matched'
                  ? 'Matched'
                  : entry.status === 'passed'
                    ? 'Passed'
                    : entry.status === 'needs-work'
                      ? 'Needs work'
                      : `Failed — ${entry.error ?? 'could not be matched'}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {state.status === 'error' && <span className="error">{state.message}</span>}
    </div>
  );
}
