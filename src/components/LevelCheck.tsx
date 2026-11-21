import { useEffect, useState } from 'react';
import { analyzeTake, matchTake, measureTakeEnds, type MatchedTake } from '../lib/dspClient';
import { saveTake } from '../lib/library';
import {
  LOUDNESS_STANDARDS,
  checkLoudness,
  type LoudnessReport,
  type LoudnessResult,
} from '../lib/loudness';
import { checkEnds, ENDS_FIX_NOTE_MIN_MS, type AcxEnds } from '../lib/acx';
import { offsetStoredCaptions } from '../lib/captions';
import { SETTING_KEYS, useSetting } from '../lib/settings';

type LevelState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'matching' }
  | {
      status: 'ready';
      report: LoudnessReport;
      result: LoudnessResult;
      standardId: string;
      standardName: string;
      /** ACX edges; absent for Ad Spot, or when the take has no edges to read. */
      ends?: AcxEnds;
      matched?: {
        gainDb: number;
        peakLimited: boolean;
        savedName: string;
        endsNote?: string;
        captionNote?: string;
      };
    }
  | { status: 'error'; message: string };

/**
 * One-click mastering check for a take: peak, loudness and noise floor graded
 * against the Audiobook (ACX) or Ad Spot delivery bar, plus a Match button
 * that fixes gain and peaks on-device and saves the result as a new take.
 * Audiobook takes also get their ACX head/tail edges checked (0.5–1 s head,
 * 1–5 s tail) and fixed with the take's own room tone — or silence for synth
 * takes. Measurement and matching run in the audio worker, so even long
 * chapters don't freeze the UI. Matching never touches the original take, and
 * caption timings survive it (gain changes nothing about length; the ACX head
 * shift is carried onto the captions).
 *
 * The analyzer, edge measurer and matcher are injectable so tests can drive
 * the UI without a worker; the take saver is injectable so tests never touch
 * the library.
 */
