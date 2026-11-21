import { useEffect, useState } from 'react';
import { describeLiveGrade, gradeLiveInput } from '../lib/liveLevel';

interface MeterReading {
  peakDb: number | null;
  noiseDb: number | null;
}

/**
 * Record-time input meter: a live peak bar plus Hot / Room-noise warnings off
 * the same bars the post-take LevelCheck grades (-3 dB peak ceiling, -60 dB
 * noise floor). Peaks are per-frame; the room estimate trails the quietest
 * recent audio with a slow release, so speech doesn't lift it but a humming
 * fridge does.
 *
 * Analyser math stays in a rAF loop with ~10 Hz state updates, and everything
 * is torn down when the stream changes or the view unmounts, so the mic and
 * the AudioContext never leak past Stop. `testLevels` drives the UI without
 * Web Audio, so tests never need a microphone.
 */
export function LiveLevelMeter({
  stream,
  testLevels,
}: {
  stream: MediaStream | null;
  testLevels?: MeterReading;
}) {
  const [reading, setReading] = useState<MeterReading>({
    peakDb: testLevels?.peakDb ?? null,
    noiseDb: testLevels?.noiseDb ?? null,
  });

  useEffect(() => {
    if (testLevels) {
      setReading({ peakDb: testLevels.peakDb, noiseDb: testLevels.noiseDb });
      return;
    }
    if (!stream) return;

    let context: AudioContext | null = null;
    let frame = 0;
    let stopped = false;
    try {
      const AudioCtor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      context = new AudioCtor();
    } catch {
      return;
    }
    const audio = context;
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let noiseDb = -120;

    const tick = () => {
      if (stopped) return;
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const magnitude = Math.abs(data[i]);
        if (magnitude > peak) peak = magnitude;
        sum += data[i] * data[i];
      }
      const peakDb = peak > 0 ? Math.max(-120, 20 * Math.log10(peak)) : -120;
      const rms = Math.sqrt(sum / data.length);
      const rmsDb = rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
      // Fast attack to quiet, slow release toward loud: speech never lifts
      // the floor, but a noisy room settles it upward within a second.
      noiseDb = rmsDb < noiseDb ? rmsDb : noiseDb + (rmsDb - noiseDb) * 0.02;
      frame += 1;
      if (frame % 6 === 0) setReading({ peakDb, noiseDb });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      try {
        source.disconnect();
      } catch {
        // Already torn down with the stream.
      }
      void audio.close().catch(() => {});
    };
  }, [stream, testLevels?.peakDb, testLevels?.noiseDb]);

  if (!stream && !testLevels) return null;

  const grade = gradeLiveInput(reading.peakDb, reading.noiseDb);
  const notes = describeLiveGrade(grade);
  const peakPct =
    reading.peakDb === null ? 0 : Math.min(100, Math.max(0, ((reading.peakDb + 60) / 60) * 100));

  return (
    <div className="stack" role="status" aria-label="Input level">
      <div className="progress">
        <span
          style={{
            width: `${peakPct}%`,
            background: grade.hot ? 'var(--danger)' : undefined,
          }}
        />
      </div>
      <small className="muted">
        Peak {reading.peakDb === null ? '—' : `${reading.peakDb.toFixed(0)} dB`} · room{' '}
        {reading.noiseDb === null ? '—' : `${reading.noiseDb.toFixed(0)} dB`}
      </small>
      {notes.map((note) => (
        <span key={note} className={grade.hot && note.startsWith('Hot') ? 'error' : 'warn'}>
          {note}
        </span>
      ))}
    </div>
  );
}
