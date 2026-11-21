# Render Presets — Short Design (option A, approved)

**Intent:** One click sets voice + speed + naturalness + EQ together; four
curated built-ins, no custom-preset storage.

**Presets:** Audiobook Chapter (Leah/high, 1.0×, 75%, audiobook EQ); Ad Spot
(Ryan/high, 1.05×, 80%, ad EQ); Podcast (Ava/medium, 1.0×, 70%, podcast EQ);
Quick Draft (Ava/medium, 1.1×, naturalness off, flat EQ — fastest render).

**Calls:** application bypasses `handleVoicePick` (which would re-apply
remembered styles over the preset's EQ) and sets the four knobs directly;
pitch/form/shape/expressiveness are left alone; with a cast present the
preset changes the default voice only; applying a preset auto-saves into the
active project via the existing lock.
