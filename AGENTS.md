# AGENTS.md

Guidance for AI agents and human contributors working in this repository.

## What this is

Textusound is a **static, client-side** web app that converts pasted text to
speech entirely in the browser using `kokoro-js` (Kokoro-82M) on top of
Transformers.js. There is no backend. It is built with Vite (vanilla JS, no
framework) and deploys to GitHub Pages.

## Commands

```bash
npm install      # install dependencies
npm run dev      # dev server with HMR (http://localhost:5173 by convention)
npm run build    # production build into dist/
npm run preview  # serve the production build locally
```

There is no unit-test framework or linter configured. Validate changes by
running `npm run build` and exercising the app in a real browser (or a headless
Chrome script via `playwright-core`, channel `chrome`). Always test the actual
served build, not just source.

## Layout

| Path | Responsibility |
| --- | --- |
| `index.html` | Markup, fonts, favicon, and the **Content-Security-Policy** meta. |
| `src/main.js` | UI orchestration: state machine, worker wiring, waveform rendering, playback, and the save flow. |
| `src/tts.worker.js` | All inference. Loads the model, chunks text, generates per chunk, builds the WAV. |
| `src/audio.js` | Pure helpers: `splitText`, `concatFloat32`, `silence`, `computePeaks`, `floatToWav`. Imported by the worker. |
| `src/save.js` | File System Access API save + MRU directory persistence, with a download fallback. |
| `src/storage.js` | IndexedDB (handle persistence) and `localStorage` (prefs). |
| `src/voices.js` | The 28-voice list used to build the picker. |
| `src/styles.css` | All styling. |
| `.github/workflows/deploy.yml` | Build + deploy to GitHub Pages on push to `main`. |

## Architecture

Inference runs in a **module Web Worker** so the UI stays responsive. The main
thread owns all UI state; the worker owns the model.

### Worker message protocol

Main → worker:
- `{ type: "generate", jobId, text, voice, speed }`
- `{ type: "cancel" }` — cooperative; the worker stops at the next chunk boundary

Worker → main:
- `{ type: "backend", backend, stage }` — `stage` is `loading` | `ready` | `fallback`
- `{ type: "progress", phase: "load", progress, loaded, total }` — **no jobId**
- `{ type: "progress", jobId, phase: "generate", done, total }`
- `{ type: "done", jobId, wav, peaks, sampleRate, duration, backend }` — `wav` (ArrayBuffer) and `peaks` (Float32Array) are **transferred**
- `{ type: "cancelled", jobId }`
- `{ type: "error", jobId, message }`

## Invariants — do not break these

1. **Job ids gate everything.** `state.jobId` in `main.js` is monotonic. Any
   worker message whose `jobId` differs from the current `state.jobId` is
   ignored. Bump the id whenever generated audio becomes obsolete.
2. **`invalidateToIdle()` is the only way to discard ready audio.** It bumps the
   job id, resets the player, and returns to idle. Call it on text edits, voice
   changes, and speaking-rate changes while in the `ready` state.
3. **The save picker must run before any `await`.** `showSaveFilePicker()`
   requires transient user activation, so in `onSave()` it is called first
   (the MRU handle is preloaded at startup via `primeMru()`), and the WAV blob is
   built synchronously. Never add an `await` before the picker on the click path.
4. **Generation is serialized in the worker.** `state.genChain` chains
   `handleGenerate` calls so `tts.generate()` never overlaps; `state.currentJobId`
   is set synchronously on each `generate` message so superseded jobs bail at the
   next chunk. Keep the trailing `.catch` so an unexpected throw can't poison the
   queue.
5. **The CSP must list every external origin.** If you add a dependency or asset
   that fetches from a new host (script, worker, `connect`, font, media, image),
   update the `<meta http-equiv="Content-Security-Policy">` in `index.html` and
   verify in a real browser that nothing is blocked.
6. **Asset paths stay relative.** `vite.config.js` uses `base: "./"` and the
   worker/WASM are referenced via `new URL(..., import.meta.url)` so the app
   works under the GitHub Pages project subpath. Don't hardcode absolute paths.
7. **Revoke object URLs** when replacing or discarding audio (`resetAudio`).

## Conventions

- Vanilla ES modules, 2-space indent, double-quoted strings. No framework.
- Comment only non-obvious logic; let clear code speak for itself.
- Palette lives in CSS custom properties in `:root`. For historical reasons the
  token names are kept even though values changed: `--amber` holds gold and
  `--signal` holds the green. `main.js` reads `--wave-dim`, `--signal`, and
  `--paper` when drawing the waveform — keep those names in sync if you rename.
- User-facing strings should avoid date-bound phrasing.

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push
to `main`. One-time repo setup: **Settings → Pages → Source: GitHub Actions**.
The shipped `dist/` includes the ONNX Runtime WASM (~21 MB) as a same-origin
asset; the model weights are fetched from Hugging Face at runtime and cached.

## Licensing

The app code is dedicated to the public domain under **CC0-1.0** (see `LICENSE`).
When adding dependencies, prefer permissive licenses (MIT/BSD/Apache/OFL) and
avoid copyleft (GPL/LGPL). The project deliberately ships no copyleft code — for
example, MP3 export was dropped rather than bundle the LGPL-3.0 LAME encoder.
Keep it that way unless a maintainer signs off.
