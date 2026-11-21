import { useEffect, useMemo, useState } from 'react';
import { VOICES, VOICES_BY_ID, languageName, voiceLabel, type Voice } from '../voices';
import { clearAllVoices, removeVoice, voiceCacheUsage, type VoiceCacheEntry } from '../lib/tts';
import {
  clearTranscriptionCache,
  estimateStorage,
  removeTranscriptionModel,
  transcriptionCacheUsage,
  type TranscriptionCacheUsage,
} from '../lib/modelCache';
import { TRANSCRIBE_MODELS } from '../lib/transcribe';
import { formatBytes } from '../lib/format';
import {
  loadPronunciations,
  savePronunciations,
  type Pronunciation,
} from '../lib/pronounce';
import { SETTING_KEYS, useSetting, type Theme } from '../lib/settings';
import { LogoMark } from '../components/Logo';

interface SettingsProps {
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

export default function Settings({
  voiceId,
  onVoiceChange,
  speed,
  onSpeedChange,
  theme,
  onThemeChange,
}: SettingsProps) {
  const [voices, setVoices] = useState<VoiceCacheEntry[]>([]);
  const [transcribe, setTranscribe] = useState<TranscriptionCacheUsage>({
    models: [],
    otherBytes: 0,
    otherFiles: 0,
  });
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>({});
  const [busy, setBusy] = useState(false);
  const [transcribeModel] = useSetting<string>(
    SETTING_KEYS.transcribeModel,
    TRANSCRIBE_MODELS[1].id,
  );
  const [pronunciations, setPronunciations] = useState<Pronunciation[]>(() => loadPronunciations());
  const [match, setMatch] = useState('');
  const [sayAs, setSayAs] = useState('');
  const [notifyRenders, setNotifyRenders] = useSetting<boolean>(SETTING_KEYS.notifyRenders, true);

  const refresh = useMemo(
    () => async () => {
      const [voiceEntries, transcribeUsage, storageEstimate] = await Promise.all([
        voiceCacheUsage(),
        transcriptionCacheUsage(),
        estimateStorage(),
      ]);
      setVoices(voiceEntries);
      setTranscribe(transcribeUsage);
      setStorage(storageEstimate);
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Voice[]>();
    for (const voice of VOICES) {
      const list = groups.get(voice.language) ?? [];
      list.push(voice);
      groups.set(voice.language, list);
    }
    return [...groups.entries()]
      .sort((a, b) => languageName(a[0]).localeCompare(languageName(b[0])))
      .map(([language, list]) => [language, list.sort((a, b) => a.name.localeCompare(b.name))] as const);
  }, []);

  async function handleClearModels() {
    if (!window.confirm('Remove every cached voice model? They will download again when next used.')) {
      return;
    }
    setBusy(true);
    await clearAllVoices();
    await refresh();
    setBusy(false);
  }

  async function handleRemove(id: string) {
    setBusy(true);
    await removeVoice(id);
    await refresh();
    setBusy(false);
  }

  async function handleClearTranscription() {
    if (
      !window.confirm('Remove every cached transcription file? Models download again when next used.')
    ) {
      return;
    }
    setBusy(true);
    await clearTranscriptionCache();
    await refresh();
    setBusy(false);
  }

  async function handleRemoveTranscription(id: string) {
    setBusy(true);
    await removeTranscriptionModel(id);
    await refresh();
    setBusy(false);
  }

  const voiceBytes = voices.reduce((sum, entry) => sum + entry.bytes, 0);
  const transcribeBytes =
    transcribe.models.reduce((sum, entry) => sum + entry.bytes, 0) + transcribe.otherBytes;

  const current = VOICES_BY_ID.get(voiceId);

  function persistPronunciations(next: Pronunciation[]): void {
    setPronunciations(next);
    savePronunciations(next);
  }

  function handleAddPronunciation(): void {
    const word = match.trim();
    const spoken = sayAs.trim();
    if (!word || !spoken) return;
    persistPronunciations([
      ...pronunciations,
      { id: `p${Date.now().toString(36)}`, match: word, sayAs: spoken },
    ]);
    setMatch('');
    setSayAs('');
  }

  function handleRemovePronunciation(id: string): void {
    persistPronunciations(pronunciations.filter((entry) => entry.id !== id));
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>Defaults and cache</h1>
          <p>Preferences are stored in this app's local storage and survive restarts.</p>
        </div>
      </header>

      <div className="grid two">
        <div className="card stack">
          <h2>Defaults</h2>
          <label className="field">
            <span>Default voice</span>
            <select value={voiceId} onChange={(event) => onVoiceChange(event.target.value)}>
              {grouped.map(([language, voices]) => (
                <optgroup key={language} label={languageName(language)}>
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voiceLabel(voice)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="field">
            <span>
              Default speed <b>{speed.toFixed(2)}×</b>
            </span>
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.05}
              value={speed}
              onChange={(event) => onSpeedChange(Number(event.target.value))}
            />
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={notifyRenders}
              onChange={(event) => setNotifyRenders(event.target.checked)}
            />
            Notify when background renders finish
          </label>

          <dl className="kv">
            <dt>Current voice</dt>
            <dd>{current ? `${current.name} (${current.id})` : 'Unknown'}</dd>
            <dt>Speech engine</dt>
            <dd>vits-web · ONNX Runtime (WASM) · Piper models</dd>
          </dl>
        </div>

        <div className="card stack">
          <div className="row between">
            <h2>Cached models</h2>
            {storage.usage !== undefined && <small className="muted">{formatBytes(storage.usage)} on disk</small>}
          </div>

          <div className="row between">
            <h3>Voices · {formatBytes(voiceBytes)}</h3>
            <button
              className="btn ghost small danger"
              disabled={busy || voices.length === 0}
              onClick={() => void handleClearModels()}
            >
              Clear all
            </button>
          </div>

          {voices.length === 0 && (
            <div className="hint">
              No voices cached yet. A voice downloads the first time you render or preview it.
            </div>
          )}

          {voices.map((entry) => {
            const inUse = entry.id === voiceId;
            return (
              <div key={entry.id} className="row between">
                <small>
                  {VOICES_BY_ID.get(entry.id)?.name ?? entry.id} · {formatBytes(entry.bytes)}
                  {inUse && ' · in use'}
                </small>
                <button
                  className="btn ghost small danger"
                  disabled={busy || inUse}
                  title={inUse ? 'Switch the default voice first' : undefined}
                  onClick={() => void handleRemove(entry.id)}
                >
                  Remove
                </button>
              </div>
            );
          })}

          <div className="row between">
            <h3>Transcription · {formatBytes(transcribeBytes)}</h3>
            <button
              className="btn ghost small danger"
              disabled={busy || transcribeBytes === 0}
              onClick={() => void handleClearTranscription()}
            >
              Clear all
            </button>
          </div>

          {transcribe.models.map((entry) => {
            const inUse = entry.id === transcribeModel;
            const downloaded = entry.files > 0;
            return (
              <div key={entry.id} className="row between">
                <small>
                  {entry.label} · {downloaded ? formatBytes(entry.bytes) : 'not downloaded'}
                  {inUse && ' · in use'}
                </small>
                <button
                  className="btn ghost small danger"
                  disabled={busy || !downloaded || inUse}
                  title={inUse ? 'Switch the transcription model first' : undefined}
                  onClick={() => void handleRemoveTranscription(entry.id)}
                >
                  Remove
                </button>
              </div>
            );
          })}

          {transcribe.otherFiles > 0 && (
            <div className="row between">
              <small>Other cached files · {formatBytes(transcribe.otherBytes)}</small>
            </div>
          )}

          <div className="hint">
            Voices live in the app's origin private file system, transcription models in its web
            cache — never in this project folder. Removing one only costs another download.
          </div>
        </div>

        <div className="card stack">
          <h2>Appearance</h2>
          <p>Light is for bright rooms; dark is the studio look. Everything else stays the same.</p>
          <div className="preset-row">
            <button
              className={theme === 'light' ? 'chip active' : 'chip'}
              onClick={() => onThemeChange('light')}
            >
              Light
            </button>
            <button
              className={theme === 'dark' ? 'chip active' : 'chip'}
              onClick={() => onThemeChange('dark')}
            >
              Dark
            </button>
          </div>
        </div>

        <div className="card stack">
          <h2>Pronunciations</h2>
          <p>
            Read one thing as another — names, abbreviations, invented words. Applied to
            the text of every render, including cloned voices.
          </p>

          <div className="row pronounce-add">
            <label className="field">
              <span>Read this</span>
              <input
                type="text"
                value={match}
                placeholder="e.g. NGO"
                maxLength={80}
                onChange={(event) => setMatch(event.target.value)}
              />
            </label>
            <label className="field">
              <span>As</span>
              <input
                type="text"
                value={sayAs}
                placeholder="e.g. N G O"
                maxLength={80}
                onChange={(event) => setSayAs(event.target.value)}
              />
            </label>
            <button
              className="btn"
              disabled={!match.trim() || !sayAs.trim()}
              onClick={handleAddPronunciation}
            >
              Add
            </button>
          </div>

          {pronunciations.length === 0 && (
            <div className="hint">
              Nothing yet. Matching ignores case and whole words, so “St” never rewrites
              “Sting”.
            </div>
          )}

          {pronunciations.map((entry) => (
            <div key={entry.id} className="row between">
              <small>
                <b>{entry.match}</b> → {entry.sayAs}
              </small>
              <button
                className="btn ghost small danger"
                onClick={() => handleRemovePronunciation(entry.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="card stack about">
          <div className="brand">
            <span className="brand-mark">
              <LogoMark size={46} />
            </span>
            <div>
              <strong>Denspeak Studio</strong>
              <span>voice studio</span>
            </div>
          </div>
          <p>
            On-device voices in 36 languages, EQ presets, shaping tools and voice cloning — nothing
            leaves this machine.
          </p>
          <div className="credit">A 965 Media Creation</div>
        </div>
      </div>
    </section>
  );
}
