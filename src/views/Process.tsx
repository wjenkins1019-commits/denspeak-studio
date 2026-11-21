import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICES, VOICES_BY_ID, voiceLabel } from '../voices';
import { renderSpeech } from '../lib/tts';
import { decodeToMono, transformVoice, wavBlob } from '../lib/audio';
import { analyseVoice, type VoiceMetrics } from '../lib/voiceAnalysis';
import {
  applyEq,
  deleteCustomStyle,
  isCustomStyleId,
  sameBands,
  saveCustomStyle,
  styleById,
  type EqBand,
} from '../lib/eq';
import { saveTake } from '../lib/library';
import { SETTING_KEYS, useSetting } from '../lib/settings';
import { AbCompare } from '../components/AbCompare';
import { Player } from '../components/Player';
import { LiveLevelMeter } from '../components/LiveLevelMeter';
import { RecordDot } from '../components/RecordDot';
import { EqPanel } from '../components/EqPanel';
import { SendTakeRow } from '../components/SendTakeRow';
import { HandoffNotice } from '../components/HandoffNotice';
import { useHandoffTake } from '../lib/useHandoffTake';

const BANK_TEXT = 'This is a sample from the voice bank, shaped by the equaliser.';

const BAND_TYPES: Array<{ value: EqBand['type']; label: string }> = [
  { value: 'peak', label: 'Peak' },
  { value: 'lowShelf', label: 'Low shelf' },
  { value: 'highShelf', label: 'High shelf' },
  { value: 'highPass', label: 'High pass' },
  { value: 'lowPass', label: 'Low pass' },
];

interface Source {
  blob: Blob;
  label: string;
  /** Carried through from a handed take; the EQ keeps the words in time. */
  captions?: { srt: string; vtt: string };
}

interface Result {
  blob: Blob;
  label: string;
  seconds: number;
}

/** Last editing state, so leaving the view does not throw bands away. */
interface EqDraft {
  bands: EqBand[];
  level: boolean;
}

