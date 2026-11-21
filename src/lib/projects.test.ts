// Tests for the per-project store: projects keep a script's full sound so
// switching pieces can never silently use the wrong voice, EQ, speed or
// naturalness. Storage is injected, so these run in node with a Map stub.
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PROJECT_KEY,
  PROJECTS_KEY,
  deleteProject,
  loadProjects,
  migrateProject,
  renameProject,
  saveProjects,
  snapshotState,
  type StorageLike,
  type StudioProject,
  type StudioProjectState,
} from './projects';

function state(overrides: Partial<StudioProjectState> = {}): StudioProjectState {
  return {
    script: 'Hello world',
    voiceId: 'en_US-lessac-high',
    speed: 1,
    humanize: true,
    strength: 0.75,
    expressiveness: 0.5,
    semitones: 0,
    formant: 0,
    brightness: 0,
    eqPresetId: 'clarity',
    eqBands: null,
    ...overrides,
  };
}

function store(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function project(overrides: Partial<StudioProject> = {}): StudioProject {
  return { id: 'p-1', name: 'Piece', updatedAt: 1000, ...state(), ...overrides };
}

describe('project store', () => {
  it('round-trips projects through storage', () => {
    const storage = store();
    const list = [project({ id: 'p-1' }), project({ id: 'p-2', name: 'Second' })];
    saveProjects(storage, list);
    expect(storage.data.get(PROJECTS_KEY)).toBeDefined();
    expect(loadProjects(storage)).toEqual(list);
  });

  it('loads missing or corrupt JSON as an empty list', () => {
    const storage = store();
    expect(loadProjects(storage)).toEqual([]);
    storage.setItem(PROJECTS_KEY, 'not-json{{{');
    expect(loadProjects(storage)).toEqual([]);
    storage.setItem(PROJECTS_KEY, JSON.stringify({ wrong: 'shape' }));
    expect(loadProjects(storage)).toEqual([]);
  });

  it('migrates live settings into an Untitled project', () => {
    const migrated = migrateProject(state({ script: 'My draft', voiceId: 'en_US-ryan-high' }));
    expect(migrated.name).toBe('Untitled');
    expect(migrated.id.startsWith('p-')).toBe(true);
    expect(migrated.script).toBe('My draft');
    expect(migrated.voiceId).toBe('en_US-ryan-high');
  });

  it('snapshots state into a project and refreshes its timestamp', () => {
    const before = project({ updatedAt: 1000 });
    const next = snapshotState(before, state({ voiceId: 'en_US-ryan-high', speed: 1.1 }));
    expect(next.id).toBe(before.id);
    expect(next.name).toBe(before.name);
    expect(next.voiceId).toBe('en_US-ryan-high');
    expect(next.speed).toBe(1.1);
    expect(next.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('renames projects but ignores blank names', () => {
    const list = [project({ id: 'p-1', name: 'Old' })];
    expect(renameProject(list, 'p-1', 'New')[0].name).toBe('New');
    expect(renameProject(list, 'p-1', '   ')[0].name).toBe('Old');
  });

  it('deletes projects but never leaves the list empty', () => {
    const two = [project({ id: 'p-1' }), project({ id: 'p-2' })];
    const one = deleteProject(two, 'p-1', state());
    expect(one.map((entry) => entry.id)).toEqual(['p-2']);
    const fresh = deleteProject(one, 'p-2', state({ script: '' }));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].script).toBe('');
  });

  it('uses distinct storage keys from the other settings', () => {
    expect(PROJECTS_KEY).toBe('chatterbox.projects');
    expect(ACTIVE_PROJECT_KEY).toBe('chatterbox.activeProject');
    expect(PROJECTS_KEY).not.toBe(ACTIVE_PROJECT_KEY);
  });
});
