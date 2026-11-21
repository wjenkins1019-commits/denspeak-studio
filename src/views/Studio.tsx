import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICES, VOICES_BY_ID, languageName, voiceLabel, type Voice } from '../voices';
import {
  CLONE_PREFIX,
  listClonedVoices,
  subscribeCloneStatus,
} from '../lib/clone';
import { planSpeech } from '../lib/humanize';
import type { NarrationSettings } from '../lib/narrate';
import {
  cancelGroup,
  cancelJob,
  clearGroup,
  enqueueJobs,
  getAudiobook,
  getJobs,
  setAudiobook,
  useRenderQueue,
} from '../lib/renderQueue';
import { sameBands, styleById, type EqBand } from '../lib/eq';
import { captureMic, type MicCapture } from '../lib/mic';
import { TRANSCRIBE_MODELS, transcribe } from '../lib/transcribe';
import { RecordDot } from '../components/RecordDot';
import { LiveLevelMeter } from '../components/LiveLevelMeter';
import { rememberVoiceEq, voiceEqFor } from '../lib/voiceEq';
import {
  SAVED_VOICE_PREFIX,
  describeSavedVoice,
  isSavedVoice,
  listSavedVoices,
  savedVoiceId,
  saveSavedVoice,
  type SavedVoice,
} from '../lib/presets';
import type { Take } from '../lib/library';
import { exportFileName, exportLibrary } from '../lib/export';
import type { ParsedBook } from '../lib/ebook';
import { titleFromScript } from '../lib/format';
import { loadPronunciations, segmentPronunciations } from '../lib/pronounce';
import { DEFAULT_STRENGTH, DEFAULT_VOICE, SETTING_KEYS, useSetting } from '../lib/settings';
import { stripCastTags, type CastMember } from '../lib/cast';
import { RENDER_PRESETS, type RenderPreset } from '../lib/renderPresets';
import { AbCompare } from '../components/AbCompare';
import { VoiceCompare } from '../components/VoiceCompare';
import {
  deleteProject,
  loadProjects,
  migrateProject,
  renameProject,
  saveProjects,
  snapshotState,
  type StudioProject,
  type StudioProjectState,
} from '../lib/projects';
import { BookImport } from '../components/BookImport';
import { EqPanel } from '../components/EqPanel';
import { Player } from '../components/Player';

interface StudioProps {
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
}

const STUDIO_GROUP = 'studio';
const AUDIOBOOK_GROUP = 'audiobook';

const SAMPLE = `Every sentence you write here leaves this machine as audio, spoken by a voice that runs on your own processor. Nothing is uploaded, and nothing is billed.

With naturalness on, the script is rendered a phrase or two at a time, every phrase gets its own tempo, pitch and level the way a reader varies a delivery, real air is added between them, and the tone is shaped before the file is saved.`;

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

