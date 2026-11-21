import { useState } from 'react';
import { exportTakeBundle, type TakeBundleFormat } from '../lib/export';
import { getTake } from '../lib/library';
import { SETTING_KEYS, useSetting } from '../lib/settings';

/**
 * One-click per-take bundle: audio in the chosen format, stored SRT/VTT when
 * the take has them, and a loudness report graded against the same standard
 * the LevelCheck uses. Takes without stored captions still bundle audio plus
 * the report, which says captions are missing.
 *
 * Pass live captions (the Player's post-edit state) when you have them;
 * otherwise the take is re-read from the library by id so the bundle never
 * ships a stale row's captions.
 */
export function ExportBundle({
  name,
  blob,
  takeId,
  captions,
  small = false,
}: {
  name: string;
  blob: Blob;
  takeId?: string;
  captions?: { srt: string; vtt: string };
  small?: boolean;
}) {
  const [format, setFormat] = useState<TakeBundleFormat>('wav');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [standardId] = useSetting<string>(SETTING_KEYS.loudnessStandard, 'audiobook');

  async function handleClick(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const files = captions ?? (takeId ? (await getTake(takeId))?.captions : undefined);
      await exportTakeBundle(
        { name, blob, ...(files ? { captions: files } : {}) },
        { format, standardId },
      );
    } catch (unknown) {
      setError(unknown instanceof Error ? unknown.message : 'Bundle export failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <select
        aria-label="Bundle audio format"
        value={format}
        disabled={busy}
        onChange={(event) => setFormat(event.target.value as TakeBundleFormat)}
      >
        <option value="wav">WAV</option>
        <option value="mp3">MP3</option>
      </select>
      <button
        className={small ? 'btn ghost small' : 'btn ghost'}
        disabled={busy}
        onClick={() => void handleClick()}
      >
        {busy ? 'Bundling…' : 'Export bundle'}
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
