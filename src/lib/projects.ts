// Per-project Studio state: each piece keeps its own script plus every knob
// that shapes its sound (voice, EQ with hand-dragged bands, speed,
// naturalness), so switching pieces restores all of them and can never
// silently use the wrong settings.
//
// Storage is injected (localStorage satisfies the interface; tests use a Map
// stub) so every function here is unit-testable in node.
import type { EqBand } from './eq';

export const PROJECTS_KEY = 'chatterbox.projects';
export const ACTIVE_PROJECT_KEY = 'chatterbox.activeProject';

/** Minimal storage surface; satisfied by window.localStorage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Everything about a piece that affects its sound, minus its name. */
export interface StudioProjectState {
  script: string;
  voiceId: string;
  speed: number;
  humanize: boolean;
  strength: number;
  expressiveness: number;
  semitones: number;
  formant: number;
  brightness: number;
  eqPresetId: string;
  eqBands: EqBand[] | null;
  /** Delivery bar mastered at render time; null means no mastering. */
  mastering?: string | null;
}

export interface StudioProject extends StudioProjectState {
  id: string;
  name: string;
  updatedAt: number;
}

function isProject(value: unknown): value is StudioProject {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.script === 'string' &&
    typeof entry.voiceId === 'string'
  );
}

/** Stored projects, most recently touched last; corrupt data loads as []. */
export function loadProjects(storage: StorageLike): StudioProject[] {
  try {
    const raw = storage.getItem(PROJECTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProject);
  } catch {
    return [];
  }
}

export function saveProjects(storage: StorageLike, projects: StudioProject[]): void {
  storage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

/**
 * First run with existing settings: the live draft becomes an Untitled
 * project, so nothing the user already had is lost in the migration.
 */
export function migrateProject(live: StudioProjectState): StudioProject {
  return { ...live, id: `p-${Date.now()}`, name: 'Untitled', updatedAt: Date.now() };
}

/** Auto-save on switch: fold the live knobs back into their project. */
export function snapshotState(project: StudioProject, live: StudioProjectState): StudioProject {
  return { ...live, id: project.id, name: project.name, updatedAt: Date.now() };
}

/** Blank renames keep the previous name. */
export function renameProject(
  projects: StudioProject[],
  id: string,
  name: string,
): StudioProject[] {
  const next = name.trim();
  if (!next) return projects;
  return projects.map((entry) =>
    entry.id === id ? { ...entry, name: next, updatedAt: Date.now() } : entry,
  );
}

/**
 * Deleting never strands zero projects: removing the last one leaves a fresh
 * blank project built on the passed-in fallback state.
 */
export function deleteProject(
  projects: StudioProject[],
  id: string,
  fallback: StudioProjectState,
): StudioProject[] {
  const kept = projects.filter((entry) => entry.id !== id);
  if (kept.length > 0) return kept;
  return [{ ...fallback, script: '', id: `p-${Date.now()}`, name: 'Untitled', updatedAt: Date.now() }];
}
