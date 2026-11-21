# Multi-Voice Scripts Implementation Plan (inline execution, no git)

**Goal:** `Name:`-tagged paragraphs render in cast voices in a single queued job.

**Architecture:** Pure tag parsing in new `src/lib/cast.ts`; voiced block
planning in `humanize.ts` (needs its private constants); per-block voice
resolution in `narrate.ts` `renderSpeechBlocks`; cast travels on
`NarrationSettings.cast` so the fingerprint covers it; Studio owns the cast
editor + a `chatterbox.cast` setting.

**Tech Stack:** TypeScript, existing queue/humanize/narrate, vitest (node).

## Global Constraints

- Work only in `chatter-box-app/`; no new dependencies; no git (no commits).
- Engine never driven twice at once; bank voices only in cast.
- Tags stripped before TTS, never spoken.

## Review Focus

- A paragraph whose tag matches nothing renders literally with tag intact — pinned in Task 1 tests.
- Backslash escape strips exactly one backslash — pinned in Task 1 tests.
- Cast edit with identical text must NOT adopt the old take (fingerprint covers cast) — pinned in Task 1 tests.
- Clone default + cast: untagged blocks still use the clone — pinned by code (null voice = settings.voice), browser-checked only if a clone exists.
- Empty-after-strip tag-only paragraph renders nothing and breaks no indexing — pinned in Task 1 tests.

---

### Task 1: Tag parsing + voiced planning (TDD)

**Files:** Create `src/lib/cast.ts`, `src/lib/cast.test.ts`; modify
`src/lib/humanize.ts` (add `planVoicedBlocks`), `src/lib/narrate.ts`
(`NarrationSettings.cast`, per-block voice).

**Interfaces:**
- `cast.ts`: `interface CastMember { name: string; voiceId: string }`;
  `extractVoiceTag(paragraph, cast): { voiceId: string | null; text: string }`.
- `humanize.ts`: `interface VoicedBlock extends SpeechBlock { voiceId: string | null }`
  (null = job default); `planVoicedBlocks(script, cast): VoicedBlock[]` —
  same paragraph normalization as `planSpeech`, per-paragraph tags, overall
  final block pause 0, interior paragraph-end pauses kept.
- `narrate.ts`: `NarrationSettings` gains `cast?: CastMember[]`;
  `renderSpeechBlocks` builds the voiced plan when `settings.cast?.length`,
  else today’s plan with null voices; per block,
  `voice = block.voiceId ? { baseVoiceId, isClone: false, cloneName: '' } : settings.voice`.

- [ ] Step 1: Write `cast.test.ts` — case-insensitive match, backslash escape,
  non-cast colon untouched, empty-after-strip dropped at plan level, default
  voice for untagged; voiced-plan tests (voice inheritance, block count and
  pause parity with `planSpeech` on untagged scripts).
- [ ] Step 2: Run `npm test -- src/lib/cast.test.ts` → FAIL (missing modules).
- [ ] Step 3: Implement `cast.ts`, `planVoicedBlocks`, narrate wiring.
- [ ] Step 4: Re-run → PASS; full `npm test` green; `npm run typecheck` clean.

### Task 2: Studio cast editor + job wiring

**Files:** Modify `src/views/Studio.tsx` (`chatterbox.cast` key in settings,
cast state, editor UI under the script, `narrationSettings` carries cast,
take name notes the ensemble); modify `src/lib/settings.ts` (key).

- [ ] Step 1: Editor UI (name + bank-voice rows, add/remove) + settings key.
- [ ] Step 2: `narrationSettings()` includes non-empty cast; ensemble take name.
- [ ] Step 3: Typecheck + tests green.
- [ ] Step 4: Browser check — cast Leah/Ryan, two tagged paragraphs, render,
  both sides done, tags absent from spoken text path (unit-pinned), untagged
  paragraph uses default.

### Task 3: Fresh build + install

- [ ] Step 1: `npm run dist:win` → exit 0; new strings in unpacked asar.
- [ ] Step 2: Silent install to Program Files; verify asar timestamp + strings.
- [ ] Step 3: Launch, confirm window; leave the dev server off.
