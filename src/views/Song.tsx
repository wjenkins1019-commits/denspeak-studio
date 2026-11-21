import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICES, VOICES_BY_ID, voiceLabel } from '../voices';
import { renderSpeech } from '../lib/tts';
import { decodeToMono, wavBlob } from '../lib/audio';
import { concatSpeech, planSpeech, trimSilence } from '../lib/humanize';
import { detectTempo, type TempoInfo } from '../lib/beat';
import { arrangeRap, type RapMix } from '../lib/rap';
import { saveTake, type Take } from '../lib/library';
import { titleFromScript } from '../lib/format';
import { DEFAULT_VOICE, SETTING_KEYS, useSetting } from '../lib/settings';
import { Player } from '../components/Player';
import { takeHandoff } from '../lib/handoff';

const LYRICS_SAMPLE = `I write it once, the beat decides the pace
Every line I drop lands exactly in its place
No melody, just rhythm and a steady tone
The track is yours, the voice is still my own`;

interface Beat {
  name: string;
  samples: Float32Array;
  sampleRate: number;
}

export default function Song() {
  const [beat, setBeat] = useState<Beat | null>(null);
  const [tempo, setTempo] = useState<TempoInfo | null>(null);
  const [bpm, setBpm] = useState(90);
  const [offset, setOffset] = useState(0);
  const [beatsPerLine, setBeatsPerLine] = useState(4);
  const [beatGain, setBeatGain] = useState(0.7);
  const [breathGap, setBreathGap] = useState(0.15);

  const [voiceId, setVoiceId] = useSetting<string>(SETTING_KEYS.voice, DEFAULT_VOICE);
  const [lyrics, setLyrics] = useState(LYRICS_SAMPLE);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mix, setMix] = useState<{ blob: Blob; result: RapMix; take: Take } | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  // A take handed over from Studio arrives as this section's beat.
  useEffect(() => {
    const handed = takeHandoff('song');
    if (handed) void readBeat(handed.name, handed.blob);
    // Runs once: the hand-off is consumed on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = useMemo(
    () =>
      lyrics
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    [lyrics],
  );

  const beatSeconds = 60 / Math.max(30, bpm);
  const estimatedSeconds = lines.length * beatSeconds * beatsPerLine;

  function handleBeat(files: FileList | null) {
    const file = files?.[0];
    if (file) void readBeat(file.name, file);
  }

  async function readBeat(name: string, file: Blob) {
    setError(null);
    setBusy(true);
    setStatus('Reading the beat…');

    try {
      const decoded = await decodeToMono(file);
      setStatus('Finding the tempo…');
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const detected = detectTempo(decoded.samples, decoded.sampleRate);
      setBeat({ name, samples: decoded.samples, sampleRate: decoded.sampleRate });
      setTempo(detected);

      if (detected.bpm > 0) {
        setBpm(Math.round(detected.bpm));
        setOffset(Math.round(detected.offset * 100) / 100);
        setStatus(
          detected.confidence < 0.25
            ? `Tempo guess ${detected.bpm.toFixed(0)} BPM (low confidence) — adjust it if the words drift.`
            : `Detected ${detected.bpm.toFixed(0)} BPM, first beat at ${detected.offset.toFixed(2)} s.`,
        );
      } else {
        setStatus('Could not find a pulse — set the BPM by hand.');
      }
    } catch (readError) {
      setStatus('');
      setError(
        readError instanceof Error
          ? `Could not read that audio: ${readError.message}`
          : 'Could not read that audio file.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRender() {
    if (busy) return;
    if (!beat) {
      setError('Upload a beat first.');
      return;
    }
    if (lines.length === 0) {
      setError('Write at least one line.');
      return;
    }

    setBusy(true);
    setError(null);
    setMix(null);

    try {
      const rendered = [];

      for (let index = 0; index < lines.length; index += 1) {
        setStatus(`Recording line ${index + 1} of ${lines.length}…`);
        const blocks = planSpeech(lines[index]);
        const pieces: Float32Array[] = [];
        let sampleRate = 22050;

        for (const block of blocks) {
          const wav = await renderSpeech(block.text, voiceId);
          const decoded = await decodeToMono(wav);
          sampleRate = decoded.sampleRate;
          pieces.push(trimSilence(decoded.samples, decoded.sampleRate));
        }

        rendered.push({ text: lines[index], samples: concatSpeech(pieces), sampleRate });
      }

      setStatus('Laying the lines on the grid…');
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const result = arrangeRap(beat, rendered, {
        bpm: Math.max(30, bpm),
        offset: Math.max(0, offset),
        beatsPerLine,
        beatGain,
        breathGap,
      });

      const blob = wavBlob(result.samples, result.sampleRate);
      const name = `Rap — ${titleFromScript(lines.join(' ')).replace(/\.wav$/i, '')}`;
      const take = await saveTake({
        name,
        duration: result.seconds,
        kind: 'song',
        voiceId,
        voiceName: VOICES_BY_ID.get(voiceId)?.name,
        blob,
      });

      setMix({ blob, result, take });
      setStatus(`Done — ${result.seconds.toFixed(1)} s at ${result.bpm.toFixed(1)} BPM.`);
    } catch (renderError) {
      setStatus('');
      setError(
        renderError instanceof Error
          ? `Render failed: ${renderError.message}`
          : 'Render failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Song</span>
          <h1>Rap over your beat</h1>
          <p>
            Upload a track, write one line per bar, and each line is time-fitted to the beat grid
            and mixed under it. Delivery is spoken-word, not melodic — these voices are speech
            models, so they rap, they do not sing.
          </p>
        </div>
      </header>

      <div className="grid two">
        <div className="card stack">
          <div>
            <h2>Beat</h2>
            <p>Any audio file. The pulse is detected from the low end; you can correct it.</p>
          </div>

          <div className="row">
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              onChange={(event) => handleBeat(event.target.files)}
            />
            {beat && <small className="muted">{beat.name}</small>}
          </div>

          <div className="row">
            <label className="field" style={{ width: 130 }}>
              <span>BPM</span>
              <input
                type="number"
                min={40}
                max={220}
                step={1}
                value={bpm}
                onChange={(event) => setBpm(Number(event.target.value))}
              />
            </label>
            <label className="field" style={{ width: 150 }}>
              <span>First beat (s)</span>
              <input
                type="number"
                min={0}
                max={10}
                step={0.01}
                value={offset}
                onChange={(event) => setOffset(Number(event.target.value))}
              />
            </label>
            <label className="field" style={{ width: 150 }}>
              <span>Line length</span>
              <select value={beatsPerLine} onChange={(event) => setBeatsPerLine(Number(event.target.value))}>
                <option value={2}>Half bar (2)</option>
                <option value={4}>One bar (4)</option>
                <option value={8}>Two bars (8)</option>
              </select>
            </label>
          </div>

          {tempo && (
            <small className="muted">
              {tempo.seconds.toFixed(1)} s of audio · confidence {Math.round(tempo.confidence * 100)}%
              {tempo.confidence < 0.25 ? ' · tempo is a guess' : ''}
            </small>
          )}

          {beat && (
            <div className="stack">
              <small className="muted">{beat.name}</small>
              <Player blob={wavBlob(beat.samples, beat.sampleRate)} name={`${beat.name}.beat`} />
            </div>
          )}

          {!beat && <div className="hint">No beat loaded yet.</div>}
        </div>

        <div className="card stack">
          <div>
            <h2>Lines</h2>
            <p>
              One line per slot. Each is fitted to {beatsPerLine} beats and starts on the grid, so a
              longer line is sped up and a short one is padded with silence.
            </p>
          </div>

          <label className="field">
            <span>Voice</span>
            <select value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
              {VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voiceLabel(voice)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Lyrics — {lines.length} line{lines.length === 1 ? '' : 's'}</span>
            <textarea
              value={lyrics}
              rows={8}
              spellCheck
              placeholder="One line per bar…"
              onChange={(event) => setLyrics(event.target.value)}
            />
          </label>

          <div className="row">
            <label className="field" style={{ width: 160 }}>
              <span>Beat level</span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={beatGain}
                onChange={(event) => setBeatGain(Number(event.target.value))}
              />
            </label>
            <label className="field" style={{ width: 160 }}>
              <span>Breath gap {Math.round(breathGap * 100)}%</span>
              <input
                type="range"
                min={0}
                max={0.4}
                step={0.05}
                value={breathGap}
                onChange={(event) => setBreathGap(Number(event.target.value))}
              />
            </label>
            <small className="muted">≈ {estimatedSeconds.toFixed(0)} s</small>
          </div>

          <button className="btn primary" disabled={busy || !beat || lines.length === 0} onClick={() => void handleRender()}>
            {busy ? 'Working…' : 'Rap it'}
          </button>

          {status && <p className="status">{status}</p>}
          {error && <p className="error">{error}</p>}

          {mix && (
            <div className="stack">
              <Player blob={mix.blob} name={mix.take.name} isSong />
              <div className="take-list">
                {mix.result.lines.map((line, index) => (
                  <div className="take-row" key={`${line.text}-${index}`}>
                    <div className="meta">
                      <strong>{line.text}</strong>
                      <small>
                        bar {index + 1} · starts {line.start.toFixed(2)} s
                        {line.stretched ? ' · time-fitted' : ''}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
              <small className="muted">Saved to your library as a song.</small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
