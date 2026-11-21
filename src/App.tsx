import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_THEME, DEFAULT_VOICE, SETTING_KEYS, useSetting, type Theme } from './lib/settings';
import { cancelJob, getActiveJob, useRenderQueue } from './lib/renderQueue';
import {
  discardHandoff,
  discardHandoffQueue,
  isHandoffRoute,
  queuedTakes,
  type HandoffTarget,
} from './lib/handoff';
import { usePendingCounts } from './lib/useHandoffTake';
import { waitingAnnouncement, waitingFell } from './lib/waitingAnnouncement';
import { VOICES, VOICES_BY_ID } from './voices';
import { LogoMark } from './components/Logo';
import { QueuePanel } from './components/QueuePanel';
import Studio from './views/Studio';
import Convert from './views/Convert';
import Transcribe from './views/Transcribe';
import Process from './views/Process';
import Song from './views/Song';
import Library from './views/Library';
import Voices from './views/Voices';
import Settings from './views/Settings';

const ROUTES = [
  'studio',
  'convert',
  'transcribe',
  'process',
  'song',
  'library',
  'voices',
  'settings',
] as const;
type Route = (typeof ROUTES)[number];

const NAV: Array<{ id: Route; label: string; hint: string }> = [
  { id: 'studio', label: 'Studio', hint: 'Write and narrate' },
  { id: 'convert', label: 'Convert', hint: 'Shift a recording' },
  { id: 'transcribe', label: 'Transcribe', hint: 'Speech to text' },
  { id: 'process', label: 'Shape', hint: 'EQ and level samples' },
  { id: 'song', label: 'Song', hint: 'Rap over a beat' },
  { id: 'library', label: 'Library', hint: 'Your takes' },
  { id: 'voices', label: 'Voices', hint: `${VOICES.length} models` },
  { id: 'settings', label: 'Settings', hint: 'Defaults and cache' },
];

