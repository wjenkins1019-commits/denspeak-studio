import { useMemo, useRef, useState } from 'react';
import { decodeToMono, transformVoice, wavBlob, type VoiceShape } from '../lib/audio';
import { applyEq, sameBands, styleById, type EqBand } from '../lib/eq';
import { saveTake, type Take } from '../lib/library';
import { SETTING_KEYS, useSetting } from '../lib/settings';
import { Player } from '../components/Player';
import { LiveLevelMeter } from '../components/LiveLevelMeter';
import { RecordDot } from '../components/RecordDot';
import { SendTakeRow } from '../components/SendTakeRow';
import { HandoffNotice } from '../components/HandoffNotice';
import { useHandoffTake } from '../lib/useHandoffTake';
import { EqPanel } from '../components/EqPanel';

interface Preset {
  id: string;
  label: string;
  shape: Required<VoiceShape>;
}

// Pitch moves the note, formant moves the apparent size of the head and throat,
// brightness tilts the top end. Presets are starting points; the sliders below
// stay live so any of them can be nudged afterwards.
const PRESETS: Preset[] = [
  { id: 'original', label: 'Original', shape: { semitones: 0, formant: 0, brightness: 0 } },
  { id: 'higher', label: 'Higher', shape: { semitones: 2, formant: 0.25, brightness: 0.05 } },
  { id: 'lower', label: 'Lower', shape: { semitones: -2, formant: -0.28, brightness: -0.05 } },
  { id: 'deeper', label: 'Deeper', shape: { semitones: -3.5, formant: -0.35, brightness: -0.15 } },
  { id: 'brighter', label: 'Brighter', shape: { semitones: 3.5, formant: 0.45, brightness: 0.15 } },
  { id: 'warm', label: 'Warm', shape: { semitones: -1.5, formant: -0.12, brightness: -0.3 } },
  { id: 'crisp', label: 'Crisp', shape: { semitones: 0.5, formant: 0.08, brightness: 0.35 } },
  { id: 'announcer', label: 'Announcer', shape: { semitones: -2.5, formant: -0.15, brightness: 0.15 } },
  { id: 'intimate', label: 'Intimate', shape: { semitones: -1, formant: 0.1, brightness: -0.12 } },
  { id: 'm2f', label: 'Male → female', shape: { semitones: 5.5, formant: 0.55, brightness: 0.12 } },
  { id: 'f2m', label: 'Female → male', shape: { semitones: -5.5, formant: -0.55, brightness: -0.12 } },
  { id: 'chipmunk', label: 'Chipmunk', shape: { semitones: 7, formant: 0.7, brightness: 0.2 } },
  { id: 'monster', label: 'Monster', shape: { semitones: -7, formant: -0.7, brightness: -0.25 } },
];

interface Source {
  blob: Blob;
  name: string;
}

