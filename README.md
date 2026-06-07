# JustSayIt

Turn pasted text into spoken audio — generated **100% locally in your browser**.
Nothing you type or generate is ever uploaded. JustSayIt runs the
[Kokoro‑82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) speech
model on your own machine via [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js)
and [Transformers.js](https://huggingface.co/docs/transformers.js).

## Features

- **Paste text → speech.** A single transport control: **Generate** → **Generating…** → **Play**.
- **Save locally** as **WAV** (lossless) or **MP3** (128 kbps), encoded in‑browser.
- **Remembers your save location.** On supported browsers the file picker reopens in
  your most‑recently‑used directory, both within a session and on future visits.
- **Progress for both phases** — a bar for generation, and a live waveform seek bar for playback.
- **28 voices** (American/British, male/female) and an adjustable speaking rate.
- **Private by design.** Open your browser's network tab: after the one‑time model
  download, no audio or text leaves the page.

## How it works

1. All inference runs in a **Web Worker** so the interface stays responsive.
2. On first use the voice model is downloaded once and cached by the browser; later
   visits start instantly.
3. Compute backend is chosen automatically: **WebGPU** when available (much faster),
   otherwise **WebAssembly**. The active engine is shown in the masthead.
4. Long text is split into sentences and synthesized chunk‑by‑chunk, giving an exact
   generation progress reading. Chunks are stitched into a single 24 kHz mono clip.

## Browser support

- **Chrome / Edge (Chromium):** full experience, including WebGPU and the remembered
  save directory (File System Access API).
- **Firefox / Safari:** generation and playback work (WebAssembly backend). Saving
  uses a normal download to your downloads folder; the remembered‑directory feature
  is unavailable because those browsers don't implement the File System Access API.

## Develop

```bash
npm install      # install dependencies
npm run dev      # start the dev server
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Deploy (GitHub Pages)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds the site and
publishes it to GitHub Pages on every push to `main` (i.e. each merged PR).

One‑time setup: in the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**.

The build uses a relative base path, so the app works whether it's served from a
project subpath (`https://<user>.github.io/justsayit/`) or a domain root.

## Notes

- The first generation downloads the model (tens to a few hundred MB depending on
  the selected backend). This is a one‑time cost; the browser caches it afterward.
- Audio is 24 kHz mono. MP3 is encoded on demand when you save.

## License

The application code in this repository is provided as‑is. The Kokoro model and the
kokoro-js / Transformers.js libraries are distributed under their own licenses.
