import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICES, languageName, voiceLabel, type Voice } from '../voices';
import type { NarrationSettings } from '../lib/narrate';
import {
  cancelGroup,
  clearGroup,
  enqueueJobs,
  getJobs,
  useRenderQueue,
  type QueueJob,
} from '../lib/renderQueue';
import { titleFromScript } from '../lib/format';
import { DEFAULT_VOICE } from '../lib/settings';
import { compareSideOf, COMPARE_GROUP, defaultSample } from '../lib/compare';

/** Second pick when A is already the default voice, so the pair differs. */
const FALLBACK_B = 'en_US-ryan-high';

function groupByLanguage(voices: Voice[]): Array<[string, Voice[]]> {
  const groups = new Map<string, Voice[]>();
  for (const voice of voices) {
    const list = groups.get(voice.language) ?? [];
    list.push(voice);
    groups.set(voice.language, list);
  }
  return [...groups.entries()]
    .sort((a, b) => languageName(a[0]).localeCompare(languageName(b[0])))
    .map(([language, list]) => [language, list.sort((a, b) => a.name.localeCompare(b.name))]);
}

function sideStatus(job: QueueJob | undefined): string {
  if (!job) return 'Not rendered yet.';
  if (job.state === 'failed') return `Failed: ${job.error ?? 'render failed.'}`;
  if (job.state === 'cancelled') return 'Cancelled.';
  if (job.state === 'done') return 'Ready.';
  return job.download !== null
    ? `${job.status} (${Math.round(job.download * 100)}%)`
    : job.status || 'Working…';
}

/**
 * Voice A/B: the same sample through two voices, side by side. Playing one
 * side pauses the other; the seek-lock mirrors scrubbing so a difference can
 * be re-heard at the same spot. Both sides share the caller's shape settings,
 * so the voices — not recipes — are what's compared.
 *
 * Object URLs follow the AbCompare pattern: created and revoked in the same
 * effect, so StrictMode remounts cannot leave a dead URL on an element.
 */
export function VoiceCompare({
  voiceA,
  script,
  settings,
}: {
  voiceA: string;
  script: string;
  settings: NarrationSettings;
}) {
  const [idA, setIdA] = useState(voiceA);
  const [idB, setIdB] = useState(voiceA === DEFAULT_VOICE ? FALLBACK_B : DEFAULT_VOICE);
  const [sample, setSample] = useState(() => defaultSample(script));
  const [lock, setLock] = useState(true);
  const [urls, setUrls] = useState<[string | null, string | null]>([null, null]);
  const audioA = useRef<HTMLAudioElement | null>(null);
  const audioB = useRef<HTMLAudioElement | null>(null);

  const grouped = useMemo(() => groupByLanguage(VOICES), []);
  const queueTick = useRenderQueue();
  const jobs = useMemo(() => getJobs(), [queueTick]);
  const sides = useMemo<[QueueJob | undefined, QueueJob | undefined]>(() => {
    const found: Array<QueueJob | undefined> = [undefined, undefined];
    for (const job of jobs) {
      const side = compareSideOf(job);
      if (side !== null) found[side] = job;
    }
    return [found[0], found[1]];
  }, [jobs]);
  const busy = sides.some((job) => job?.state === 'working' || job?.state === 'queued');
  const blobs: Array<Blob | null> = [sides[0]?.take?.blob ?? null, sides[1]?.take?.blob ?? null];

  useEffect(() => {
    const created = blobs.map((blob) => (blob ? URL.createObjectURL(blob) : null)) as [
      string | null,
      string | null,
    ];
    setUrls(created);
    return () => {
      for (const url of created) if (url) URL.revokeObjectURL(url);
    };
    // Blobs identity-change per render; the pair is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobs[0], blobs[1]]);

  function handleRenderBoth() {
    const text = sample.trim();
    if (!text || busy) return;
    clearGroup(COMPARE_GROUP);
    const ids = [idA, idB];
    enqueueJobs(
      ids.map((id, index) => ({
        group: COMPARE_GROUP,
        chapterIndex: index,
        label: `Compare ${index === 0 ? 'A' : 'B'}`,
        takeName: `${titleFromScript(text)} — ${id === idA ? 'A' : 'B'}`,
        text,
        settings: {
          ...settings,
          voice: { baseVoiceId: id, isClone: false, cloneName: '' },
        },
        voiceId: id,
      })),
    );
  }

  function mirror(from: HTMLAudioElement | null, to: HTMLAudioElement | null) {
    if (lock && from && to) {
      try {
        to.currentTime = from.currentTime;
      } catch {
        // Media not ready yet; the next seek lands it.
      }
    }
  }

  const names = [idA, idB].map(
    (id) => VOICES.find((voice) => voice.id === id)?.name ?? id,
  );

  return (
    <div className="stack">
      <div className="row">
        {([0, 1] as const).map((side) => (
          <label key={side} className="field">
            <span>Voice {side === 0 ? 'A' : 'B'}</span>
            <select
              value={side === 0 ? idA : idB}
              onChange={(event) =>
                (side === 0 ? setIdA : setIdB)(event.target.value)
              }
            >
              {grouped.map(([language, list]) => (
                <optgroup key={language} label={languageName(language)}>
                  {list.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voiceLabel(voice)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ))}
      </div>

      <label className="field">
        <span>
          Sample · {sample.trim() ? sample.trim().split(/\s+/).length : 0} words · keep it short,
          both sides render every word
        </span>
        <textarea
          rows={3}
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          placeholder="A paragraph or two to hear in both voices…"
        />
      </label>

      <div className="row">
        <button
          className="btn primary"
          disabled={!sample.trim() || busy}
          onClick={handleRenderBoth}
        >
          {busy ? 'Rendering…' : 'Render both'}
        </button>
        {busy && (
          <button className="btn ghost" onClick={() => cancelGroup(COMPARE_GROUP)}>
            Cancel
          </button>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={lock}
            onChange={(event) => setLock(event.target.checked)}
          />
          Lock seekers
        </label>
      </div>
      <small className="muted">
        Renders run one after the other — the voice engine is never driven twice at once.
      </small>

      <div className="row">
        {([0, 1] as const).map((side) => (
          <div key={side} className="stack" style={{ flex: 1 }}>
            <strong>
              {side === 0 ? 'A' : 'B'} · {names[side]}
            </strong>
            <span className="status">{sideStatus(sides[side])}</span>
            {urls[side] && (
              <audio
                controls
                src={urls[side] ?? undefined}
                ref={side === 0 ? audioA : audioB}
                onPlay={() => (side === 0 ? audioB : audioA).current?.pause()}
                onSeeked={(event) =>
                  mirror(
                    event.currentTarget,
                    (side === 0 ? audioB : audioA).current,
                  )
                }
              />
            )}
            {urls[side] && (
              <a className="btn ghost small" href={urls[side] ?? undefined} download={`${names[side]}-compare.wav`}>
                Download {side === 0 ? 'A' : 'B'}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
