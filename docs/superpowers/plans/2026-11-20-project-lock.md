# Per-Project Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio pieces each remember their own script, voice, EQ, speed, and naturalness, auto-saving on switch.

**Architecture:** New pure store module (`src/lib/projects.ts`) over an injected
storage adapter, so all logic is unit-testable in node; Studio owns a small
switcher UI that writes the live state into the old project and loads the new
one through the existing setters (including App-level voice/speed callbacks).
Live `useSetting` keys stay the runtime truth (reload behavior unchanged).

**Tech Stack:** TypeScript, React (existing patterns), vitest, localStorage keys.

**Spec:** `docs/superpowers/specs/2026-11-20-project-lock-design.md`

## Global Constraints

- Work only in `chatter-box-app/`; never touch the installed app in Program Files.
- No new dependencies; no git available (no commits — working tree only).
- Stored voice choices always win; defaults only apply to fresh state.
- Render jobs already snapshot settings; saved takes must keep working.

## Review Focus

- Corrupt `chatterbox.projects` JSON must fall back to a migrated single project, never a blank screen — pinned in Task 1 tests.
- A project whose voice id no longer exists (deleted model) must still load with the other settings intact — pinned in Task 1 tests.
- Switching projects mid-render must not disturb the running job — pinned by code (jobs snapshot at enqueue) plus a Task 2 browser check.
- Deleting the last/only project must leave one blank project, never zero — pinned in Task 1 tests.
- A project with an empty name must keep its previous name — pinned in Task 2 browser check.

---

### Task 1: Project store (pure logic + tests)

**Files:**
- Create: `src/lib/projects.ts`
- Create: `src/lib/projects.test.ts`

**Interfaces:**
- Consumes: `EqBand` from `./eq`; nothing else.
- Produces:
  - `interface StudioProjectState { script: string; voiceId: string; speed: number; humanize: boolean; strength: number; expressiveness: number; semitones: number; formant: number; brightness: number; eqPresetId: string; eqBands: EqBand[] | null }`
  - `interface StudioProject extends StudioProjectState { id: string; name: string; updatedAt: number }`
  - `interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }` (localStorage satisfies it; tests inject a Map-backed stub)
  - `loadProjects(store: StorageLike): StudioProject[]` — parses `chatterbox.projects`; corrupt/missing → `[]` (migration owns fallback, not this function)
  - `saveProjects(store: StorageLike, projects: StudioProject[]): void`
  - `migrateProject(state: StudioProjectState): StudioProject` — id `p-<Date.now()>`, name `'Untitled'`
  - `snapshotState(project: StudioProject, state: StudioProjectState): StudioProject` — returns copy with state applied and fresh `updatedAt`
  - `renameProject(projects: StudioProject[], id: string, name: string): StudioProject[]` — blank names ignored
  - `deleteProject(projects: StudioProject[], id: string): StudioProject[]` — never returns `[]`; deleting the last one returns one fresh blank project (empty script, passed-in fallback state)

- [ ] **Step 1: Write the failing test** — `src/lib/projects.test.ts` covering: round-trip save/load through a Map-backed `StorageLike`; corrupt JSON loads as `[]`; `migrateProject` keeps every state field; `snapshotState` updates fields + bumps `updatedAt`; `renameProject` ignores blank names; `deleteProject` never returns empty.
- [ ] **Step 2: Run it to verify it fails** — Run: `npm test -- src/lib/projects.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement the store** — Create `src/lib/projects.ts` with exactly the interfaces above; storage keys `chatterbox.projects` and `chatterbox.activeProject` as exported constants `PROJECTS_KEY`, `ACTIVE_PROJECT_KEY`.
- [ ] **Step 4: Run tests to verify they pass** — Run: `npm test -- src/lib/projects.test.ts`. Expected: PASS.
- [ ] **Step 5: Full suite still green** — Run: `npm test`. Expected: all files pass.

### Task 2: Studio wiring (switcher UI + migration + auto-save on switch)

**Files:**
- Modify: `src/lib/settings.ts` (add `projects` + `activeProject` to `SETTING_KEYS`, pointing at the constants from Task 1 — or reuse the constants directly; keep one source of truth)
- Modify: `src/views/Studio.tsx` (project bar UI + switch/save/load logic)

**Interfaces:**
- Consumes: Task 1 store; existing `useSetting`, `onVoiceChange`, `onSpeedChange`, `setScript`, `setEqId`, `setEditedBands`, and the other Studio setters.
- Produces: rendered project bar (select + rename + new + delete) reusing existing `row`/`btn`/`chip` classes; no new exported API.

- [ ] **Step 1: Keys + migration effect** — Add the two keys. On mount, if no stored projects: build state from current live settings, `migrateProject`, save, set active id. If stored projects exist but the active id is unknown, fall back to the most recently updated.
- [ ] **Step 2: Switcher UI + actions** — Project bar above the Script field: `<select>` of projects; Rename (inline input, Enter commits); New (inherits current settings, empty script); Delete (window.confirm; never strands zero projects per Task 1). `switchProject(id)`: snapshot current live state into old record + save; load new record through every setter including `onVoiceChange`/`onSpeedChange`; set active id.
- [ ] **Step 3: Typecheck + tests** — Run: `npm run typecheck` then `npm test`. Expected: clean + all pass.
- [ ] **Step 4: Browser check** — Dev server + preview tab: create project, edit script + change voice/EQ, switch away and back, confirm every knob restored; rename; delete; reload mid-step to confirm nothing lost; start a render, switch projects, confirm the running job finishes undisturbed.

### Task 3: Fresh build for the unpacked app

**Files:** none (build output under `release/`).

- [ ] **Step 1: Build** — Run: `npm run dist:win`. Expected: exit 0, `release/win-unpacked/resources/app.asar` newer than sources.
- [ ] **Step 2: Verify content** — `grep -c "chatterbox.projects" release/win-unpacked/resources/app.asar` is nonzero.
- [ ] **Step 3: Relaunch unpacked app** — Stop running `Denspeak Studio.exe` instances owned by earlier testing, launch the new build, confirm the window appears. (If the user is mid-render, wait for their go-ahead instead.)
