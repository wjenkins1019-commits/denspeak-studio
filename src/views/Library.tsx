import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearTakes,
  deleteTake,
  listTakes,
  updateTakeCaptions,
  type Take,
} from '../lib/library';
import { exportLibrary, exportTake, exportTakeMp3 } from '../lib/export';
import { formatDate, formatDuration } from '../lib/format';
import { TRANSCRIBE_MODELS, transcribeTimed } from '../lib/transcribe';
import { SETTING_KEYS, useSetting } from '../lib/settings';
import { backfillMissingCaptions, needsCaptions, type BackfillProgress } from '../lib/backfill';
import { Player } from '../components/Player';
import { ExportBundle } from '../components/ExportBundle';
import { BatchMatch } from '../components/BatchMatch';
import { CaptionSearch } from '../components/CaptionSearch';
import { HANDOFF_TARGETS, sendTake } from '../lib/handoff';

export default function Library() {
  const [takes, setTakes] = useState<Take[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [seek, setSeek] = useState<{ id: string; at: number } | null>(null);
  const [mp3Id, setMp3Id] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const [captionModel] = useSetting<string>(SETTING_KEYS.transcribeModel, TRANSCRIBE_MODELS[1].id);
  const cancelBackfill = useRef(false);
  // Takes are immutable, but every listTakes() read hands back new Blob
  // objects. Keep the first Blob per take so an unrelated refresh (like the
  // one after a Match save) doesn't look like a new take and reset an open
  // Player's verdicts and captions.
  const blobCache = useRef(new Map<string, Blob>());
  const blobFor = (take: Take): Blob => {
    const cached = blobCache.current.get(take.id);
    if (cached) return cached;
    blobCache.current.set(take.id, take.blob);
    return take.blob;
  };

  const refresh = useCallback(async () => {
    try {
      const rows = await listTakes();
      setTakes(rows);
      setError(null);
    } catch {
      setError('Could not read the library.');
      setTakes([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDelete(take: Take) {
    await deleteTake(take.id);
    blobCache.current.delete(take.id);
    if (openId === take.id) setOpenId(null);
    await refresh();
  }

  async function handleExportAll() {
    if (!takes || takes.length === 0) return;
    try {
      await exportLibrary(takes);
      setError(null);
    } catch {
      setError('Could not build the export file.');
    }
  }

  async function handleClear() {
    if (!window.confirm('Delete every take in the library? This cannot be undone.')) return;
    await clearTakes();
    blobCache.current.clear();
    setOpenId(null);
    await refresh();
  }

  const missing = (takes ?? []).filter(needsCaptions);

  async function handleBackfill() {
    if (!takes || backfill) return;
    cancelBackfill.current = false;
    setBackfillNote(null);
    // Snapshot the rows up front: the loop writes captions back onto them
    // while the list on screen refreshes only at the end.
    const snapshot = takes;
    const result = await backfillMissingCaptions(snapshot, captionModel, {
      transcribeTimed,
      saveCaptions: (id, captions) => updateTakeCaptions(id, captions),
      onProgress: setBackfill,
      shouldCancel: () => cancelBackfill.current,
    });
    setBackfill(null);
    const parts = [`Captioned ${result.captioned}.`];
    if (result.failed.length > 0) {
      parts.push(
        `${result.failed.length} failed: ${result.failed.map((entry) => entry.name).join(', ')}.`,
      );
    }
    if (result.cancelled) parts.push('Cancelled — the rest were left alone.');
    setBackfillNote(parts.join(' '));
    await refresh();
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Library</span>
          <h1>Your takes</h1>
          <p>Narrations and converted recordings live on this machine, in the app's own storage.</p>
        </div>
        <div className="head-actions">
          {backfill ? (
            <button className="btn ghost" onClick={() => void (cancelBackfill.current = true)}>
              Cancel backfill
            </button>
          ) : (
            <button
              className="btn ghost"
              disabled={!takes || missing.length === 0}
              title="Transcribe every take that has no captions yet. Song mixes are skipped."
              onClick={() => void handleBackfill()}
            >
              {takes && missing.length > 0
                ? `Backfill captions (${missing.length})`
                : 'Captions complete'}
            </button>
          )}
          <button
            className="btn ghost"
            disabled={!takes || takes.length === 0}
            onClick={() => void handleExportAll()}
          >
            Export all (.zip)
          </button>
          <button className="btn danger" disabled={!takes || takes.length === 0} onClick={() => void handleClear()}>
            Clear library
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {backfill && (
        <p className="status" role="status">
          Captioning {backfill.done + 1} of {backfill.total}… {backfill.currentName} —{' '}
          {backfill.status}
        </p>
      )}
      {backfillNote && <p className="status">{backfillNote}</p>}

      {takes && takes.length > 0 && (
        <div className="card stack">
          <BatchMatch takes={takes} onDone={() => void refresh()} />
        </div>
      )}

      {takes && takes.length > 0 && (
        <div className="card stack">
          <CaptionSearch
            takes={takes}
            uncaptioned={missing.length}
            onJump={(takeId, start) => {
              setOpenId(takeId);
              setSeek({ id: takeId, at: start });
            }}
          />
        </div>
      )}

      {takes === null && <div className="empty">Reading the library…</div>}

      {takes && takes.length === 0 && (
        <div className="empty">
          Nothing here yet. Render a narration in Studio, or convert a recording, and it will land
          here.
        </div>
      )}

      {takes && takes.length > 0 && (
        <div className="take-list">
          {takes.map((take) => (
            <div key={take.id} className="card stack">
              <div className="take-row">
                <div className="meta">
                  <strong>{take.name}</strong>
                  <small>
                    {take.kind === 'render'
                      ? take.voiceName ?? 'Narration'
                      : take.kind === 'convert'
                        ? 'Converted'
                        : take.kind === 'processed'
                          ? 'Processed'
                          : 'Song'}{' '}
                    ·{' '}
                    {formatDuration(take.duration)} · {formatDate(take.createdAt)}
                  </small>
                </div>
                <div className="actions">
                  <button className="btn ghost small" onClick={() => void exportTake(take)}>
                    WAV
                  </button>
                  <button
                    className="btn ghost small"
                    disabled={mp3Id === take.id}
                    onClick={() => {
                      setMp3Id(take.id);
                      void exportTakeMp3(take).finally(() =>
                        setMp3Id((current) => (current === take.id ? null : current)),
                      );
                    }}
                  >
                    {mp3Id === take.id ? 'Encoding…' : 'MP3'}
                  </button>
                  <button
                    className="btn small"
                    onClick={() => {
                      setSeek(null);
                      setOpenId(openId === take.id ? null : take.id);
                    }}
                  >
                    {openId === take.id ? 'Close player' : 'Play'}
                  </button>
                  <ExportBundle name={take.name} blob={take.blob} takeId={take.id} small />
                  <button className="btn ghost small danger" onClick={() => void handleDelete(take)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="row between">
                <small className="muted">Send this take to</small>
                <div className="row">
                  {HANDOFF_TARGETS.map((entry) => (
                    <button
                      key={entry.target}
                      className="btn ghost small"
                      onClick={() => sendTake(entry.target, { name: take.name, blob: take.blob })}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
              {openId === take.id && (
                  <Player
                    blob={blobFor(take)}
                    name={take.name}
                    captions={take.captions}
                    takeId={take.id}
                    onTakeSaved={() => void refresh()}
                    startAt={seek?.id === take.id ? seek.at : null}
                    isSong={take.kind === 'song'}
                  />
                )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