/** What the rail calls each receiving section, read aloud with its count. */
const RAIL_LABELS: Record<HandoffTarget, string> = {
  studio: 'Studio',
  convert: 'Convert',
  transcribe: 'Transcribe',
  process: 'Shape',
  song: 'Song',
};

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : 'studio';
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const queueTick = useRenderQueue();
  // Takes waiting per section, so the rail can say where one is queued.
  const waitingBySection = usePendingCounts();
  const activeJob = useMemo(() => getActiveJob(), [queueTick]);
  const [voiceId, setVoiceId] = useSetting<string>(SETTING_KEYS.voice, DEFAULT_VOICE);
  const [speed, setSpeed] = useSetting<number>(SETTING_KEYS.speed, 1);
  const [theme, setTheme] = useSetting<Theme>(SETTING_KEYS.theme, DEFAULT_THEME);
  // The section whose queue the rail count opened, if any.
  const [queuePanel, setQueuePanel] = useState<HandoffTarget | null>(null);
  // Why a take the panel offered to throw away is still listed.
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const queueReturn = useRef<HTMLButtonElement | null>(null);
  // One live region speaks for the rail; it only carries increases.
  const [announcement, setAnnouncement] = useState('');
  const announcedCounts = useRef<Partial<Record<HandoffTarget, number>> | null>(null);

  // index.html sets the same attribute before the first paint, so a light UI
  // does not flash dark on load; this keeps it in step after a change.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const before = announcedCounts.current;
    announcedCounts.current = waitingBySection;
    // Nothing has landed before the first read; it is only the baseline.
    if (!before) return;

    const landed = waitingAnnouncement(before, waitingBySection, route, (target) => RAIL_LABELS[target]);
    // A fall is a take being picked up or discarded, not an arrival: nothing
    // is spoken, but the old line goes so it cannot be read as current.
    if (landed) setAnnouncement(landed);
    else if (waitingFell(before, waitingBySection)) setAnnouncement('');
  }, [route, waitingBySection]);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  const pickVoice = useCallback(
    (id: string) => {
      setVoiceId(id);
      navigate('studio');
    },
    [navigate, setVoiceId],
  );

  const openQueue = useCallback((target: HandoffTarget, trigger: HTMLButtonElement) => {
    queueReturn.current = trigger;
    setQueueNote(null);
    setQueuePanel(target);
  }, []);

  const closeQueue = useCallback(() => {
    const target = queuePanel;
    const trigger = queueReturn.current;
    setQueueNote(null);
    setQueuePanel(null);
    // Back to the count that opened it; clearing a queue removes that control,
    // so the section's own rail entry is the fallback.
    if (trigger?.isConnected) trigger.focus();
    else if (target) {
      document.querySelector<HTMLButtonElement>(`.nav-item[data-section="${target}"]`)?.focus();
    }
  }, [queuePanel]);

  const discardQueued = useCallback(
    async (key: string) => {
      if (!queuePanel) return;
      setQueueNote(null);
      const name = queuedTakes(queuePanel).find((take) => take.key === key)?.name;
      // The row goes first; a take whose delete failed stays queued, and saying
      // so beats a Discard button that looks as if it did nothing.
      if (await discardHandoff(queuePanel, key)) return;
      setQueueNote(
        `Couldn’t remove ${name ? `“${name}”` : 'that take'} — its saved copy is still there, so it is still waiting.`,
      );
    },
    [queuePanel],
  );

  const clearQueued = useCallback(async () => {
    if (!queuePanel) return;
    const queued = queuedTakes(queuePanel).length;
    setQueueNote(null);
    const gone = await discardHandoffQueue(queuePanel);
    if (gone >= queued) return;

    const left = queued - gone;
    setQueueNote(
      left === 1
        ? 'Couldn’t remove 1 take — its saved copy is still there, so it is still waiting.'
        : `Couldn’t remove ${left} takes — their saved copies are still there, so they are still waiting.`,
    );
  }, [queuePanel]);

  const openQueuedSection = useCallback(() => {
    if (!queuePanel) return;
    const target = queuePanel;
    closeQueue();
    navigate(target);
  }, [closeQueue, navigate, queuePanel]);

  const voice = VOICES_BY_ID.get(voiceId);

  return (
    <div className="shell">
      <div
        className="sr-only"
        id="handoff-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">
            <LogoMark size={42} />
          </span>
          <div>
            <strong>Denspeak Studio</strong>
            <span>voice studio</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => {
            const target = isHandoffRoute(item.id) ? item.id : null;
            const waiting = target ? (waitingBySection[target] ?? 0) : 0;
            const takes = waiting === 1 ? '1 take' : `${waiting} takes`;

            return (
              <div className="nav-item-wrap" key={item.id}>
                <button
                  className={route === item.id ? 'nav-item active' : 'nav-item'}
                  data-section={item.id}
                  onClick={() => navigate(item.id)}
                >
                  <span className="nav-label">{item.label}</span>
                  <small>{item.hint}</small>
                </button>
                {/* The open section already reports its queue in the notice;
                    a count beside it would only repeat that. */}
                {target && waiting > 0 && route !== target && (
                  <button
                    className="nav-count"
                    aria-haspopup="dialog"
                    aria-expanded={queuePanel === target}
                    aria-label={`${takes} waiting for ${item.label}. Review the queue`}
                    title={`Review the ${takes} waiting for ${item.label}`}
                    onClick={(event) => openQueue(target, event.currentTarget)}
                  >
                    {waiting}
                  </button>
                )}
              </div>
            );
          })}
        </nav>

        {activeJob && (
          <div className="rail-job">
            <span className="eyebrow">Rendering</span>
            <strong>{activeJob.label}</strong>
            <small>
              {activeJob.download !== null
                ? `${Math.round(activeJob.download * 100)}% downloaded`
                : activeJob.blocks > 0
                  ? `Part ${Math.min(activeJob.block + 1, activeJob.blocks)} of ${activeJob.blocks}`
                  : activeJob.status}
            </small>
            <button className="btn ghost small" onClick={() => cancelJob(activeJob.id)}>
              Cancel
            </button>
          </div>
        )}

        <div className="rail-foot">
          <span className="eyebrow">Current voice</span>
          <strong>{voice ? voice.name : 'Unknown voice'}</strong>
          <small>{voice ? `${voice.language} · ${voice.quality.replace('_', ' ')}` : 'Choose one in Voices'}</small>
        </div>

        <div className="rail-credit">A 965 Media Creation</div>
      </aside>

      <main className="content">
        {route === 'studio' && (
          <Studio
            voiceId={voiceId}
            onVoiceChange={setVoiceId}
            speed={speed}
            onSpeedChange={setSpeed}
          />
        )}
        {route === 'convert' && <Convert />}
        {route === 'transcribe' && <Transcribe />}
        {route === 'process' && <Process />}
        {route === 'song' && <Song />}
        {route === 'library' && <Library />}
        {route === 'voices' && <Voices selectedId={voiceId} onPick={pickVoice} />}
        {route === 'settings' && (
          <Settings
            voiceId={voiceId}
            onVoiceChange={setVoiceId}
            speed={speed}
            onSpeedChange={setSpeed}
            theme={theme}
            onThemeChange={setTheme}
          />
        )}
      </main>

      {queuePanel && (
        <QueuePanel
          label={NAV.find((item) => item.id === queuePanel)?.label ?? 'this section'}
          takes={queuedTakes(queuePanel)}
          note={queueNote}
          onDiscard={discardQueued}
          onClear={clearQueued}
          onOpen={openQueuedSection}
          onClose={closeQueue}
        />
      )}
    </div>
  );
}