export default function Process() {
  const [bankVoice, setBankVoice] = useState(VOICES[0]?.id ?? '');
  const [bankText, setBankText] = useState(BANK_TEXT);

  const [draft, setDraft] = useSetting<EqDraft | null>(SETTING_KEYS.eqDraft, null);
  const [styleId, setStyleId] = useSetting<string>(SETTING_KEYS.eq, 'voice-clarity');
  const [bands, setBands] = useState<EqBand[]>(() =>
    (draft ? draft.bands : styleById(styleId).bands).map((band) => ({ ...band })),
  );
  const [level, setLevel] = useState(() => draft?.level ?? styleById(styleId).level);
  const [newStyleName, setNewStyleName] = useState('');
  const [trimDb, setTrimDb] = useState(0);

  const [source, setSource] = useState<Source | null>(null);
  const [analysis, setAnalysis] = useState<VoiceMetrics | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [meterStream, setMeterStream] = useState<MediaStream | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // A take sent here from another section arrives as this section's sample.
  const handoff = useHandoffTake<Source>(
    'process',
    source,
    (item) => loadSource(item.blob, item.name, item.captions),
    (before) => loadSource(before.blob, before.label, before.captions),
  );

  const style = useMemo(() => styleById(styleId), [styleId]);

  // Keep the working bands so navigating away and back resumes where you left off.
  useEffect(() => {
    setDraft({ bands, level });
  }, [bands, level, setDraft]);

  /** True once the bands differ from the style they were loaded from. */
  const edited = useMemo(
    () => !sameBands(bands, style.bands) || level !== style.level,
    [bands, level, style],
  );

  function chooseStyle(id: string) {
    const next = styleById(id);
    setStyleId(id);
    setBands(next.bands.map((band) => ({ ...band })));
    setLevel(next.level);
    setResult(null);
  }

  function handleSaveStyle() {
    const created = saveCustomStyle({ label: newStyleName, bands, level });
    setStyleId(created.id);
    setNewStyleName('');
    setStatus(`Saved “${created.label}” as a preset.`);
  }

  function handleDeleteStyle() {
    if (!isCustomStyleId(styleId)) return;
    const label = style.label;
    deleteCustomStyle(styleId);
    chooseStyle('flat');
    setStatus(`Deleted “${label}”.`);
  }

  function updateBand(index: number, patch: Partial<EqBand>) {
    setBands((current) => current.map((band, i) => (i === index ? { ...band, ...patch } : band)));
    setResult(null);
  }

  function addBand() {
    setBands((current) => [...current, { type: 'peak', frequency: 1000, gainDb: 0, q: 1 }]);
  }

  function removeBand(index: number) {
    setBands((current) => current.filter((_, i) => i !== index));
    setResult(null);
  }

  function loadSource(blob: Blob, label: string, captions?: { srt: string; vtt: string }) {
    setSource({ blob, label, captions });
    setAnalysis(null);
    setResult(null);
    setError(null);
    setStatus(`${label} loaded. Shape it, then apply.`);
    void measure(blob);
  }

  async function measure(blob: Blob) {
    try {
      const decoded = await decodeToMono(blob);
      setAnalysis(analyseVoice(decoded.samples, decoded.sampleRate));
    } catch {
      setAnalysis(null);
    }
  }

  /** Render the chosen bank voice, then bend it to the measured sample. */
  async function matchWithBankVoice() {
    if (!analysis || busy) return;
    setBusy(true);
    setError(null);
    setStatus('Rendering the bank voice…');

    try {
      const rendered = await renderSpeech(bankText.trim() || BANK_TEXT, bankVoice);
      const decoded = await decodeToMono(rendered);
      const voice = VOICES_BY_ID.get(bankVoice);

      setStatus('Matching pitch, formants and brightness…');
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const shaped = transformVoice(decoded.samples, decoded.sampleRate, analysis.recipe);

      const blob = wavBlob(shaped, decoded.sampleRate);
      const seconds = shaped.length / decoded.sampleRate;
      const name = `${voice?.name ?? bankVoice} matched to ${source?.label ?? 'sample'}`;

      setResult({ blob, label: name, seconds });
      await saveTake({
        name,
        duration: seconds,
        kind: 'processed',
        captions: source?.captions,
        blob,
      });
      setStatus(`Matched and saved (${seconds.toFixed(1)} s).`);
    } catch (matchError) {
      setStatus('');
      setError(
        matchError instanceof Error
          ? `Could not match that voice: ${matchError.message}`
          : 'Could not match that voice.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function renderBankSample() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus('Rendering a voice-bank sample…');
    try {
      const blob = await renderSpeech(bankText.trim() || BANK_TEXT, bankVoice);
      const voice = VOICES_BY_ID.get(bankVoice);
      loadSource(blob, `${voice?.name ?? 'Voice bank'} sample`);
    } catch (renderError) {
      setStatus('');
      setError(
        renderError instanceof Error
          ? `Could not render that voice: ${renderError.message}`
          : 'Could not render that voice.',
      );
    } finally {
      setBusy(false);
    }
  }

  function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (file) loadSource(file, file.name);
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
        loadSource(blob, `Recording ${new Date().toLocaleTimeString()}`);
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

  async function handleApply() {
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    setStatus('Processing…');

    try {
      const decoded = await decodeToMono(source.blob);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const processed = applyEq(decoded.samples, decoded.sampleRate, bands, {
        compress: level,
        outputGainDb: trimDb,
      });
      const blob = wavBlob(processed, decoded.sampleRate);
      const name = `${source.label} — ${style.label}`;
      const seconds = processed.length / decoded.sampleRate;

      setResult({ blob, label: name, seconds });
      await saveTake({
        name,
        duration: seconds,
        kind: 'processed',
        captions: source?.captions,
        blob,
      });
      setStatus(`Processed ${seconds.toFixed(1)} s and saved it to your library.`);
    } catch (processError) {
      setStatus('');
      setError(
        processError instanceof Error
          ? `Could not process that audio: ${processError.message}`
          : 'Could not process that audio.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Shape</span>
          <h1>EQ and level a sample</h1>
          <p>
            Pull a sample from the voice bank or load your own recording, shape it with a parametric
            equaliser, level it, and save the result. Nothing leaves the machine.
          </p>
        </div>
      </header>

      <div className="grid two">
        <div className="card stack">
          <div>
            <h2>Source</h2>
            <p>Render a sample from any built-in voice, or load your own audio.</p>
          </div>

          <label className="field">
            <span>Voice bank</span>
            <select value={bankVoice} onChange={(event) => setBankVoice(event.target.value)}>
              {VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voiceLabel(voice)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Sample text</span>
            <textarea
              value={bankText}
              rows={3}
              onChange={(event) => setBankText(event.target.value)}
              placeholder="Text to speak for the sample…"
            />
          </label>

          <button className="btn" disabled={busy} onClick={() => void renderBankSample()}>
            {busy ? 'Working…' : 'Render sample'}
          </button>

          <div className="row">
            <input type="file" accept="audio/*" onChange={(event) => handleFile(event.target.files)} />
            <RecordDot active={recording} />
            <button className="btn ghost" onClick={() => (recording ? stopRecording() : void startRecording())}>
              {recording ? 'Stop recording' : 'Record'}
            </button>
          </div>
          <LiveLevelMeter stream={meterStream} />

          {handoff.arrival && (
            <HandoffNotice
              item={handoff.arrival.item}
              replaced={handoff.arrival.before !== null}
              onKeep={handoff.keep}
            />
          )}

          {source && (
            <div className="stack">
              <small className="muted">{source.label}</small>
              <Player blob={source.blob} name={source.label} />
            </div>
          )}

          {analysis && (
            <div className="stack">
              <span className="eyebrow">Analysis</span>
              <div className="take-list">
                <div className="take-row">
                  <div className="meta">
                    <strong>
                      {analysis.register} · {analysis.pitchHz.toFixed(0)} Hz
                    </strong>
                    <small>
                      range {analysis.rangeSemitones.toFixed(1)} st · steady{' '}
                      {Math.round(analysis.steadiness * 100)}% · HNR {analysis.hnrDb.toFixed(0)} dB
                    </small>
                  </div>
                </div>
                <div className="take-row">
                  <div className="meta">
                    <strong>brightness {analysis.brightnessHz.toFixed(0)} Hz</strong>
                    <small>
                      formants F1 {analysis.formant1Hz.toFixed(0)} / F2 {analysis.formant2Hz.toFixed(0)} Hz · ≈
                      {analysis.syllableRate.toFixed(1)} syllables/s ·{' '}
                      {analysis.loudnessDb.toFixed(0)} dBFS
                    </small>
                  </div>
                </div>
              </div>
              <small className="muted">
                Match recipe: {analysis.recipe.semitones >= 0 ? '+' : ''}
                {analysis.recipe.semitones.toFixed(1)} st, formant{' '}
                {analysis.recipe.formant.toFixed(2)}, brightness {analysis.recipe.brightness.toFixed(2)}
              </small>
              {analysis.notes.map((note) => (
                <small key={note} className="muted">
                  · {note}
                </small>
              ))}
              <button className="btn" disabled={busy} onClick={() => void matchWithBankVoice()}>
                {busy ? 'Working…' : 'Make the bank voice sound like this sample'}
              </button>
            </div>
          )}

          {!source && <div className="hint">No sample loaded yet.</div>}
        </div>

        <div className="card stack">
          <h2>EQ preset</h2>

          <EqPanel
            presetId={styleId}
            bands={bands}
            edited={edited}
            onPresetChange={chooseStyle}
            onChangeBands={(next) => {
              setBands(next);
              setResult(null);
            }}
          />

          <div className="field">
            <span>Save as preset</span>
            <div className="row">
              <input
                type="text"
                value={newStyleName}
                placeholder="Name this preset"
                onChange={(event) => setNewStyleName(event.target.value)}
              />
              <button
                className="btn ghost small"
                disabled={!newStyleName.trim() || bands.length === 0}
                onClick={handleSaveStyle}
              >
                Save preset
              </button>
              {isCustomStyleId(styleId) && (
                <button className="btn ghost small danger" onClick={handleDeleteStyle}>
                  Delete preset
                </button>
              )}
            </div>
            <small className="muted">
              Saved presets appear in the Studio and Convert pickers as well.
            </small>
          </div>

          <div className="stack">
            {bands.length === 0 && <small className="muted">Flat — no bands. Add one to start shaping.</small>}
            {bands.map((band, index) => (
              <div className="row" key={`${band.type}-${index}`}>
                <select
                  value={band.type}
                  style={{ width: 112 }}
                  onChange={(event) => updateBand(index, { type: event.target.value as EqBand['type'] })}
                >
                  {BAND_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  style={{ width: 92 }}
                  value={band.frequency}
                  min={20}
                  max={20000}
                  step={10}
                  title="Frequency (Hz)"
                  onChange={(event) => updateBand(index, { frequency: Number(event.target.value) })}
                />
                <input
                  type="number"
                  style={{ width: 78 }}
                  value={band.gainDb}
                  min={-24}
                  max={24}
                  step={0.5}
                  title="Gain (dB)"
                  disabled={band.type === 'highPass' || band.type === 'lowPass'}
                  onChange={(event) => updateBand(index, { gainDb: Number(event.target.value) })}
                />
                <input
                  type="number"
                  style={{ width: 72 }}
                  value={band.q}
                  min={0.1}
                  max={10}
                  step={0.1}
                  title="Q / width"
                  disabled={band.type === 'lowShelf' || band.type === 'highShelf'}
                  onChange={(event) => updateBand(index, { q: Number(event.target.value) })}
                />
                <button className="btn ghost small danger" onClick={() => removeBand(index)}>
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <button className="btn ghost small" onClick={addBand}>
                Add band
              </button>
              <small className="muted">Frequency Hz · gain dB · Q</small>
            </div>
          </div>

          <div className="row">
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={level} onChange={(event) => setLevel(event.target.checked)} />
              <span>Level out (compress + peak to −1 dBFS)</span>
            </label>
            <label className="row" style={{ gap: 8 }}>
              <span>Trim</span>
              <input
                type="number"
                style={{ width: 78 }}
                value={trimDb}
                min={-24}
                max={24}
                step={0.5}
                onChange={(event) => setTrimDb(Number(event.target.value))}
              />
              <span>dB</span>
            </label>
          </div>

          <button className="btn primary" disabled={!source || busy} onClick={() => void handleApply()}>
            {busy ? 'Processing…' : 'Apply and save'}
          </button>

          {status && <p className="status">{status}</p>}
          {error && <p className="error">{error}</p>}

          {result && source && (
            <div className="stack">
              <small className="muted">
                {result.label} · {result.seconds.toFixed(1)} s
              </small>
              <AbCompare
                raw={source.blob}
                shaped={result.blob}
                rawLabel="Raw"
                shapedLabel="Shaped"
                captions={source.captions}
                captionsName={source.label}
              />
              <SendTakeRow
                name={result.label}
                blob={result.blob}
                duration={result.seconds}
                captions={source.captions}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
