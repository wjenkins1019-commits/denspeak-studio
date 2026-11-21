import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICES, VOICES_BY_ID, languageName, type Voice } from '../voices';
import { cachedVoiceIds, removeVoice, renderSpeech } from '../lib/tts';
import {
  CLONE_PREFIX,
  deleteClonedVoice,
  describeCloneError,
  subscribeCloneStatus,
} from '../lib/clone';
import {
  analyseClip,
  deleteProfile,
  listProfiles,
  loadSample,
  trainVoice,
  type AnalysedClip,
  type VoiceProfile,
} from '../lib/voiceProfile';
import {
  SAVED_VOICE_PREFIX,
  deleteSavedVoice,
  describeSavedVoice,
  listSavedVoices,
  type SavedVoice,
} from '../lib/presets';
import { Player } from '../components/Player';
import { LiveLevelMeter } from '../components/LiveLevelMeter';
import { RecordDot } from '../components/RecordDot';

interface VoicesProps {
  selectedId: string;
  onPick: (voiceId: string) => void;
}

interface Preview {
  voiceId: string;
  blob: Blob;
}

const PREVIEW_LINE = "Hi, I'm one of the voices in this studio. I run on your own machine.";

export default function Voices({ selectedId, onPick }: VoicesProps) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('all');
  const [cached, setCached] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Trainer state
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [savedVoices, setSavedVoices] = useState<SavedVoice[]>([]);
  const [clips, setClips] = useState<AnalysedClip[]>([]);
  const [trainName, setTrainName] = useState('');
  const [improving, setImproving] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [status, setStatus] = useState('');
  const [recording, setRecording] = useState(false);
  const [meterStream, setMeterStream] = useState<MediaStream | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const refreshCache = useMemo(() => async () => setCached(await cachedVoiceIds()), []);
  const refreshProfiles = useMemo(() => async () => setProfiles(await listProfiles()), []);

  useEffect(() => {
    void refreshCache();
    void refreshProfiles();
    void listSavedVoices().then(setSavedVoices);
  }, [refreshCache, refreshProfiles]);

  async function handleDeleteSaved(voice: SavedVoice) {
    await deleteSavedVoice(voice.id);
    setSavedVoices(await listSavedVoices());
    setStatus(`Removed "${voice.name}".`);
  }

  useEffect(() => subscribeCloneStatus((update) => {
    setStatus(update.percent !== undefined ? `${update.label} ${update.percent}%` : update.label);
  }), []);

  const languages = useMemo(
    () =>
      [...new Set(VOICES.map((voice) => voice.language))].sort((a, b) =>
        languageName(a).localeCompare(languageName(b)),
      ),
    [],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return VOICES.filter((voice) => {
      if (language !== 'all' && voice.language !== language) return false;
      if (!needle) return true;
      return (
        voice.name.toLowerCase().includes(needle) ||
        voice.id.toLowerCase().includes(needle) ||
        languageName(voice.language).toLowerCase().includes(needle)
      );
    });
  }, [language, query]);

  async function handlePreview(voice: Voice) {
    if (previewing) return;
    setError(null);
    setPreview(null);
    setPreviewing(voice.id);
    try {
      const blob = await renderSpeech(voice.sample || PREVIEW_LINE, voice.id);
      setPreview({ voiceId: voice.id, blob });
      await refreshCache();
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? `Preview failed: ${previewError.message}`
          : 'Preview failed. The voice model may be unavailable offline.',
      );
    } finally {
      setPreviewing(null);
    }
  }

  async function handleRemove(voice: Voice) {
    await removeVoice(voice.id);
    if (preview?.voiceId === voice.id) setPreview(null);
    await refreshCache();
  }

  async function addClips(blobs: { blob: Blob; name: string }[]) {
    if (blobs.length === 0) return;
    setAnalysing(true);
    setError(null);
    try {
      const analysed: AnalysedClip[] = [];
      for (const entry of blobs) {
        setStatus(`Analysing ${entry.name}…`);
        analysed.push(await analyseClip(entry.blob, entry.name));
      }
      setClips((current) => [...current, ...analysed]);
      setStatus(`Analysed ${analysed.length} clip${analysed.length === 1 ? '' : 's'}.`);
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? `Could not read that audio: ${analysisError.message}`
          : 'Could not read that audio file.',
      );
      setStatus('');
    } finally {
      setAnalysing(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    await addClips([...files].map((file) => ({ blob: file, name: file.name })));
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setMeterStream(null);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        void addClips([{ blob, name: `Recording ${new Date().toLocaleTimeString()}` }]);
      };

      recorder.start();
      recorderRef.current = recorder;
      setMeterStream(stream);
      setRecording(true);
    } catch {
      setError('Microphone unavailable. Check Windows microphone permissions.');
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function beginImprove(profile: VoiceProfile) {
    setImproving(profile.name);
    setTrainName(profile.name);
    setClips([]);
    setError(null);
    setStatus(`Add more clips for "${profile.name}" — the trainer keeps whichever sample scores highest.`);
  }

  function cancelImprove() {
    setImproving(null);
    setTrainName('');
    setClips([]);
    setStatus('');
  }

  async function handleBuild() {
    const name = trainName.trim();
    if (!name || building || clips.length === 0) return;

    setBuilding(true);
    setError(null);
    try {
      let pool = clips;

      // Improving an existing voice: bring the stored clip back into the pool so
      // the best sample wins across old and new recordings.
      if (improving) {
        const stored = await loadSample(improving);
        if (stored) {
          setStatus('Comparing with the sample this voice was built from…');
          const previous = await analyseClip(stored, 'existing sample');
          pool = [...clips, previous];
        }
      }

      setStatus('Building the voice profile…');
      const profile = await trainVoice(name, pool);
      await refreshProfiles();
      setClips([]);
      setImproving(null);
      setTrainName('');
      setStatus(`"${profile.name}" ready — score ${profile.score}/100. Use it in the Studio.`);
    } catch (buildError) {
      setStatus('');
      setError(`Could not build that voice: ${describeCloneError(buildError)}`);
    } finally {
      setBuilding(false);
    }
  }

  async function handleDeleteProfile(profile: VoiceProfile) {
    setError(null);
    await deleteClonedVoice(profile.name);
    await deleteProfile(profile.name);
    await refreshProfiles();
    if (improving === profile.name) cancelImprove();
    setStatus(`Removed "${profile.name}".`);
  }

  const bestScore = clips.length > 0 ? Math.max(...clips.map((clip) => clip.score)) : null;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Voices</span>
          <h1>{VOICES.length} on-device voices</h1>
          <p>
            Every built-in voice is a Piper model that renders locally. Your own voices are trained
            here from recordings you upload or capture.
          </p>
        </div>
      </header>

      <div className="card stack">
        <div>
          <h2>{improving ? `Improve "${improving}"` : 'Train a voice'}</h2>
          <p>
            Add 5–15 seconds or more of clean speech from one speaker. The trainer scores every clip
            for noise, clipping, level and length, then clones from the best one — so adding a
            cleaner recording improves the voice.
          </p>
        </div>

        <div className="row">
          <input
            type="text"
            value={trainName}
            placeholder="Name this voice"
            disabled={Boolean(improving)}
            onChange={(event) => setTrainName(event.target.value)}
          />
          <input
            type="file"
            accept="audio/*"
            multiple
            onChange={(event) => void handleFiles(event.target.files)}
          />
          <RecordDot active={recording} />
          <button className="btn" onClick={() => (recording ? stopRecording() : void startRecording())}>
            {recording ? 'Stop recording' : 'Record a clip'}
          </button>
          {improving && (
            <button className="btn ghost small" onClick={cancelImprove}>
              Cancel
            </button>
          )}
        </div>
        <LiveLevelMeter stream={meterStream} />

        {analysing && <p className="status">Analysing…</p>}

        {clips.length > 0 && (
          <div className="take-list">
            {[...clips]
              .sort((a, b) => b.score - a.score)
              .map((clip, index) => (
                <div key={`${clip.name}-${index}`} className="take-row">
                  <div className="meta">
                    <strong>
                      {clip.name} {index === 0 && bestScore !== null ? '· best' : ''}
                    </strong>
                    <small>
                      {clip.seconds.toFixed(1)} s ·{' '}
                      {clip.pitchHz > 0 ? `${Math.round(clip.pitchHz)} Hz` : 'no pitch'} · SNR{' '}
                      {clip.snrDb.toFixed(0)} dB · score {clip.score}/100
                      {clip.advice.length > 0 ? ` · ${clip.advice[0]}` : ''}
                    </small>
                  </div>
                  <div className="actions">
                    <button
                      className="btn ghost small danger"
                      onClick={() => setClips((current) => current.filter((item) => item !== clip))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}

        <div className="row">
          <button
            className="btn primary"
            disabled={building || analysing || clips.length === 0 || !trainName.trim()}
            onClick={() => void handleBuild()}
          >
            {building ? 'Building…' : improving ? 'Rebuild voice' : 'Build voice'}
          </button>
          {bestScore !== null && <small className="muted">Best clip scores {bestScore}/100</small>}
        </div>

        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}

        {profiles.length === 0 ? (
          <div className="hint">
            No trained voices yet. English samples work best; music and background noise hurt the
            result.
          </div>
        ) : (
          <div className="take-list">
            {profiles.map((profile) => (
              <div key={profile.name} className="take-row">
                <div className="meta">
                  <strong>{profile.name}</strong>
                  <small>
                    score {profile.score}/100 · {profile.clipCount} clip
                    {profile.clipCount === 1 ? '' : 's'} · {profile.seconds.toFixed(0)} s total
                  </small>
                </div>
                <div className="actions">
                  <button className="btn small" onClick={() => onPick(`${CLONE_PREFIX}${profile.name}`)}>
                    Use
                  </button>
                  <button className="btn ghost small" onClick={() => beginImprove(profile)}>
                    Improve
                  </button>
                  <button className="btn ghost small danger" onClick={() => void handleDeleteProfile(profile)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {savedVoices.length > 0 && (
        <div className="card stack">
          <div>
            <h2>Saved voices</h2>
            <p>
              Voices you built from a base model plus shaping. Picking one recalls its pitch, EQ,
              speed and naturalness in the Studio.
            </p>
          </div>
          <div className="take-list">
            {savedVoices.map((entry) => (
              <div key={entry.id} className="take-row">
                <div className="meta">
                  <strong>{entry.name}</strong>
                  <small>
                    {VOICES_BY_ID.get(entry.base)?.name ?? entry.base} · {describeSavedVoice(entry)}
                  </small>
                </div>
                <div className="actions">
                  <button className="btn small" onClick={() => onPick(`${SAVED_VOICE_PREFIX}${entry.id}`)}>
                    Use
                  </button>
                  <button
                    className="btn ghost small danger"
                    onClick={() => void handleDeleteSaved(entry)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="toolbar">
        <input
          type="search"
          value={query}
          placeholder="Search by name, language or model id…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="all">All languages</option>
          {languages.map((tag) => (
            <option key={tag} value={tag}>
              {languageName(tag)}
            </option>
          ))}
        </select>
        <small className="muted">{visible.length} shown</small>
      </div>

      {preview && (
        <div className="card stack">
          <h2>Preview</h2>
          <Player blob={preview.blob} name={`${preview.voiceId}-preview`} />
        </div>
      )}

      <div className="voice-grid">
        {visible.map((voice) => {
          const isCached = cached.includes(voice.id);
          const isPreviewing = previewing === voice.id;
          return (
            <article key={voice.id} className={voice.id === selectedId ? 'voice-card selected' : 'voice-card'}>
              <header>
                <strong>{voice.name}</strong>
                {isCached ? <span className="badge">cached</span> : <span className="badge warm">online</span>}
              </header>
              <small>
                {languageName(voice.language)} · {voice.quality.replace('_', ' ')}
                {voice.gender ? ` · ${voice.gender}` : ''}
              </small>
              <small className="muted">{voice.id}</small>
              <div className="actions">
                <button className="btn small" disabled={Boolean(previewing)} onClick={() => void handlePreview(voice)}>
                  {isPreviewing ? 'Rendering…' : 'Preview'}
                </button>
                <button className="btn ghost small" onClick={() => onPick(voice.id)}>
                  Use
                </button>
                {isCached && (
                  <button className="btn ghost small danger" onClick={() => void handleRemove(voice)}>
                    Remove
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {visible.length === 0 && <div className="empty">No voice matches that search.</div>}
    </section>
  );
}
