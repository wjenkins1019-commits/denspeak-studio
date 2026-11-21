# Caption Export — Short Design (option A, approved)

**Intent:** One click beside the audio exports produces SRT + VTT captions from
the take's own audio, so narrations work as video voiceovers.

**Why this shape:** Measured timings beat estimated ones. The DSP worker does
not return per-block offsets (and blocks are ~5× too long for a cue anyway),
so the take is transcribed with word timestamps and words are grouped into
cue-sized lines. This covers every take — new, old, Convert outputs — with no
render-path changes.

**Goals:** `transcribeTimed` (word timestamps via the existing Whisper worker,
chunk fallback if a model won't do word-level); pure cue builder
(~84 chars, ~7 s cap, sentence-end and long-gap breaks); SRT + VTT formatters;
Export buttons in the shared Player (SRT/VTT download via the existing
saveExport path, so desktop dialogs keep working); progress + error states.
**Non-goals:** script-text alignment (caption text is what Whisper heard —
flagged hybrid follow-up); cue editing UI.
**Anti-goal:** touching the render/mastering path or the queue.
