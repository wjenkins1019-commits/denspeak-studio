import { useEffect, useRef, useState } from 'react';
import { CaptionDownloads } from './CaptionDownloads';
import { CaptionEditor } from './CaptionEditor';
import { ExportBundle } from './ExportBundle';
import { LevelCheck } from './LevelCheck';

type Side = 'raw' | 'shaped';

/**
 * One-click A/B between the untouched audio and the shaped version. Choosing a
 * side swaps the source and, if something was playing, keeps playing — so a
 * click is enough to compare without hunting for the play button.
 *
 * The object URLs live in the same effect that revokes them so StrictMode's
 * extra mount/unmount cycle cannot leave a revoked URL on the element.
 */
export function AbCompare({
  raw,
  shaped,
  rawLabel = 'Raw',
  shapedLabel = 'Shaped',
  captions,
  captionsName = 'captions',
  takeId,
  onTakeSaved,
}: {
  raw: Blob;
  shaped: Blob;
  rawLabel?: string;
  shapedLabel?: string;
  takeId?: string;
  /**
   * Stored cues for the finished take. Shown as instant SRT/VTT downloads so
   * a shaped take (which has no Player) can still re-export its captions;
   * views without stored cues simply omit the links.
   */
  captions?: { srt: string; vtt: string };
  captionsName?: string;
  /** Called after a matched copy lands in the library (a list refresh). */
  onTakeSaved?: () => void;
}) {
  const [side, setSide] = useState<Side>('shaped');
  const [edited, setEdited] = useState<{ srt: string; vtt: string } | null>(null);
  const current = edited ?? captions;

  // A new take invalidates edits of the old one, same reset contract as Player.
  useEffect(() => {
    setEdited(null);
  }, [captions?.srt]);
  const [urls, setUrls] = useState<Record<Side, string> | null>(null);
  const resume = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const created: Record<Side, string> = {
      raw: URL.createObjectURL(raw),
      shaped: URL.createObjectURL(shaped),
    };
    setUrls(created);
    return () => {
      URL.revokeObjectURL(created.raw);
      URL.revokeObjectURL(created.shaped);
    };
  }, [raw, shaped]);

  // Runs after the new source has been committed to the element.
  useEffect(() => {
    if (!resume.current) return;
    resume.current = false;
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  }, [side]);

  function choose(next: Side) {
    const audio = audioRef.current;
    if (next === side) {
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => {});
      }
      return;
    }
    resume.current = !(audio?.paused ?? true);
    setSide(next);
  }

  const sideLabel = side === 'raw' ? rawLabel : shapedLabel;

  return (
    <div className="stack">
      <div className="row between">
        <div className="preset-row" role="group" aria-label="Compare raw and shaped audio">
          <button
            className={side === 'raw' ? 'chip active' : 'chip'}
            aria-pressed={side === 'raw'}
            onClick={() => choose('raw')}
          >
            A · {rawLabel}
          </button>
          <button
            className={side === 'shaped' ? 'chip active' : 'chip'}
            aria-pressed={side === 'shaped'}
            onClick={() => choose('shaped')}
          >
            B · {shapedLabel}
          </button>
        </div>
        {urls && (
          <a className="btn ghost small" href={urls[side]} download={`${sideLabel}.wav`}>
            Download {sideLabel}
          </a>
        )}
        {current && (
          <>
            <CaptionDownloads captions={current} name={captionsName} small />
            <CaptionEditor
              captions={current}
              name={captionsName}
              takeId={takeId}
              small
              onSaved={(next) => setEdited(next)}
            />
          </>
        )}
      </div>
      {urls && <audio ref={audioRef} controls src={urls[side]} />}
      {current && (
        <ExportBundle name={captionsName} blob={shaped} takeId={takeId} captions={current} small />
      )}
      <LevelCheck
        blob={shaped}
        takeName={captionsName}
        captions={current}
        onTakeSaved={onTakeSaved}
      />
    </div>
  );
}