export default function Convert() {
  const [source, setSource] = useState<Source | null>(null);
  const [recording, setRecording] = useState(false);
  const [meterStream, setMeterStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [semitones, setSemitones] = useState(0);
  const [formant, setFormant] = useState(0);
  const [brightness, setBrightness] = useState(0);
  const [presetId, setPresetId] = useState('original');
  // Shares the Studio's choice, so a converted take matches its tone by default.
  const [eqId, setEqId] = useSetting<string>(SETTING_KEYS.eq, 'flat');
  // Same working bands as the Studio: dragging a node here edits the preset
  // shown on both graphs, and both applies it that way.
  const [editedBands, setEditedBands] = useSetting<EqBand[] | null>(SETTING_KEYS.eqEditedBands, null);
  const [levelOut, setLevelOut] = useState(() => styleById('flat').level);
  const [take, setTake] = useState<Take | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // A take sent here from another section arrives as this section's source.
  const handoff = useHandoffTake<Source>(
    'convert',
    source,
    (item) => setSource({ blob: item.blob, name: item.name }),
    (before) => setSource(before),
  );

  const style = useMemo(() => styleById(eqId), [eqId]);
  const bands = editedBands ?? style.bands;

  function applyPreset(preset: Preset) {
    setPresetId(preset.id);
    setSemitones(preset.shape.semitones);
    setFormant(preset.shape.formant);
    setBrightness(preset.shape.brightness);
    setTake(null);
  }

  function chooseStyle(id: string) {
    const next = styleById(id);
    setEqId(id);
    setEditedBands(null);
    setLevelOut(next.level);
    setTake(null);
  }

  function editBands(next: EqBand[]) {
    setEditedBands(sameBands(next, style.bands) ? null : next);
    setTake(null);
  }

  async function startRecording() {
    setError(null);
    setTake(null);
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
        setSource({ blob, name: 'Recording' });
      };

      recorder.start();
      recorderRef.current = recorder;
      setMeterStream(stream);
      setRecording(true);
      setSource(null);
    } catch {
      setError('Microphone unavailable. Check Windows microphone permissions.');
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setTake(null);
    setSource({ blob: file, name: file.name.replace(/\.[^.]+$/, '') });
  }

  async function handleConvert() {
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    setTake(null);

    try {
      // Let the button repaint before the synchronous DSP work starts.
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const decoded = await decodeToMono(source.blob);
      const shifted = transformVoice(decoded.samples, decoded.sampleRate, {
        semitones,
        formant,
        brightness,
      });

      // Same finishing as a Studio render: the style's bands, then optional
      // levelling. Both keep the length, so duration stays that of the shift.
      const styled =
        bands.length > 0 || levelOut
          ? applyEq(shifted, decoded.sampleRate, bands, { compress: levelOut })
          : shifted;

      const blob = wavBlob(styled, decoded.sampleRate);
      const shapeLabel = presetId === 'original' ? 'converted' : presetId;
      const styleLabel = style.id === 'flat' ? '' : ` · ${style.label}`;

      const saved = await saveTake({
        name: `${source.name} (${shapeLabel}${styleLabel})`,
        duration: styled.length / decoded.sampleRate,
        kind: 'convert',
        blob,
      });
      setTake(saved);
    } catch (convertError) {
      setError(
        convertError instanceof Error
          ? `Convert failed: ${convertError.message}`
          : 'Convert failed. Try a shorter or smaller file.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Convert</span>
          <h1>Change a recording</h1>
          <p>
            Record or drop in audio and shift its pitch, formants and brightness. Everything happens
            on this machine — the file never leaves it.
          </p>
        </div>
      </header>

      <div className="grid two">
        <div className="card stack">
          <h2>Source</h2>
          <div className="row">
            <RecordDot active={recording} />
            <button className="btn" onClick={() => (recording ? stopRecording() : void startRecording())}>
              {recording ? 'Stop recording' : 'Record a sample'}
            </button>
            <input type="file" accept="audio/*" onChange={(event) => void handleFile(event.target.files?.[0])} />
          </div>
          <LiveLevelMeter stream={meterStream} />

          {handoff.arrival && (
            <HandoffNotice
              item={handoff.arrival.item}
              replaced={handoff.arrival.before !== null}
              onKeep={handoff.keep}
            />
          )}

          {source ? (
            <>
              <small className="muted">Loaded: {source.name}</small>
              <Player blob={source.blob} name={`${source.name} source`} />
            </>
          ) : (
            <div className="hint">No source yet. Record from the microphone or pick an audio file.</div>
          )}
        </div>

        <div className="card stack">
          <h2>Shape</h2>
          <div className="preset-row">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={preset.id === presetId ? 'chip active' : 'chip'}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <label className="field">
            <span>
              Pitch <b>{semitones > 0 ? '+' : ''}{semitones.toFixed(1)} st</b>
            </span>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={semitones}
              onChange={(event) => setSemitones(Number(event.target.value))}
            />
          </label>

          <label className="field">
            <span>
              Formant <b>{formant.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={formant}
              onChange={(event) => setFormant(Number(event.target.value))}
            />
          </label>

          <label className="field">
            <span>
              Brightness <b>{brightness.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={brightness}
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
          </label>

        </div>
      </div>

      <div className="card stack">
        <div>
          <h2>EQ preset</h2>
          <p>
            The same presets as the Studio, applied to the shifted recording before it is saved. Kept
            apart from the voice shape above, so the two can be chosen independently.
          </p>
        </div>

        <EqPanel
          presetId={eqId}
          bands={bands}
          edited={editedBands !== null}
          onPresetChange={chooseStyle}
          onChangeBands={editBands}
        />

        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={levelOut}
            onChange={(event) => {
              setLevelOut(event.target.checked);
              setTake(null);
            }}
          />
          <span>Level out (compress + peak to −1 dBFS)</span>
        </label>

        <button className="btn primary" disabled={!source || busy} onClick={() => void handleConvert()}>
          {busy ? 'Converting…' : 'Convert and save'}
        </button>

        {error && <p className="error">{error}</p>}
        {take && (
          <>
            <Player blob={take.blob} name={take.name} takeId={take.id} />
            <p className="status">Converted and saved to your library.</p>
            <SendTakeRow name={take.name} blob={take.blob} />
          </>
        )}
      </div>
    </section>
  );
}
