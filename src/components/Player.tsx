import { useEffect, useRef, useState } from 'react';
import {
  MP3_FILTERS,
  exportFileName,
  saveExport,
  takeToMp3Blob,
  WAV_FILTERS,
} from '../lib/export';
import { CaptionDownloads } from './CaptionDownloads';
import { CaptionEditor } from './CaptionEditor';
import { ExportBundle } from './ExportBundle';
import { updateTakeCaptions } from '../lib/library';
import { formatSRT, formatVTT, normalizeWords, wordsToCues } from '../lib/captions';
import { LevelCheck } from './LevelCheck';
import { TRANSCRIBE_MODELS, transcribeTimed } from '../lib/transcribe';
import { SETTING_KEYS, useSetting } from '../lib/settings';

/**
 * Inline audio player for a take or preview, with a WAV download link.
 *
 * Object URLs are created inside the effect that also revokes them: creating
 * them in `useMemo` and revoking in a cleanup would break under StrictMode,
 * which runs the cleanup once on mount and leaves the element with a dead URL.
 */
type CaptionState = { status: 'idle' } | { status: 'working'; note: string } | { status: 'ready'; srt: string; vtt: string } | { status: 'error'; message: string };

export function Player({
  blob,
  name,
  captions: precomputed,
  takeId,
  onTakeSaved,
  startAt,
  isSong,
}: {
  blob: Blob;
  name?: string;
  /**
   * Captions timed from the synthesis itself (a render take carries them).
   * The Captions button then answers instantly with no model download;
   * anything without them falls back to transcribing the audio.
   */
  captions?: { srt: string; vtt: string };
  /**
   * Library id of the take. A successful Whisper fallback is written back
   * onto it, so takes saved before stored captions existed still end up
   * re-exportable. Blobs without a library entry skip the write.
   */
  takeId?: string;
  /** Called after a matched copy lands in the library (a list refresh). */
  onTakeSaved?: () => void;
  /**
   * Song mixes skip Match (mastering music to a speech bar would corrupt
   * them), like batch Match and caption backfill skip songs.
   */
  isSong?: boolean;
  /**
   * Seek here once the audio can: the Library's caption search passes the
   * hit's timestamp so playback starts where the words were said. Changes
   * re-seek, so jumping between hits in one open player works too.
   */
  startAt?: number | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingMp3, setSavingMp3] = useState(false);
  const [captions, setCaptions] = useState<CaptionState>({ status: 'idle' });
  const [captionModel] = useSetting<string>(SETTING_KEYS.transcribeModel, TRANSCRIBE_MODELS[1].id);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);

  // Caption-search jumps: seek once the element knows its duration. Ready
  // state 1+ means metadata is in and currentTime sticks.
  useEffect(() => {
    if (startAt === undefined || startAt === null) return;
    const element = audioRef.current;
    if (!element) return;
    const seek = () => {
      try {
        element.currentTime = Math.max(0, startAt);
      } catch {
        // Not seekable yet; the metadata listener retries.
      }
    };
    if (element.readyState >= 1) seek();
    element.addEventListener('loadedmetadata', seek, { once: true });
    return () => element.removeEventListener('loadedmetadata', seek);
  }, [url, startAt]);

  // A new take invalidates everything derived from the old one: without this
  // reset the SRT/VTT downloads would silently belong to the previous take.
  useEffect(() => {
    setCaptions({ status: 'idle' });
  }, [blob]);

  if (!url) return null;

  return (
    <div className="player">
      <audio controls src={url} ref={audioRef} />
      {captions.status === 'ready' ? (
        <>
          <CaptionDownloads
            captions={{ srt: captions.srt, vtt: captions.vtt }}
            name={name ?? 'denspeak-studio'}
          />
          <CaptionEditor
            captions={{ srt: captions.srt, vtt: captions.vtt }}
            name={name ?? 'denspeak-studio'}
            takeId={takeId}
            onSaved={(next) => setCaptions({ status: 'ready', ...next })}
          />
        </>
      ) : (
        <button
          className="btn ghost"
          disabled={captions.status === 'working'}
          onClick={() => {
            if (precomputed) {
              setCaptions({ status: 'ready', srt: precomputed.srt, vtt: precomputed.vtt });
              return;
            }
            setCaptions({ status: 'working', note: 'Reading the audio…' });
            void transcribeTimed(blob, captionModel, ({ status }) =>
              setCaptions({ status: 'working', note: status }),
            )
              .then((chunks) => {
                const cues = wordsToCues(normalizeWords(chunks));
                if (cues.length === 0) {
                  setCaptions({ status: 'error', message: 'Could not hear any speech to caption.' });
                  return;
                }
                const heard = { srt: formatSRT(cues), vtt: formatVTT(cues) };
                setCaptions({ status: 'ready', ...heard });
                if (takeId) {
                  // Best effort: the download buttons already work from state;
                  // this just makes the same files available after a restart.
                  void updateTakeCaptions(takeId, heard).catch(() => {});
                }
              })
              .catch((error: unknown) => {
                setCaptions({
                  status: 'error',
                  message: error instanceof Error ? error.message : 'Captioning failed.',
                });
              });
          }}
        >
          {captions.status === 'working' ? captions.note : 'Captions'}
        </button>
      )}
      {captions.status === 'error' && <span className="error">{captions.message}</span>}
      <button
        className="btn ghost"
        disabled={saving || savingMp3}
        onClick={() => {
          setSaving(true);
          void saveExport(blob, exportFileName(name ?? 'denspeak-studio', 'wav'), WAV_FILTERS).finally(
            () => setSaving(false),
          );
        }}
      >
        {saving ? 'Exporting…' : 'Export WAV'}
      </button>
      <button
        className="btn ghost"
        disabled={saving || savingMp3}
        onClick={() => {
          setSavingMp3(true);
          const title = name ?? 'denspeak-studio';
          void takeToMp3Blob({ blob })
            .then((mp3) => saveExport(mp3, exportFileName(title, 'mp3'), MP3_FILTERS))
            .finally(() => setSavingMp3(false));
        }}
      >
        {savingMp3 ? 'Encoding…' : 'Export MP3'}
      </button>
      <ExportBundle
        name={name ?? 'denspeak-studio'}
        blob={blob}
        takeId={takeId}
        captions={captions.status === 'ready' ? { srt: captions.srt, vtt: captions.vtt } : precomputed}
      />
      <LevelCheck
        blob={blob}
        takeName={name}
        captions={captions.status === 'ready' ? { srt: captions.srt, vtt: captions.vtt } : precomputed}
        onTakeSaved={onTakeSaved}
        isSong={isSong}
      />
    </div>
  );
}