export default function Studio({ voiceId, onVoiceChange, speed, onSpeedChange }: StudioProps) {
  const [script, setScript] = useSetting<string>(SETTING_KEYS.draft, SAMPLE);
  const [humanize, setHumanize] = useSetting<boolean>(SETTING_KEYS.humanize, true);
  const [strength, setStrength] = useSetting<number>(SETTING_KEYS.humanizeStrength, DEFAULT_STRENGTH);
  const [expressiveness, setExpressiveness] = useSetting<number>(SETTING_KEYS.expressiveness, 0.5);
  const [eqId, setEqId] = useSetting<string>(SETTING_KEYS.eq, 'flat');
  // Bands dragged on the graph, kept apart from the preset they started from so
  // choosing a preset is still a clean reset. Shared with Convert: the two
  // views have always shown the same preset, so they show the same edit too.
  const [editedBands, setEditedBands] = useSetting<EqBand[] | null>(SETTING_KEYS.eqEditedBands, null);
  const [mastering, setMastering] = useSetting<string | null>(SETTING_KEYS.mastering, null);
  const [semitones, setSemitones] = useSetting<number>(SETTING_KEYS.semitones, 0);
  const [formant, setFormant] = useSetting<number>(SETTING_KEYS.formant, 0);
  const [brightness, setBrightness] = useSetting<number>(SETTING_KEYS.brightness, 0);
  const [savedVoices, setSavedVoices] = useState<SavedVoice[]>([]);
  // Multi-voice cast: paragraphs tagged `Name:` render in that voice.
  const [cast, setCast] = useSetting<CastMember[]>(SETTING_KEYS.cast, []);
  const [presetName, setPresetName] = useState('');
  const [saving, setSaving] = useState(false);
  // Dictating: the mic is live and the dot is green. Stopping transcribes the
  // capture and appends it to the script, so a script can be spoken in.
  const [dictating, setDictating] = useState(false);
  const dictateCapture = useRef<MicCapture | null>(null);
  const [meterStream, setMeterStream] = useState<MediaStream | null>(null);
  const [dictateModel] = useSetting<string>(SETTING_KEYS.transcribeModel, TRANSCRIBE_MODELS[1].id);
  const [cloned, setCloned] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  // Per-project lock: each piece keeps its own script and sound, auto-saved
  // on switch so the knobs always match the piece on screen.
  const [projectList, setProjectList] = useState<StudioProject[]>(() => {
    try {
      return loadProjects(window.localStorage);
    } catch {
      return [];
    }
  });
  const [activeProjectId, setActiveProjectId] = useSetting<string | null>(
    SETTING_KEYS.activeProject,
    null,
  );
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [showReading, setShowReading] = useState(false);
  // The book survives navigation (module state, next to the queue) while the
  // checkbox selection is view state; coming back selects everything unfinished.
  const [audioTitle, setAudioTitle] = useState(() => getAudiobook()?.title ?? '');
  const [audioBook, setAudioBook] = useState<ParsedBook | null>(() => getAudiobook()?.book ?? null);
  const [audioSelected, setAudioSelected] = useState<number[]>(() => {
    const saved = getAudiobook();
    return saved ? saved.book.chapters.map((_, index) => index) : [];
  });

  // Renders live in the global queue, so they survive navigation; this view
  // just reflects the latest Studio job and the audiobook group's jobs.
  const queueTick = useRenderQueue();
  const jobs = useMemo(() => getJobs(), [queueTick]);

  // After a reload the persisted audiobook arrives a beat after mount (IDB is
  // async). Adopt it if the user has not loaded or dismissed a book since.
  useEffect(() => {
    if (!audioBook) {
      const saved = getAudiobook();
      if (saved) {
        setAudioTitle(saved.title);
        setAudioBook(saved.book);
        setAudioSelected(saved.book.chapters.map((_, index) => index));
      }
    }
  }, [queueTick, audioBook]);

  const grouped = useMemo(() => groupByLanguage(VOICES), []);
  const paragraphCount = useMemo(() => planSpeech(script).length, [script]);
  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;

  // The rules live in Settings; this view remounts on navigation, so reading
  // them once per visit is always fresh. The preview mirrors the render path
  // exactly: renders call applyPronunciations on the same text and list.
  const pronunciations = useMemo(() => loadPronunciations(), []);
  const readingSegments = useMemo(
    () => segmentPronunciations(script, pronunciations),
    [script, pronunciations],
  );
  const readingChanges = readingSegments.filter((segment) => segment.changed).length;

  // A saved voice is a recipe over a base voice: the base does the speaking, the
  // saved settings decide how it is shaped.
  const selectedSaved = isSavedVoice(voiceId)
    ? savedVoices.find((entry) => entry.id === savedVoiceId(voiceId))
    : undefined;
  const baseVoiceId = selectedSaved ? selectedSaved.base : voiceId;
  const isClone = baseVoiceId.startsWith(CLONE_PREFIX);
  const cloneName = isClone ? baseVoiceId.slice(CLONE_PREFIX.length) : '';
  const voice = VOICES_BY_ID.get(baseVoiceId);
  // What the graph shows and what the render uses, edit or preset.
  const eqStyle = styleById(eqId);
  const eqBands = editedBands ?? eqStyle.bands;

  useEffect(() => {
    void listClonedVoices().then(setCloned);
    void listSavedVoices().then(setSavedVoices);
  }, []);

  function handleVoicePick(next: string) {
    if (isSavedVoice(next)) {
      const preset = savedVoices.find((entry) => entry.id === savedVoiceId(next));
      if (preset) {
        setSemitones(preset.semitones);
        setFormant(preset.formant);
        setBrightness(preset.brightness);
        setEqId(preset.eqPresetId);
        setEditedBands(null);
        onSpeedChange(preset.speed);
        setHumanize(preset.humanize);
        setStrength(preset.strength);
      }
    } else {
      // Bank and cloned voices carry their own remembered style.
      const remembered = voiceEqFor(next);
      if (remembered) {
        setEqId(remembered);
        setEditedBands(null);
      }
    }
    onVoiceChange(next);
  }

  // A stray recording must not survive leaving the view.
  useEffect(() => () => dictateCapture.current?.cancel(), []);

  /** Speak the script into the mic instead of typing it. */
  async function toggleDictate() {
    if (dictating) {
      dictateCapture.current?.stop();
      return;
    }
    const capture = captureMic((stream) => setMeterStream(stream));
    dictateCapture.current = capture;
    setDictating(true);
    try {
      const blob = await capture.done;
      setDictating(false);
      setMeterStream(null);
      setNotice('Reading what you said…');
      const heard = await transcribe(blob, dictateModel, ({ status }) => setNotice(status));
      if (heard.trim()) {
        setScript((previous) =>
          previous.trim() ? `${previous.trimEnd()}\n\n${heard.trim()}` : heard.trim(),
        );
        setNotice('Dictation added to the script.');
      } else {
        setNotice('Nothing to transcribe in that recording.');
      }
    } catch (dictateError) {
      setDictating(false);
      setMeterStream(null);
      setError(
        dictateError instanceof Error && dictateError.message !== 'Recording cancelled.'
          ? `Dictation failed: ${dictateError.message}`
          : null,
      );
    }
  }

  /** Choosing a style also remembers it for the voice it was chosen on. */
  function selectEq(styleId: string) {
    setEqId(styleId);
    // A preset is a starting point: the hand-tuned bands go with the old one.
    setEditedBands(null);
    if (!isSavedVoice(voiceId)) rememberVoiceEq(voiceId, styleId);
  }

  /** Dragging a node on the graph. Matching the preset again clears the edit. */
  function editBands(next: EqBand[]) {
    setEditedBands(sameBands(next, styleById(eqId).bands) ? null : next);
  }

  async function handleSaveVoice() {
    const name = presetName.trim();
    if (!name || saving) return;

    setSaving(true);
    setError(null);
    try {
      const saved = await saveSavedVoice({
        name,
        base: baseVoiceId,
        semitones,
        formant,
        brightness,
        eqPresetId: eqId,
        speed,
        humanize,
        strength,
      });
      setSavedVoices(await listSavedVoices());
      setPresetName('');
      onVoiceChange(`${SAVED_VOICE_PREFIX}${saved.id}`);
      setNotice(`Saved "${saved.name}" to your voices.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `Could not save that voice: ${saveError.message}`
          : 'Could not save that voice.',
      );
    } finally {
      setSaving(false);
    }
  }

  // The cloning engine reports model download and generation progress here.
  // During a render the job's own status takes over; otherwise this is news.
  useEffect(() => subscribeCloneStatus((update) => setNotice(update.label)), []);

  /** The current Studio settings, snapshotted so a queue keeps one voice throughout. */
  function narrationSettings(): NarrationSettings {
    return {
      voice: { baseVoiceId, isClone, cloneName },
      speed,
      humanize,
      strength,
      expressiveness,
      semitones,
      formant,
      brightness,
      eqPresetId: eqId,
      eqBands,
      eqLevel: eqStyle.level,
      mastering,
      cast: cast.length > 0 ? cast : undefined,
    };
  }

  function takeVoiceName(): string | undefined {
    const current = selectedSaved?.name ?? (isClone ? `${cloneName} (cloned)` : voice?.name);
    if (cast.length === 0) return current;
    const names = [
      current,
      ...cast.map((member) => VOICES_BY_ID.get(member.voiceId)?.name ?? member.name),
    ].filter((name): name is string => Boolean(name));
    return [...new Set(names)].join(' + ');
  }

  function updateCast(index: number, patch: Partial<CastMember>): void {
    setCast(cast.map((member, i) => (i === index ? { ...member, ...patch } : member)));
  }

  function addCastMember(): void {
    const used = new Set(cast.map((member) => member.voiceId));
    const fallback = VOICES.find((entry) => !used.has(entry.id))?.id ?? DEFAULT_VOICE;
    setCast([...cast, { name: `Voice ${cast.length + 1}`, voiceId: fallback }]);
  }

  /** The live knobs as one snapshot, for saving into a project. */
  function captureLive(): StudioProjectState {
    return {
      script,
      voiceId,
      speed,
      humanize,
      strength,
      expressiveness,
      semitones,
      formant,
      brightness,
      eqPresetId: eqId,
      eqBands: editedBands,
      mastering,
    };
  }

  /** Load a project's snapshot through every knob, including app-level voice/speed. */
  function applyProject(next: StudioProject): void {
    setScript(next.script);
    onVoiceChange(next.voiceId);
    onSpeedChange(next.speed);
    setHumanize(next.humanize);
    setStrength(next.strength);
    setExpressiveness(next.expressiveness);
    setSemitones(next.semitones);
    setFormant(next.formant);
    setBrightness(next.brightness);
    setEqId(next.eqPresetId);
    setEditedBands(next.eqBands);
    setMastering(next.mastering ?? null);
    setActiveProjectId(next.id);
  }

  function persistProjects(next: StudioProject[]): void {
    try {
      saveProjects(window.localStorage, next);
    } catch {
      // Same leniency as useSetting: private windows keep memory only.
    }
    setProjectList(next);
  }

  /** Auto-save the live knobs back into the active project record. */
  function snapshotActive(): StudioProject[] {
    return projectList.map((entry) =>
      entry.id === activeProjectId ? snapshotState(entry, captureLive()) : entry,
    );
  }

  function switchProject(id: string): void {
    if (id === activeProjectId) return;
    const next = projectList.find((entry) => entry.id === id);
    if (!next) return;
    persistProjects(snapshotActive());
    applyProject(next);
    setRenaming(false);
  }

  function handleNewProject(): void {
    const saved = snapshotActive();
    const untitled = saved.filter((entry) => entry.name.startsWith('Untitled')).length;
    const fresh: StudioProject = {
      ...captureLive(),
      script: '',
      id: `p-${Date.now()}`,
      name: `Untitled ${untitled + 1}`,
      updatedAt: Date.now(),
    };
    persistProjects([...saved, fresh]);
    applyProject(fresh);
    setRenaming(false);
  }

  function handleDeleteProject(): void {
    const active = projectList.find((entry) => entry.id === activeProjectId);
    if (!active) return;
    if (!window.confirm(`Delete project "${active.name}"? This cannot be undone.`)) return;
    const kept = deleteProject(projectList, active.id, captureLive());
    persistProjects(kept);
    const newest = [...kept].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    applyProject(newest);
    setRenaming(false);
  }

  function commitRename(): void {
    if (!activeProjectId) return;
    persistProjects(renameProject(projectList, activeProjectId, draftName));
    setRenaming(false);
  }

  /**
   * One-click stack: voice, speed, naturalness and EQ together. Applied
   * directly — not through the voice picker — so remembered per-voice styles
   * cannot overwrite the preset's EQ. Pitch, form, shape and expressiveness
   * stay where they are; the active project auto-saves the result.
   */
  function applyRenderPreset(preset: RenderPreset): void {
    onVoiceChange(preset.voiceId);
    onSpeedChange(preset.speed);
    setHumanize(preset.humanize);
    setStrength(preset.strength);
    setEqId(preset.eqPresetId);
    setEditedBands(null);
    setMastering(preset.mastering);
    setNotice(`Preset applied: ${preset.name} — ${preset.blurb}`);
  }

  // First visit with existing settings: the live draft becomes Untitled so
  // nothing is lost; returning visits adopt the stored list, falling back to
  // the most recently touched project. Runs once — adopting stored state
  // must not re-trigger on later knob edits.
  useEffect(() => {
    let stored: StudioProject[];
    try {
      stored = loadProjects(window.localStorage);
    } catch {
      stored = [];
    }
    if (stored.length === 0) {
      const first = migrateProject(captureLive());
      persistProjects([first]);
      setActiveProjectId(first.id);
      return;
    }
    setProjectList(stored);
    if (!stored.some((entry) => entry.id === activeProjectId)) {
      const newest = [...stored].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      applyProject(newest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A narration becomes one queue job; the rail keeps showing it elsewhere. */
  function handleRender() {
    const text = script.trim();
    if (!text || studioBusy) return;
    clearGroup(STUDIO_GROUP);
    enqueueJobs([
      {
        group: STUDIO_GROUP,
        chapterIndex: -1,
        label: 'Narration',
        takeName: titleFromScript(stripCastTags(text, cast) || text),
        text,
        settings: narrationSettings(),
        voiceId,
        voiceName: takeVoiceName(),
      },
    ]);
  }

  /** Latest single narration; the take and A/B below read straight off it. */
  const studioJob = [...jobs].reverse().find((job) => job.group === STUDIO_GROUP);
  const studioBusy = studioJob?.state === 'working' || studioJob?.state === 'queued';
  const take = studioJob?.take ?? null;
  const compare =
    studioJob?.take && studioJob.rawBlob
      ? { raw: studioJob.rawBlob, shaped: studioJob.take.blob }
      : null;
  const progress = studioJob?.download ?? null;
  const statusText = studioBusy
    ? (studioJob?.status ?? 'Working…')
    : studioJob?.state === 'done'
      ? 'Saved to your library.'
      : notice;
  const renderError = studioJob?.state === 'failed' ? (studioJob.error ?? 'Render failed.') : null;

  const bookJobs = audioBook ? jobs.filter((job) => job.group === AUDIOBOOK_GROUP) : [];
  const bookJobFor = (index: number) => bookJobs.find((job) => job.chapterIndex === index);
  const bookActive = bookJobs.find((job) => job.state === 'working' || job.state === 'queued');
  const doneTakes = bookJobs
    .filter((job) => job.state === 'done' && job.take)
    .map((job) => job.take as Take);
  const bookFailed = bookJobs.filter((job) => job.state === 'failed');
  const bookCancelled = bookJobs.filter((job) => job.state === 'cancelled');
  const checkedCount = audioSelected.length;
  const bookStatusText = bookActive
    ? `Chapter ${bookActive.chapterIndex + 1} of ${audioBook?.chapters.length} — ${bookActive.status}`
    : bookFailed.length > 0
      ? `${bookFailed.length} chapter${bookFailed.length === 1 ? '' : 's'} failed — retry below.`
      : bookCancelled.length > 0 && doneTakes.length === 0
        ? 'Cancelled.'
        : doneTakes.length > 0
          ? 'Audiobook render finished.'
          : '';

  /**
   * Every checked chapter without a finished take becomes a queue job. Failed
   * chapters re-queue cleanly; finished ones are left alone.
   */
  function handleRenderAudiobook() {
    if (!audioBook || bookActive) return;
    const targets = audioSelected.filter((index) => {
      const existing = bookJobFor(index);
      return !existing || existing.state !== 'done';
    });
    if (targets.length === 0) return;
    const settings = narrationSettings();
    const speaker = takeVoiceName();
    enqueueJobs(
      targets.map((index) => {
        const chapter = audioBook.chapters[index];
        return {
          group: AUDIOBOOK_GROUP,
          chapterIndex: index,
          label: `Chapter ${index + 1} — ${chapter.title}`,
          takeName: `${audioTitle} — ${index + 1}. ${chapter.title}`,
          text: `${chapter.title}\n\n${chapter.text}`,
          settings,
          voiceId,
          voiceName: speaker,
        };
      }),
    );
  }

  async function handleExportAudiobook() {
    if (doneTakes.length === 0) return;
    try {
      await exportLibrary(doneTakes, new Date(), undefined, exportFileName(`${audioTitle} audiobook`, 'zip'));
    } catch {
      setError('Could not build the export file.');
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Studio</span>
          <h1>Narrate a script</h1>
          <p>
            Type or paste text, pick a voice, and render it locally. The first render with a voice
            downloads its model; after that it works offline.
          </p>
        </div>
      </header>

      <div className="grid two">
        <div className="card stack">
          <div className="field">
            <span>Render preset · one click sets voice, speed, naturalness and EQ</span>
            <div className="row">
              {RENDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className="btn ghost small"
                  title={preset.blurb}
                  onClick={() => applyRenderPreset(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Project · every knob is saved automatically when you switch</span>
            <div className="row">
              <select
                aria-label="Project"
                style={{ flex: 1 }}
                value={activeProjectId ?? ''}
                onChange={(event) => switchProject(event.target.value)}
              >
                {projectList.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button className="btn ghost small" onClick={handleNewProject}>
                New
              </button>
              <button
                className="btn ghost small"
                onClick={() => {
                  const active = projectList.find((entry) => entry.id === activeProjectId);
                  setDraftName(active?.name ?? '');
                  setRenaming((open) => !open);
                }}
              >
                Rename
              </button>
              <button className="btn ghost small" onClick={handleDeleteProject}>
                Delete
              </button>
            </div>
            {renaming && (
              <div className="row">
                <input
                  aria-label="Project name"
                  style={{ flex: 1 }}
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setRenaming(false);
                  }}
                />
                <button className="btn ghost small" onClick={commitRename}>
                  Save
                </button>
              </div>
            )}
          </div>
          <label className="field">
            <span>Script</span>
            <textarea
              value={script}
              onChange={(event) => setScript(event.target.value)}
              rows={14}
              spellCheck
              placeholder="Paste your script…"
            />
          </label>
          <div className="row between">
            <small className="muted">
              {wordCount} words · {paragraphCount} paragraph{paragraphCount === 1 ? '' : 's'}
            </small>
            <div className="row">
              <RecordDot active={dictating} />
              <button
                className="btn ghost small"
                onClick={() => void toggleDictate()}
                aria-pressed={dictating}
              >
                {dictating ? 'Stop dictating' : 'Dictate'}
              </button>
              <button className="btn ghost small" onClick={() => setScript(SAMPLE)}>
                Use sample
              </button>
            </div>
          </div>
          <LiveLevelMeter stream={meterStream} />

          <div className="field">
            <span>
              Cast · start a paragraph with <b>Name:</b> to give it that voice
            </span>
            {cast.map((member, index) => (
              <div className="row" key={`${member.name}-${index}`}>
                <input
                  aria-label="Cast name"
                  style={{ maxWidth: '10rem' }}
                  value={member.name}
                  onChange={(event) => updateCast(index, { name: event.target.value })}
                  placeholder="Name"
                />
                <select
                  aria-label={`Voice for ${member.name || 'cast member'}`}
                  style={{ flex: 1 }}
                  value={member.voiceId}
                  onChange={(event) => updateCast(index, { voiceId: event.target.value })}
                >
                  {grouped.map(([language, voices]) => (
                    <optgroup key={language} label={languageName(language)}>
                      {voices.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {voiceLabel(entry)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  className="btn ghost small"
                  onClick={() => setCast(cast.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <button className="btn ghost small" onClick={addCastMember}>
                + Add voice
              </button>
            </div>
            <small className="muted">
              Tags are stripped before rendering and never spoken. <b>\Name:</b> reads
              literally, and a name with no cast member reads in the main voice.
            </small>
          </div>

          <div className="row between">
            <button
              className="btn ghost small"
              aria-expanded={showReading}
              onClick={() => setShowReading((open) => !open)}
            >
              {showReading ? 'Hide reading preview' : 'Preview what the voice will read'}
            </button>
            {pronunciations.length > 0 && (
              <small className="muted">
                {pronunciations.length} rule{pronunciations.length === 1 ? '' : 's'} ·{' '}
                {readingChanges} applied
              </small>
            )}
          </div>

          {showReading && (
            <div className="reading-preview" aria-live="polite">
              {pronunciations.length === 0 ? (
                <small className="muted">
                  No pronunciation rules yet — add them in Settings → Pronunciations.
                </small>
              ) : readingChanges === 0 ? (
                <small className="muted">
                  No rules apply to this script; the voice reads it as written.
                </small>
              ) : (
                <p>
                  {readingSegments.map((segment, index) =>
                    segment.changed ? (
                      <mark key={index}>{segment.text}</mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </p>
              )}
            </div>
          )}

          <BookImport
            onLoad={(text, title, info) => {
              setScript(text);
              setNotice(`Loaded “${title}” into the script.`);
              if (info) {
                cancelGroup(AUDIOBOOK_GROUP);
                clearGroup(AUDIOBOOK_GROUP);
                setAudiobook({ title: info.book.title, book: info.book });
                setAudioTitle(info.book.title);
                setAudioBook(info.book);
                setAudioSelected(info.indexes);
              }
            }}
          />
        </div>

        <div className="card stack">
          <label className="field">
            <span>Voice</span>
            <select value={voiceId} onChange={(event) => handleVoicePick(event.target.value)}>
              {savedVoices.length > 0 && (
                <optgroup label="Saved voices">
                  {savedVoices.map((entry) => (
                    <option key={entry.id} value={`${SAVED_VOICE_PREFIX}${entry.id}`}>
                      {entry.name} — {VOICES_BY_ID.get(entry.base)?.name ?? entry.base}
                    </option>
                  ))}
                </optgroup>
              )}
              {cloned.length > 0 && (
                <optgroup label="My voices (cloned)">
                  {cloned.map((name) => (
                    <option key={name} value={`${CLONE_PREFIX}${name}`}>
                      {name} — cloned
                    </option>
                  ))}
                </optgroup>
              )}
              {grouped.map(([language, voices]) => (
                <optgroup key={language} label={languageName(language)}>
                  {voices.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {voiceLabel(entry)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {isClone && (
            <label className="field">
              <span>
                Expressiveness <b>{expressiveness.toFixed(2)}</b>
              </span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={expressiveness}
                onChange={(event) => setExpressiveness(Number(event.target.value))}
              />
            </label>
          )}

          <label className="field">
            <span>
              Speed <b>{speed.toFixed(2)}×</b>
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

          <div className="field">
            <span>
              Naturalness <b>{humanize ? `${Math.round(strength * 100)}%` : 'off'}</b>
            </span>
            <div className="row">
              <button
                className={humanize ? 'chip active' : 'chip'}
                onClick={() => setHumanize(!humanize)}
              >
                {humanize ? 'On' : 'Off'}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={strength}
                disabled={!humanize}
                onChange={(event) => setStrength(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="field">
            <span>
              Pitch <b>{semitones >= 0 ? '+' : ''}{semitones.toFixed(1)} st</b>
            </span>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={semitones}
              onChange={(event) => setSemitones(Number(event.target.value))}
            />
          </div>

          <div className="field">
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
          </div>

          <div className="field">
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
          </div>

          <div className="field">
            <span>Save as a new voice</span>
            <div className="row">
              <input
                type="text"
                value={presetName}
                placeholder="Name this voice"
                onChange={(event) => setPresetName(event.target.value)}
              />
              <button
                className="btn ghost small"
                disabled={saving || !presetName.trim()}
                onClick={() => void handleSaveVoice()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <small className="muted">
              {selectedSaved
                ? `Based on ${VOICES_BY_ID.get(selectedSaved.base)?.name ?? selectedSaved.base} · ${describeSavedVoice(selectedSaved)}`
                : 'Keeps this voice, shape, EQ preset, speed and naturalness as a new bank entry.'}
            </small>
          </div>

          <div className="row">
            <button className="btn primary" disabled={studioBusy || wordCount === 0} onClick={handleRender}>
              {studioBusy ? 'Rendering…' : 'Render narration'}
            </button>
            {studioBusy && studioJob && (
              <button className="btn ghost" onClick={() => cancelJob(studioJob.id)}>
                Cancel
              </button>
            )}
          </div>
          <small className="muted">
            Renders run in the background — you can keep working while it renders.
          </small>

          {progress !== null && (
            <div className="progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}

          {statusText && <p className="status">{statusText}</p>}
          {renderError && <p className="error">Render failed: {renderError}</p>}
          {error && <p className="error">{error}</p>}
          {compare ? (
            <AbCompare
              raw={compare.raw}
              shaped={compare.shaped}
              rawLabel="Raw"
              shapedLabel="Shaped"
              captions={take?.captions}
              captionsName={take?.name}
              takeId={take?.id}
            />
          ) : (
            take && (
              <Player blob={take.blob} name={take.name} captions={take.captions} takeId={take.id} />
            )
          )}

          <div className="hint">
            {isClone ? (
              <>
                Cloned voices use a second engine (Chatterbox). The first render downloads about 1.5
                GB once, then works offline. English only. Add or remove samples in Voices.
              </>
            ) : (
              <>
                Naturalness renders each paragraph separately, adds air between them, drifts the pitch
                a few tenths of a semitone, then high-passes rumble, de-harshes the top end and
                gently compresses the level. Off gives you the engine's raw read.
              </>
            )            }
          </div>
        </div>
      </div>

      <div className="card stack">
        <div>
          <h2>Compare voices</h2>
          <p>
            Hear the same sample in two voices, side by side. Both sides use the
            shape, speed and naturalness above — only the voice changes.
          </p>
        </div>
        <VoiceCompare voiceA={voiceId} script={script} settings={narrationSettings()} />
      </div>

      <div className="card stack">
        <div>
          <h2>EQ preset</h2>
          <p>
            How the finished take is shaped. Presets are kept separate from voices, so any voice can
            be rendered through any of them.
          </p>
        </div>

        <EqPanel
          presetId={eqId}
          bands={eqBands}
          edited={editedBands !== null}
          onPresetChange={selectEq}
          onChangeBands={editBands}
        />
        <label className="field">
          <span>Mastering · lands the render inside the delivery bar</span>
          <select
            aria-label="Mastering"
            value={mastering ?? ''}
            onChange={(event) => setMastering(event.target.value || null)}
          >
            <option value="">Off — raw render, match later if needed</option>
            <option value="audiobook">Audiobook — mastered to ACX spec</option>
            <option value="ad">Ad Spot — mastered to broadcast spec</option>
          </select>
        </label>
        <small className="muted">
          Remembered per voice: switching voices reloads the style last used with each one.
        </small>
      </div>

      {audioBook && (
        <div className="card stack">
          <div className="row between">
            <div>
              <h2>Audiobook</h2>
              <p>
                {audioTitle} — {checkedCount} of {audioBook.chapters.length} chapter
                {audioBook.chapters.length === 1 ? '' : 's'} selected. Each finished chapter lands in
                the library as its own take, using the voice and shaping above.
              </p>
            </div>
            <button
              className="btn ghost small"
              disabled={!!bookActive}
              onClick={() => {
                cancelGroup(AUDIOBOOK_GROUP);
                clearGroup(AUDIOBOOK_GROUP);
                setAudiobook(null);
                setAudioBook(null);
                setAudioSelected([]);
              }}
            >
              Dismiss
            </button>
          </div>

          <div className="audiobook-list">
            {audioBook.chapters.map((chapter, index) => {
              const job = bookJobFor(index);
              const words = chapter.text.trim() ? chapter.text.trim().split(/\s+/).length : 0;
              return (
                <div key={index} className="audiobook-row">
                  <input
                    type="checkbox"
                    checked={audioSelected.includes(index)}
                    disabled={!!bookActive}
                    aria-label={`Include chapter ${index + 1}`}
                    onChange={(event) =>
                      setAudioSelected((prev) =>
                        event.target.checked
                          ? [...prev, index]
                          : prev.filter((entry) => entry !== index),
                      )
                    }
                  />
                  <span className="title">
                    {index + 1}. {chapter.title}
                  </span>
                  <small className="muted">{words.toLocaleString()} words</small>
                  <small className="muted">
                    {job?.state === 'working'
                      ? 'Rendering…'
                      : job?.state === 'queued'
                        ? 'Queued…'
                        : job?.state === 'done'
                          ? 'Done'
                          : job?.state === 'failed'
                            ? `Failed: ${job.error ?? 'unknown error'}`
                            : job?.state === 'cancelled'
                              ? 'Cancelled'
                              : ''}
                  </small>
                  {job?.state === 'working' && (
                    <button className="btn ghost small" onClick={() => cancelJob(job.id)}>
                      Cancel
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="row">
            <button
              className="btn ghost small"
              disabled={!!bookActive}
              onClick={() => setAudioSelected(audioBook.chapters.map((_, index) => index))}
            >
              Select all
            </button>
            <button
              className="btn ghost small"
              disabled={!!bookActive}
              onClick={() => setAudioSelected([])}
            >
              Select none
            </button>
          </div>

          <div className="row">
            <button
              className="btn primary"
              disabled={!!bookActive || checkedCount === 0}
              onClick={handleRenderAudiobook}
            >
              {bookFailed.length > 0 ? `Retry ${bookFailed.length} failed` : 'Render audiobook'}
            </button>
            {bookActive && (
              <button className="btn ghost" onClick={() => cancelGroup(AUDIOBOOK_GROUP)}>
                Cancel
              </button>
            )}
            {doneTakes.length > 0 && !bookActive && (
              <button className="btn ghost" onClick={() => void handleExportAudiobook()}>
                Export {doneTakes.length} chapter{doneTakes.length === 1 ? '' : 's'} (.zip)
              </button>
            )}
          </div>

          {bookActive?.download !== null && bookActive?.download !== undefined && (
            <div className="progress">
              <span style={{ width: `${Math.round((bookActive.download ?? 0) * 100)}%` }} />
            </div>
          )}

          {bookStatusText && <p className="status">{bookStatusText}</p>}
        </div>
      )}
    </section>
  );
}