export function LevelCheck({
  blob,
  takeName,
  captions,
  onTakeSaved,
  isSong,
  analyze = analyzeTake,
  measureEndsAudio = measureTakeEnds,
  matchAudio = matchTake,
  saveMatchedTake = (input: {
    name: string;
    duration: number;
    blob: Blob;
    captions?: { srt: string; vtt: string };
  }) => saveTake({ ...input, kind: 'processed' }),
}: {
  blob: Blob;
  /** Library name for the matched copy; the original take is never touched. */
  takeName?: string;
  /** Stored captions travel onto the matched copy, shifted with the ACX head. */
  captions?: { srt: string; vtt: string };
  /** Called after the matched take lands in the library (a list refresh). */
  onTakeSaved?: () => void;
  /**
   * Song mixes skip Match, like batch Match and caption backfill skip songs:
   * mastering music to a speech bar would corrupt it. Check levels still runs.
   */
  isSong?: boolean;
  analyze?: (blob: Blob) => Promise<LoudnessReport>;
  measureEndsAudio?: (blob: Blob) => Promise<AcxEnds>;
  matchAudio?: (blob: Blob, standardId: string) => Promise<MatchedTake>;
  saveMatchedTake?: (input: {
    name: string;
    duration: number;
    blob: Blob;
    captions?: { srt: string; vtt: string };
  }) => Promise<unknown>;
}) {
  const [standardId, setStandardId] = useSetting<string>(SETTING_KEYS.loudnessStandard, 'audiobook');
  const [levels, setLevels] = useState<LevelState>({ status: 'idle' });

  // A new take invalidates the old verdict exactly like captions do.
  useEffect(() => {
    setLevels({ status: 'idle' });
  }, [blob]);

  const standard =
    LOUDNESS_STANDARDS.find((entry) => entry.id === standardId) ?? LOUDNESS_STANDARDS[0];

  function handleMatch(ready: Extract<LevelState, { status: 'ready' }>): void {
    setLevels({ status: 'matching' });
    void matchAudio(blob, ready.standardId)
      .then(async (matched) => {
        const matchedStandard =
          LOUDNESS_STANDARDS.find((entry) => entry.id === ready.standardId) ?? LOUDNESS_STANDARDS[0];
        const savedName = `${takeName ?? 'Take'} — ${matchedStandard.name} match`;
        // The ACX edge rebuild moves every cue by the head delta; carry the
        // shifted times over so the new take's captions stay placed.
        const headDeltaSeconds = (matched.endsFix?.headDeltaMs ?? 0) / 1000;
        await saveMatchedTake({
          name: savedName,
          duration: matched.after.seconds,
          blob: matched.wav,
          ...(captions ? { captions: offsetStoredCaptions(captions, headDeltaSeconds) } : {}),
        });
        const endsFix = matched.endsFix;
        const edgesMoved =
          !!endsFix &&
          (Math.abs(endsFix.headDeltaMs) > ENDS_FIX_NOTE_MIN_MS ||
            Math.abs(endsFix.tailDeltaMs) > ENDS_FIX_NOTE_MIN_MS);
        const endsNote =
          matchedStandard.id === 'audiobook' && edgesMoved && endsFix
            ? `Edges fixed to 0.75 s head / 2.0 s tail${
                endsFix.roomTone ? ' with your room tone' : ' (digital silence)'
              }.`
            : undefined;
        // Ad spots have no head rebuild, so the unchanged note must not cite
        // a head spec that doesn't exist for them.
        const captionNote = captions
          ? Math.abs(headDeltaSeconds) > ENDS_FIX_NOTE_MIN_MS / 1000
            ? `Captions shifted ${headDeltaSeconds >= 0 ? '+' : ''}${headDeltaSeconds.toFixed(2)} s with the new head.`
            : matchedStandard.id === 'audiobook'
              ? 'Captions unchanged — head already in spec.'
              : 'Captions unchanged.'
          : undefined;
        setLevels({
          status: 'ready',
          report: matched.after,
          result: checkLoudness(matched.after, matchedStandard),
          standardId: matchedStandard.id,
          standardName: matchedStandard.name,
          ...(matched.afterEnds ? { ends: matched.afterEnds } : {}),
          matched: {
            gainDb: matched.gainDb,
            peakLimited: matched.peakLimited,
            savedName,
            ...(endsNote ? { endsNote } : {}),
            ...(captionNote ? { captionNote } : {}),
          },
        });
        onTakeSaved?.();
      })
      .catch((error: unknown) => {
        setLevels({
          status: 'error',
          message: error instanceof Error ? error.message : 'Matching failed.',
        });
      });
  }

  const ready = levels.status === 'ready' ? levels : null;
  const endsVerdict =
    ready && ready.standardId === 'audiobook' && ready.ends ? checkEnds(ready.ends) : null;
  const combinedPass =
    ready !== null && ready.result.verdict === 'pass' && (endsVerdict === null || endsVerdict.verdict === 'pass');
  const needsMatch =
    ready !== null &&
    !ready.matched &&
    (ready.result.verdict !== 'pass' || (endsVerdict !== null && endsVerdict.verdict !== 'pass'));
  const showMatch = needsMatch && !isSong;

  return (
    <div className="stack">
      <div className="row">
        <select
          aria-label="Compliance standard"
          value={standard.id}
          onChange={(event) => setStandardId(event.target.value)}
        >
          {LOUDNESS_STANDARDS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} — {entry.blurb}
            </option>
          ))}
        </select>
        <button
          className="btn ghost"
          disabled={levels.status === 'working' || levels.status === 'matching'}
          onClick={() => {
            setLevels({ status: 'working' });
            const current = standard;
            void analyze(blob)
              .then((report) => {
                setLevels({
                  status: 'ready',
                  report,
                  result: checkLoudness(report, current),
                  standardId: current.id,
                  standardName: current.name,
                });
                // Edges are best-effort next to the loudness verdict: silence
                // has no edges, and a take that can't be read for edges still
                // gets its loudness verdict.
                if (current.id === 'audiobook') {
                  void measureEndsAudio(blob)
                    .then((ends) =>
                      setLevels((previous) =>
                        previous.status === 'ready' && previous.standardId === current.id
                          ? { ...previous, ends }
                          : previous,
                      ),
                    )
                    .catch(() => {});
                }
              })
              .catch((error: unknown) => {
                setLevels({
                  status: 'error',
                  message: error instanceof Error ? error.message : 'Level check failed.',
                });
              });
          }}
        >
          {levels.status === 'working' ? 'Checking…' : 'Check levels'}
        </button>
      </div>
      {levels.status === 'matching' && <p className="status">Matching the standard…</p>}
      {ready && (
        <div className="stack">
          <small className="muted">
            {ready.standardName}: {combinedPass ? 'ready to ship.' : 'needs work before export.'}
          </small>
          {ready.result.checks.map((check) => (
            <div className="row between" key={check.metric}>
              <span>
                {check.metric} · {check.value}
              </span>
              <span className={check.verdict === 'pass' ? 'good' : check.verdict === 'warn' ? 'warn' : 'bad'}>
                {check.verdict === 'pass' ? 'Pass' : check.verdict === 'warn' ? 'Check' : 'Fail'} — {check.detail}
              </span>
            </div>
          ))}
          {endsVerdict &&
            endsVerdict.checks.map((check) => (
              <div className="row between" key={check.metric}>
                <span>
                  {check.metric} · {check.value}
                </span>
                <span className={check.verdict === 'pass' ? 'good' : 'bad'}>
                  {check.verdict === 'pass' ? 'Pass' : 'Fail'} — {check.detail}
                </span>
              </div>
            ))}
          {ready.matched && (
            <small className="muted">
              Saved “{ready.matched.savedName}” to your library. Matched:{' '}
              {ready.matched.gainDb >= 0 ? '+' : ''}
              {ready.matched.gainDb.toFixed(1)} dB
              {ready.matched.peakLimited ? ', peak limited' : ''}
              {ready.matched.endsNote ? ` ${ready.matched.endsNote}` : ''}
              {ready.matched.captionNote ? ` ${ready.matched.captionNote}` : ''} The original take is untouched.
            </small>
          )}
          {showMatch && (
            <div className="row">
              <button
                className="btn small"
                disabled={levels.status !== 'ready'}
                title={
                  ready.standardId === 'audiobook'
                    ? 'Fix gain, peaks and ACX head/tail on-device and save the result as a new take.'
                    : 'Fix gain and peaks on-device and save the result as a new take.'
                }
                onClick={() => handleMatch(ready)}
              >
                Match {ready.standardName}
              </button>
              <small className="muted">
                Saves a new take; gain can&apos;t remove recorded room tone.
              </small>
            </div>
          )}
          {isSong && needsMatch && (
            <small className="muted">
              Song mixes skip Match — mastering music to a speech bar would corrupt it.
            </small>
          )}
        </div>
      )}
      {levels.status === 'error' && <span className="error">{levels.message}</span>}
    </div>
  );
}
