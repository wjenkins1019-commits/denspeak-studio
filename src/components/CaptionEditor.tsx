import { useEffect, useState } from 'react';
import { formatSRT, formatVTT, parseCues, type Cue } from '../lib/captions';
import { updateTakeCaptions } from '../lib/library';

const NUDGE_S = 0.1;

interface DraftCue extends Cue {
  key: number;
}

function toDrafts(cues: Cue[]): DraftCue[] {
  return cues.map((cue, index) => ({ ...cue, key: index }));
}

function clampTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000) / 1000) : 0;
}

/**
 * Fix cue text and nudge timings, then save back to the take so the same
 * SRT/VTT re-exports after a restart. Without a takeId the edits still
 * re-export via onSaved, but nothing is persisted.
 */
export function CaptionEditor({
  captions,
  name,
  takeId,
  small = false,
  onSaved,
}: {
  captions: { srt: string; vtt: string };
  name: string;
  takeId?: string;
  small?: boolean;
  onSaved?: (next: { srt: string; vtt: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<DraftCue[]>(() => toDrafts(parseCues(captions.srt)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh captions (new take, Whisper fallback landing) replace the draft.
  useEffect(() => {
    setDrafts(toDrafts(parseCues(captions.srt)));
    setError(null);
  }, [captions.srt]);

  function nudge(key: number, field: 'start' | 'end', delta: number): void {
    setDrafts((current) =>
      current.map((cue) =>
        cue.key === key ? { ...cue, [field]: clampTime(cue[field] + delta) } : cue,
      ),
    );
  }

  function edit(key: number, patch: Partial<Cue>): void {
    setDrafts((current) => current.map((cue) => (cue.key === key ? { ...cue, ...patch } : cue)));
  }

  function remove(key: number): void {
    setDrafts((current) => current.filter((cue) => cue.key !== key));
  }

  async function handleSave(): Promise<void> {
    setError(null);
    const cleaned = drafts
      .map((cue) => ({
        start: clampTime(cue.start),
        end: clampTime(cue.end),
        text: cue.text.trim(),
        ...(cue.speaker?.trim() ? { speaker: cue.speaker.trim().slice(0, 40) } : {}),
      }))
      .filter((cue) => cue.text !== '');
    if (cleaned.length === 0) {
      setError('Nothing to save: every cue is empty.');
      return;
    }
    cleaned.sort((a, b) => a.start - b.start);
    for (const cue of cleaned) {
      if (!(cue.end > cue.start)) {
        setError('Each cue needs an end after its start.');
        return;
      }
    }
    const next = { srt: formatSRT(cleaned), vtt: formatVTT(cleaned) };
    setSaving(true);
    try {
      if (takeId) await updateTakeCaptions(takeId, next);
      onSaved?.(next);
      setDrafts(toDrafts(cleaned));
      setOpen(false);
    } catch {
      setError('Could not save the edits.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className={small ? 'btn ghost small' : 'btn ghost'} onClick={() => setOpen(true)}>
        Edit captions
      </button>
    );
  }

  return (
    <div className="stack">
      {drafts.map((cue) => (
        <div key={cue.key} className="card stack">
          <div className="row">
            <label>
              Start
              <input
                type="number"
                aria-label={`Cue start ${cue.key + 1}`}
                step={NUDGE_S}
                min={0}
                value={cue.start}
                onChange={(event) => edit(cue.key, { start: Number(event.target.value) })}
              />
            </label>
            <button
              className="btn ghost small"
              aria-label={`Nudge cue ${cue.key + 1} start earlier`}
              onClick={() => nudge(cue.key, 'start', -NUDGE_S)}
            >
              −0.1
            </button>
            <button
              className="btn ghost small"
              aria-label={`Nudge cue ${cue.key + 1} start later`}
              onClick={() => nudge(cue.key, 'start', NUDGE_S)}
            >
              +0.1
            </button>
          </div>
          <div className="row">
            <label>
              End
              <input
                type="number"
                aria-label={`Cue end ${cue.key + 1}`}
                step={NUDGE_S}
                min={0}
                value={cue.end}
                onChange={(event) => edit(cue.key, { end: Number(event.target.value) })}
              />
            </label>
            <button
              className="btn ghost small"
              aria-label={`Nudge cue ${cue.key + 1} end earlier`}
              onClick={() => nudge(cue.key, 'end', -NUDGE_S)}
            >
              −0.1
            </button>
            <button
              className="btn ghost small"
              aria-label={`Nudge cue ${cue.key + 1} end later`}
              onClick={() => nudge(cue.key, 'end', NUDGE_S)}
            >
              +0.1
            </button>
          </div>
          <label>
            Voice (empty means narration)
            <input
              type="text"
              aria-label={`Cue voice ${cue.key + 1}`}
              value={cue.speaker ?? ''}
              onChange={(event) => edit(cue.key, { speaker: event.target.value })}
            />
          </label>
          <label>
            Text
            <input
              type="text"
              aria-label={`Cue text ${cue.key + 1}`}
              value={cue.text}
              onChange={(event) => edit(cue.key, { text: event.target.value })}
            />
          </label>
          <div className="row">
            <button className="btn ghost small danger" onClick={() => remove(cue.key)}>
              Delete cue
            </button>
          </div>
          <small className="muted">{name}</small>
        </div>
      ))}
      {error && <span className="error">{error}</span>}
      <div className="row">
        <button className="btn small" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save captions'}
        </button>
        <button
          className="btn ghost small"
          disabled={saving}
          onClick={() => {
            setDrafts(toDrafts(parseCues(captions.srt)));
            setError(null);
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
