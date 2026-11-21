# Multi-Voice Scripts — Short Design (option A, approved)

**Intent:** Tag paragraphs with `Name:` prefixes from a per-piece cast list and
render the whole script in one pass, each paragraph in its voice.

**Why this shape:** The queue already renders sentence-aligned blocks
sequentially with the voice chosen per block — the only new work is parsing
(voice, text) pairs up front and resolving a per-block voice at render time.
Cast + prefixes live in the plain script text, so projects, re-renders and
copy-paste keep working with no parallel mapping to maintain.

**Tag rules (both, as approved):** a paragraph starting with `Name:` uses that
voice only when Name matches the cast (case-insensitive, capped length); a
leading backslash (`\Name:`) always reads literally with the backslash
stripped; anything else is untouched default-voice text. Tags are stripped
before rendering, never spoken. Empty-after-strip paragraphs are dropped.

**Goals:** cast editor in Studio (name + bank voice rows); `cast` travels in
the render job (and therefore the fingerprint — a cast edit re-renders rather
than adopting a stale take); untagged paragraphs use the current Studio voice,
clone default included; take names note the ensemble.
**Non-goals:** saved/cloned voices in the cast (bank only, v1); per-project
cast storage (global cast for now — flagged below); compare-view cast handling
(sides share the script's cast; only defaults differ).
**Anti-goal:** two voices rendering at once — the queue's serial engine
discipline is untouched.

**Follow-up flagged, not built:** per-project cast (today the cast is global
while the voice is per-project — switching pieces keeps the cast but changes
the default voice).
