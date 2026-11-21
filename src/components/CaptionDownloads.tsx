import {
  SRT_FILTERS,
  VTT_FILTERS,
  exportFileName,
  saveExport,
} from '../lib/export';

export interface StoredCaptions {
  srt: string;
  vtt: string;
}

/**
 * The one SRT/VTT download pair, shared by the Player and the Raw/Shaped
 * compare: same filenames, same desktop Save dialog, same plain download in
 * the browser. No object URLs to manage — a fresh blob is handed to the
 * export path on each click.
 */
export function CaptionDownloads({
  captions,
  name,
  small = false,
}: {
  captions: StoredCaptions;
  /** Take or sample name; the extension is replaced, illegal characters dashed. */
  name: string;
  small?: boolean;
}) {
  const download = (kind: 'srt' | 'vtt'): void => {
    const text = kind === 'srt' ? captions.srt : captions.vtt;
    const filters = kind === 'srt' ? SRT_FILTERS : VTT_FILTERS;
    void saveExport(new Blob([text], { type: 'text/plain' }), exportFileName(name, kind), filters);
  };
  const className = small ? 'btn ghost small' : 'btn ghost';
  return (
    <>
      <button className={className} onClick={() => download('srt')}>
        Download SRT
      </button>
      <button className={className} onClick={() => download('vtt')}>
        Download VTT
      </button>
    </>
  );
}
