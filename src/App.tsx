import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_THEME, DEFAULT_VOICE, SETTING_KEYS, useSetting, type Theme } from './lib/settings';
import { cancelJob, getActiveJob, useRenderQueue } from './lib/renderQueue';
import { VOICES, VOICES_BY_ID } from './voices';
import { LogoMark } from './components/Logo';
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

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : 'studio';
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const queueTick = useRenderQueue();
  const activeJob = useMemo(() => getActiveJob(), [queueTick]);
  const [voiceId, setVoiceId] = useSetting<string>(SETTING_KEYS.voice, DEFAULT_VOICE);
  const [speed, setSpeed] = useSetting<number>(SETTING_KEYS.speed, 1);
  const [theme, setTheme] = useSetting<Theme>(SETTING_KEYS.theme, DEFAULT_THEME);

  // index.html sets the same attribute before the first paint, so a light UI
  // does not flash dark on load; this keeps it in step after a change.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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

  const voice = VOICES_BY_ID.get(voiceId);

  return (
    <div className="shell">
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
          {NAV.map((item) => (
            <button
              key={item.id}
              className={route === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
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
    </div>
  );
}
