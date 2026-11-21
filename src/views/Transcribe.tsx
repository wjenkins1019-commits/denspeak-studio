import { useRef, useState } from 'react';
import { decodeToMono } from '../lib/audio';
import { exportFileName, saveBlob } from '../lib/export';
import { SETTING_KEYS, useSetting } from '../lib/settings';
import { TRANSCRIBE_MODELS, transcribe } from '../lib/transcribe';
import { Player } from '../components/Player';
import { HandoffNotice } from '../components/HandoffNotice';
import type { HandoffItem } from '../lib/handoff';
import { useHandoffTake } from '../lib/useHandoffTake';

interface Source {
  blob: Blob;
  name: string;
  duration: number;
}

const DEFAULT_MODEL = 'onnx-community/whisper-base.en';

export default function Transcribe() {
  const [model, setModel] = useSetting<string>(SETTING_KEYS.transcribeModel, DEFAULT_MODEL);
  const [source, setSource] = useState<Source | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [percent, setPercent] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, setDraft] = useSetting<string>(SETTING_KEYS.draft, '');

  const inputRef = useRef<HTMLInputElement | null>(null);

  // A take sent here from another section arrives as this section's sample.
  const handoff = useHandoffTake<{ source: Source | null; text: string }>(
    'transcribe',
    source || text ? { source, text } : null,
    (item) => receive(item),
    (before) => {
      setSource(before.source);
      setText(before.text);
    },
  );

  // A handed take carries its length, so it is not decoded again just to fill in
  // the duration the way a dropped file has to be.
  function receive(item: HandoffItem) {
    setError(null);
    setText('');

    if (item.duration !== undefined) {
      setSource({ blob: item.blob, name: item.name, duration: item.duration });
      return;
    }

    void load(new File([item.blob], item.name, { type: item.blob.type }));
  }

  async function load(file: File | undefined) {
    if (!file) return;
    setError(null);
    setText('');
    try {
      const decoded = await decodeToMono(file);
      setSource({ blob: file, name: file.name, duration: decoded.duration });
    } catch {
      setSource(null);
      setError(`Could not read "${file.name}". Try a WAV, MP3, M4A, FLAC or OGG file.`);
    }
  }

  async function run() {
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    setText('');
    setStatus('Reading the audio…');
    setPercent(null);
    try {
      const result = await transcribe(source.blob, model, ({ status: next, percent: progress }) => {
        setStatus(next);
        setPercent(progress);
      });
      setText(result);
      setStatus(result ? 'Done.' : 'No speech found in that clip.');
    } catch (transcribeError) {
      setStatus('');
      setError(
        transcribeError instanceof Error
          ? `Transcription failed: ${transcribeError.message}`
          : 'Transcription failed.',
      );
    } finally {
      setBusy(false);
      setPercent(null);
    }
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const baseName = source ? source.name.replace(/\.[^.]+$/, '') : 'transcript';

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Transcribe</span>
          <h1>Read a recording</h1>
          <p>
            Drop in a voice sample and Whisper writes down what it says. The model downloads once,
            then runs on this machine — the recording never leaves it.
          </p>
        </div>
      </header>

      <div className="grid two">
        <div className="card stack">
          <h2>Sample</h2>

          <div
            className={dragging ? 'drop active' : 'drop'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void load(event.dataTransfer.files?.[0]);
            }}
            onClick={() => inputRef.current?.click()}
          >
            {dragging ? 'Release to load the file' : 'Drop an audio file here, or click to choose one'}
            <input
              ref={inputRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => void load(event.target.files?.[0])}
            />
          </div>

          {handoff.arrival && (
            <HandoffNotice
              item={handoff.arrival.item}
              replaced={handoff.arrival.before !== null}
              waiting={handoff.waiting}
              onNext={handoff.next}
              onKeep={handoff.keep}
            />
          )}

          {source ? (
            <>
              <small className="muted">
                {source.name} · {source.duration.toFixed(1)}s
              </small>
              <Player blob={source.blob} name={`${source.name} sample`} />
            </>
          ) : (
            <div className="hint">
              WAV, MP3, M4A, FLAC and OGG all work. A clean single speaker is read best.
            </div>
          )}

          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
              {TRANSCRIBE_MODELS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} — {entry.note}
                </option>
              ))}
            </select>
          </label>

          <button className="btn primary" disabled={!source || busy} onClick={() => void run()}>
            {busy ? 'Transcribing…' : 'Transcribe'}
          </button>

          {busy && (
            <div className="stack" style={{ gap: 6 }}>
              <small className="muted">{status}</small>
              {percent !== null && (
                <div className="progress">
                  <span style={{ width: `${Math.round(percent * 100)}%` }} />
                </div>
              )}
            </div>
          )}
          {!busy && status && <p className="status">{status}</p>}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="card stack">
          <h2>Transcript</h2>

          <textarea
            rows={14}
            value={text}
            placeholder="The transcript appears here, and stays editable so you can fix a word before you use it."
            onChange={(event) => setText(event.target.value)}
          />

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <small className="muted">
              {words} {words === 1 ? 'word' : 'words'}
            </small>
            <div className="row">
              <button
                className="btn ghost small"
                disabled={!text}
                onClick={() => void navigator.clipboard.writeText(text)}
              >
                Copy
              </button>
              <button
                className="btn ghost small"
                disabled={!text}
                onClick={() =>
                  saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), exportFileName(baseName, 'txt'))
                }
              >
                Save .txt
              </button>
              <button
                className="btn small"
                disabled={!text}
                onClick={() => {
                  setDraft(text);
                  window.location.hash = '#/studio';
                }}
              >
                Open in Studio
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
