# Per-Project Lock — Short Design (approved)

**Intent:** Switching between pieces in Studio must never silently use the wrong
voice, EQ, speed, or naturalness. Each project carries its own settings; the
knobs on screen always match the piece on screen.

**Why this shape:** Voice and speed live at app level (shared with Song/Convert);
EQ, naturalness, pitch, script live in Studio. The lock snapshots both levels
together per project. Auto-save on switch (not a save button) because a
forgotten save reproduces the exact failure being killed.

**Goals:** per-project { script, voice, speed, naturalness on/off + strength,
expressiveness, semitones/formant/brightness, EQ preset + dragged bands };
switch restores all; current draft migrates to the first project; saved takes
keep working (jobs already snapshot settings).
**Non-goals:** Convert/Song stay global; no cloud sync; no project export.
**Anti-goal:** any path where the knobs disagree with the visible piece.

**Approaches considered:** (a) snapshot + auto-save on switch — picked;
(b) explicit save button — rejected (forgettable); (c) include Convert/Song —
rejected (one-off jobs, not pieces).

**Calls left to the builder:** exact UI copy and control layout following
existing Studio classes; storage stays localStorage JSON next to other keys.
