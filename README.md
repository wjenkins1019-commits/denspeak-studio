# Denspeak Studio

On-device voice studio: narrate a script with 121 Piper voices, or change the
pitch/formants of a recording. Everything renders locally with ONNX Runtime
(WASM) — no account, no upload, no API key.

This is a source rebuild of the shipped `Chatter Box 0.2.0` Electron app (the
app was later renamed Denspeak Studio). The original was only available as a
minified `app.asar`.

## Download (Windows)

Grab `Denspeak Studio Setup 0.3.0.exe` from
[GitHub Releases](../../releases/tag/v0.3.0) and run it — Windows 10/11 x64.
The build is unsigned, so SmartScreen may ask for confirmation.
No account, no upload, no API key. Voices (20–60 MB each) download on first
use and are cached, so later renders work offline.

## Run it (from source)

Prerequisites: Windows 10/11 x64, Node.js 20+ (verified on 26.13.1) with npm,
about 500 MB free for `node_modules`, plus room for voice models (20–60 MB
each, cached on first use). A microphone is only needed for the Convert and
Transcribe views.

```bash
npm install       # first time only
npm run dev       # Vite on 127.0.0.1:5173 + Electron
```

Other scripts:

```bash
npm run build      # production bundle into dist/
npm run dist:win   # Windows installer (NSIS) into release/, published as GitHub Release v0.3.0
# Optional signing: put the Azure Trusted Signing endpoint, account,
# profile, and publisher in build.win.azureSignOptions in package.json
# (identifiers, safe to commit), then set AZURE_TENANT_ID /
# AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in the build terminal.
# Without azureSignOptions the build is unsigned.

The installer packs only `dist/`, `electron/`, the icon, and `package.json` —
no `node_modules`. The UI is fully bundled by Vite and the main process uses
only Electron and Node built-ins, so nothing at runtime needs them. If the
main process ever requires an npm package, remove the `!node_modules/**/*`
exclusion in `package.json` first.
npm start          # run Electron against dist/ (build first)
npm run typecheck  # tsc --noEmit
npm test           # vitest: EQ curves, ZIP writer, filenames, WAV/MP3
```

The window is served from a loopback HTTP origin rather than `file://`, which is
what gives the renderer a secure context: OPFS model cache, `getUserMedia`, and
web workers all need it.

## Layout

| Path | What it is |
| --- | --- |
| `electron/main.js` | Window, permissions, static file server, `/models` and `/fetch` routes |
| `electron/fetch-proxy.js` | The `/fetch` proxy shared by the app and the dev server |
| `scripts/dev.mjs` | Starts Vite, then Electron on the dev URL |
| `src/App.tsx` | Rail navigation, hash routing, theme |
| `src/views/Studio.tsx` | Script → narration; ebook audiobooks (chapter queue, one take per chapter) |
| `src/views/Convert.tsx` | Record/upload, pitch + formant + brightness shift |
| `src/views/Process.tsx` | Shape a sample: draggable EQ, level, save the result |
| `src/views/Song.tsx` | Rap vocal over a beat |
| `src/views/Library.tsx` | Saved takes (IndexedDB), playback, WAV export, ZIP export, delete |
| `src/views/Voices.tsx` | Browse/search the catalog, preview, pick, remove models |
| `src/views/Settings.tsx` | Defaults, light/dark UI, cached models, pronunciations |
| `src/components/EqPanel.tsx` | EQ preset picker plus response curve, shared by three views |
| `src/lib/tts.ts` | vits-web wrapper (`predict`, `stored`, `remove`, `flush`) |
| `src/lib/audio.ts` | Phase vocoder, spectral shaping, WAV encode, decode to mono |
| `src/lib/eq.ts` | EQ presets, biquad chain and the response curve they draw |
| `src/lib/narrate.ts` | One narration job (text → mastered samples), shared by Studio and audiobooks |
| `src/lib/pronounce.ts` | Custom pronunciations, applied before every render; Studio previews them |
| `src/lib/export.ts` | WAV export and the stored ZIP bundle of the library |
| `src/lib/library.ts` | IndexedDB take store |
| `src/voices.ts` | Generated voice catalog (121 models) |
| `legacy-build/` | Local-only copy of the original compiled app, untouched, for diffing (not in git; the maintainer keeps it out of the repo) |

## Notes

- A voice downloads 20–60 MB on first use and is then cached in OPFS, so later
  renders work offline.
- Convert shifts the spectral envelope as well as pitch, so presets sound like a
  different speaker rather than a chipmunk. It is CPU-only and runs on the main
  thread; a 30 second clip takes a couple of seconds.
- The old build had a "translate" action that proxied `/api/*` to
  `chatterbox.freebuff.page`, which now returns 404. It is intentionally not
  carried over.
- The EQ preset picker is one panel reused by Studio, Convert and Shape: presets
  are shared, and bands saved in Shape appear in every picker.
- Loading an ebook in Studio also offers an audiobook queue: pick chapters, render
  them one take each with the current voice and shaping, then export the finished
  chapters as one ZIP.
- Studio renders run as background queue jobs: the mastering/DSP tail runs in a
  worker, progress shows in the left rail on every view, and any job can be
  cancelled. Finished takes land in the library even if you navigate away.
- The queue is crash-safe: job descriptors and finished paragraphs persist, so
  a reload resumes mid-chapter from the last finished paragraph, adopts takes
  already saved instead of doubling them, and restores the audiobook card.
- Takes and previews save as WAV or MP3 (128 kbps mono, roughly a third the
  size). MP3 encoding runs in the audio worker, so long takes don't freeze the
  UI. Library ZIP bundles stay WAV masters.
- The UI is dark by default; Settings → Appearance switches to a light theme,
  which is remembered on this machine.
- `npm run gen:voices` regenerates `src/voices.ts` from a local `legacy-build/` copy (not in git; fresh clones don't have it, and you don't need it to build or run).
- `npm run icons` regenerates `public/icons/` and `assets/icon.ico` from
  `assets/icon.svg` (needs `sharp`).
