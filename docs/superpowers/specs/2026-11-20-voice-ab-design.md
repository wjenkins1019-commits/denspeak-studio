# Voice A/B Compare — Short Design (option A, approved)

**Intent:** Render the same short paragraph with two voices and compare them
directly: two pickers, one sample box, one Render-both button, two side-by-side
players that stay in sync.

**Why this shape:** Hearing two voices back to back from memory is unreliable;
adjacent players with play-pauses-other plus a seek-lock make the comparison
immediate. Both sides share the current Studio shape/speed/humanize settings so
the *voices* are what's compared, not recipes. A short sample (not the full
script) keeps the double render to seconds; the queue runs the two jobs
sequentially because the engine must never be driven twice at once.

**Goals:** compare section in Studio; Voice A defaults to current voice, B to
Leah; editable sample prefilled from the script's first paragraph (~600 chars);
Render both enqueues two jobs; side A/B players with play-pauses-other (always)
and seek-lock (toggle, default on); per-side status + cancel.
**Non-goals:** saved/cloned voices in the pickers (bank voices only for now);
full-script compare; persisting compare results across reloads.
**Anti-goal:** anything that drives two TTS jobs at once or disturbs the
Studio/library render groups (separate `compare` group).

**Approaches considered:** (a) two linked players — picked, matches the ask;
(b) one shared player with A/B switch — rejected (less literal, though more
sample-exact); (c) separate view — rejected (splits the workflow).

**Builder calls:** exact copy/layout in existing Studio card styles; object-URL
lifetimes follow the AbCompare pattern (create + revoke in the same effect).
