import "./styles.css";
import { VOICE_GROUPS, DEFAULT_VOICE } from "./voices.js";
import {
  supportsFsAccess,
  primeMru,
  pickSaveFile,
  writeToHandle,
  downloadBlob,
} from "./save.js";
import { loadPrefs, savePrefs } from "./storage.js";

const worker = new Worker(new URL("./tts.worker.js", import.meta.url), {
  type: "module",
});

const $ = (id) => document.getElementById(id);
const el = {
  text: $("text"),
  charCount: $("char-count"),
  voice: $("voice"),
  speed: $("speed"),
  speedVal: $("speed-val"),
  format: $("format"),
  generate: $("generate"),
  generateLabel: $("generate-label"),
  cancel: $("cancel"),
  save: $("save"),
  saveLabel: $("save-label"),
  genProgress: $("gen-progress"),
  genStatus: $("gen-status"),
  genPercent: $("gen-percent"),
  genFill: $("gen-fill"),
  bar: $("gen-bar"),
  waveform: $("waveform"),
  timeCurrent: $("time-current"),
  timeTotal: $("time-total"),
  playerMsg: $("player-msg"),
  status: $("status"),
  backendVal: $("backend-val"),
};

const MAX_CHARS = 8000;

const state = {
  gen: "idle", // idle | busy | ready
  jobId: 0,
  wavBuffer: null,
  peaks: null,
  duration: 0,
  audioUrl: null,
  pendingEncode: null, // { jobId, resolve, reject }
  mp3: null, // { jobId, bytes } cached MP3 for the current audio
  mp3Promise: null, // { jobId, promise } in-flight MP3 encode
};

const audio = new Audio();
audio.preload = "auto";

/* ---------- setup ---------- */

function populateVoices() {
  const frag = document.createDocumentFragment();
  for (const group of VOICE_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = group.label;
    for (const v of group.voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      og.appendChild(opt);
    }
    frag.appendChild(og);
  }
  el.voice.appendChild(frag);
}

function restorePrefs() {
  const prefs = loadPrefs();
  el.voice.value = prefs.voice || DEFAULT_VOICE;
  if (!el.voice.value) el.voice.value = DEFAULT_VOICE;
  el.speed.value = String(prefs.speed ?? 1);
  el.format.value = prefs.format === "mp3" ? "mp3" : "wav";
  updateSpeedLabel();
}

function persistPrefs() {
  savePrefs({
    voice: el.voice.value,
    speed: Number(el.speed.value),
    format: el.format.value,
  });
}

function updateSpeedLabel() {
  el.speedVal.textContent = `${Number(el.speed.value).toFixed(1)}×`;
}

function updateCharCount() {
  const n = el.text.value.length;
  el.charCount.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
  el.charCount.classList.toggle("over", n > MAX_CHARS);
  refreshTransport();
}

/* ---------- transport / state machine ---------- */

function refreshTransport() {
  const hasText = el.text.value.trim().length > 0;
  if (state.gen === "idle") {
    el.generate.classList.remove("busy", "play");
    el.generateLabel.textContent = "Generate";
    el.generate.disabled = !hasText;
    el.cancel.classList.add("hidden");
    el.save.disabled = true;
  } else if (state.gen === "busy") {
    el.generate.classList.add("busy");
    el.generate.classList.remove("play");
    el.generate.disabled = true;
    el.cancel.classList.remove("hidden");
    el.save.disabled = true;
  } else if (state.gen === "ready") {
    el.generate.classList.remove("busy");
    el.generate.classList.add("play");
    el.generate.disabled = false;
    el.cancel.classList.add("hidden");
    el.save.disabled = false;
    el.generateLabel.textContent = audio.paused ? "Play" : "Pause";
  }
}

function setStatus(msg, kind) {
  el.status.textContent = msg || "";
  el.status.dataset.kind = kind || "";
}

function setGenProgress(pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  el.genFill.style.width = `${clamped}%`;
  el.genPercent.textContent = `${clamped}%`;
  el.bar.setAttribute("aria-valuenow", String(clamped));
}

function clearGenProgress() {
  el.genFill.style.width = "0%";
  el.genPercent.textContent = "";
  el.bar.setAttribute("aria-valuenow", "0");
}

function rejectPendingEncode() {
  if (state.pendingEncode) {
    state.pendingEncode.reject(
      new DOMException("Audio was invalidated.", "AbortError"),
    );
    state.pendingEncode = null;
  }
  state.mp3 = null;
  state.mp3Promise = null;
}

// Single source of truth for discarding generated audio: bumps the job id so
// any in-flight worker result is ignored, rejects a pending MP3 encode so the
// Save flow can't hang, tells the worker to drop its retained PCM, and returns
// the UI to the idle state.
function invalidateToIdle() {
  state.jobId += 1;
  rejectPendingEncode();
  worker.postMessage({ type: "clear" });
  resetAudio();
  state.gen = "idle";
  el.genProgress.classList.remove("active");
  el.genStatus.textContent = "Idle";
  clearGenProgress();
  refreshTransport();
}

function startGeneration() {
  const text = el.text.value.trim();
  if (!text) return;
  if (text.length > MAX_CHARS) {
    setStatus(`Text is too long. Keep it under ${MAX_CHARS} characters.`, "error");
    return;
  }

  resetAudio();
  state.gen = "busy";
  state.jobId += 1;
  el.generateLabel.textContent = "Generating…";
  el.genProgress.classList.add("active");
  el.genStatus.textContent = "Preparing…";
  clearGenProgress();
  setStatus("");
  refreshTransport();

  worker.postMessage({
    type: "generate",
    jobId: state.jobId,
    text,
    voice: el.voice.value,
    speed: Number(el.speed.value),
  });
}

function cancelGeneration() {
  if (state.gen !== "busy") return;
  worker.postMessage({ type: "cancel" });
  worker.postMessage({ type: "clear" });
  state.jobId += 1; // any in-flight result for the old id is now stale
  rejectPendingEncode();
  state.gen = "idle";
  el.genProgress.classList.remove("active");
  el.genStatus.textContent = "Cancelled";
  clearGenProgress();
  setStatus("Generation cancelled.", "");
  refreshTransport();
}

el.generate.addEventListener("click", () => {
  if (state.gen === "idle") startGeneration();
  else if (state.gen === "ready") togglePlay();
});
el.cancel.addEventListener("click", cancelGeneration);

/* ---------- worker messages ---------- */

worker.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === "backend") {
    el.backendVal.textContent =
      msg.backend === "webgpu" ? "WebGPU" : "WASM";
    if (msg.stage === "fallback") {
      setStatus("WebGPU unavailable — using WASM (slower).", "");
    }
    return;
  }

  // Ignore results from superseded jobs.
  if (msg.jobId != null && msg.jobId !== state.jobId) return;

  switch (msg.type) {
    case "progress": {
      // Load progress carries no jobId; ignore it once we're no longer busy
      // (e.g. the user cancelled while the model was still downloading).
      if (state.gen !== "busy") break;
      if (msg.phase === "load") {
        el.generateLabel.textContent = "Loading…";
        el.genStatus.textContent = "Downloading voice model…";
        setGenProgress((msg.progress || 0) * 100);
      } else if (msg.phase === "generate") {
        el.generateLabel.textContent = "Generating…";
        el.genStatus.textContent = `Generating speech… ${msg.done}/${msg.total}`;
        setGenProgress((msg.done / msg.total) * 100);
      }
      break;
    }
    case "done": {
      onAudioReady(msg);
      break;
    }
    case "cancelled": {
      if (state.gen === "busy") {
        state.gen = "idle";
        el.genProgress.classList.remove("active");
        el.genStatus.textContent = "Cancelled";
        refreshTransport();
      }
      break;
    }
    case "error": {
      rejectPendingEncode();
      state.gen = "idle";
      el.genProgress.classList.remove("active");
      el.genStatus.textContent = "Error";
      el.genPercent.textContent = "";
      setStatus(msg.message || "Something went wrong.", "error");
      refreshTransport();
      break;
    }
    case "encoded": {
      if (state.pendingEncode && state.pendingEncode.jobId === msg.jobId) {
        state.pendingEncode.resolve(msg.mp3);
        state.pendingEncode = null;
      }
      break;
    }
    case "encodeError": {
      if (state.pendingEncode && state.pendingEncode.jobId === msg.jobId) {
        state.pendingEncode.reject(
          new Error(msg.message || "MP3 encoding failed."),
        );
        state.pendingEncode = null;
      }
      break;
    }
  }
};

worker.onerror = (e) => {
  setStatus(`Worker error: ${e.message || e}`, "error");
  rejectPendingEncode();
  if (state.gen === "busy") {
    state.gen = "idle";
    el.genProgress.classList.remove("active");
    refreshTransport();
  }
};

/* ---------- audio ready / playback ---------- */

function onAudioReady(msg) {
  state.wavBuffer = msg.wav;
  state.peaks = msg.peaks;
  state.duration = msg.duration;
  state.gen = "ready";

  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(
    new Blob([msg.wav], { type: "audio/wav" }),
  );
  audio.src = state.audioUrl;
  audio.currentTime = 0;

  el.backendVal.textContent = msg.backend === "webgpu" ? "WebGPU" : "WASM";
  el.genStatus.textContent = "Ready";
  setGenProgress(100);
  el.timeTotal.textContent = formatTime(state.duration);
  el.timeCurrent.textContent = "0:00";
  el.playerMsg.textContent = "Ready — press Play";
  el.waveform.classList.add("ready");
  el.waveform.setAttribute("aria-valuemax", String(Math.round(state.duration)));
  el.waveform.setAttribute("aria-valuenow", "0");
  el.waveform.setAttribute("aria-valuetext", `0:00 of ${formatTime(state.duration)}`);

  sizeCanvas();
  drawWaveform(0);
  refreshTransport();
  setStatus("");
  if (el.format.value === "mp3") prefetchMp3();
}

function togglePlay() {
  if (audio.paused) {
    audio.play().catch((e) => setStatus(`Playback failed: ${e.message}`, "error"));
  } else {
    audio.pause();
  }
}

audio.addEventListener("play", () => {
  refreshTransport();
  startPlayheadLoop();
});
audio.addEventListener("pause", () => {
  refreshTransport();
  stopPlayheadLoop();
});
audio.addEventListener("ended", () => {
  stopPlayheadLoop();
  audio.currentTime = 0;
  updatePlaybackUi(0);
  refreshTransport();
});

let rafId = null;
function startPlayheadLoop() {
  if (rafId != null) return;
  const tick = () => {
    const dur = state.duration || audio.duration || 0;
    const ratio = dur > 0 ? Math.min(1, audio.currentTime / dur) : 0;
    updatePlaybackUi(ratio);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}
function stopPlayheadLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function updatePlaybackUi(ratio) {
  drawWaveform(ratio);
  const cur = ratio * (state.duration || 0);
  el.timeCurrent.textContent = formatTime(cur);
  el.waveform.setAttribute("aria-valuenow", String(Math.round(cur)));
  el.waveform.setAttribute(
    "aria-valuetext",
    `${formatTime(cur)} of ${formatTime(state.duration)}`,
  );
}

function resetAudio() {
  stopPlayheadLoop();
  if (!audio.paused) audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
  }
  state.wavBuffer = null;
  state.peaks = null;
  state.duration = 0;
  el.waveform.classList.remove("ready");
  el.waveform.setAttribute("aria-valuemax", "0");
  el.waveform.setAttribute("aria-valuenow", "0");
  el.waveform.setAttribute("aria-valuetext", "No audio");
  clearWaveform();
  el.timeCurrent.textContent = "0:00";
  el.timeTotal.textContent = "0:00";
  el.playerMsg.textContent = "No audio yet";
}

/* ---------- waveform canvas ---------- */

const ctx = el.waveform.getContext("2d");
let cssW = 0;
let cssH = 0;

function sizeCanvas() {
  const rect = el.waveform.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cssW = rect.width;
  cssH = rect.height;
  el.waveform.width = Math.max(1, Math.round(cssW * dpr));
  el.waveform.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clearWaveform() {
  if (!cssW) sizeCanvas();
  ctx.clearRect(0, 0, cssW, cssH);
}

function drawWaveform(progress) {
  if (!state.peaks || !cssW) {
    clearWaveform();
    return;
  }
  const peaks = state.peaks;
  const n = peaks.length;
  ctx.clearRect(0, 0, cssW, cssH);

  const styles = getComputedStyle(document.documentElement);
  const dim = styles.getPropertyValue("--wave-dim").trim() || "#5b3a6a";
  const hot = styles.getPropertyValue("--signal").trim() || "#a8db44";

  const mid = cssH / 2;
  const gap = 1;
  const barW = Math.max(1, cssW / n - gap);
  const playedX = progress * cssW;

  for (let i = 0; i < n; i++) {
    const x = (i / n) * cssW;
    const h = Math.max(1.5, peaks[i] * (cssH * 0.9));
    ctx.fillStyle = x <= playedX ? hot : dim;
    ctx.fillRect(x, mid - h / 2, barW, h);
  }

  // Playhead
  if (progress > 0 && progress < 1) {
    ctx.fillStyle = styles.getPropertyValue("--paper").trim() || "#ece3d0";
    ctx.fillRect(playedX - 0.5, 0, 1.5, cssH);
  }
}

function seekTo(seconds) {
  if (state.gen !== "ready" || !state.duration) return;
  const clamped = Math.min(state.duration, Math.max(0, seconds));
  audio.currentTime = clamped;
  updatePlaybackUi(clamped / state.duration);
}

function seekFromEvent(e) {
  if (state.gen !== "ready" || !state.duration) return;
  const rect = el.waveform.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  seekTo(ratio * state.duration);
}
el.waveform.addEventListener("click", seekFromEvent);

el.waveform.addEventListener("keydown", (e) => {
  if (state.gen !== "ready" || !state.duration) return;
  const step = 5;
  let handled = true;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowUp":
      seekTo(audio.currentTime + step);
      break;
    case "ArrowLeft":
    case "ArrowDown":
      seekTo(audio.currentTime - step);
      break;
    case "PageUp":
      seekTo(audio.currentTime + 15);
      break;
    case "PageDown":
      seekTo(audio.currentTime - 15);
      break;
    case "Home":
      seekTo(0);
      break;
    case "End":
      seekTo(state.duration);
      break;
    case " ":
    case "Enter":
      togglePlay();
      break;
    default:
      handled = false;
  }
  if (handled) e.preventDefault();
});

let resizeRaf = null;
window.addEventListener("resize", () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    sizeCanvas();
    const ratio =
      state.duration > 0 ? Math.min(1, audio.currentTime / state.duration) : 0;
    drawWaveform(ratio);
  });
});

/* ---------- save ---------- */

function suggestedBaseName() {
  const words = el.text.value.trim().split(/\s+/).slice(0, 6).join(" ");
  const slug = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "textusound";
}

function requestEncode(jobId) {
  return new Promise((resolve, reject) => {
    state.pendingEncode = { jobId, resolve, reject };
    worker.postMessage({ type: "encode", jobId });
  });
}

// Encode MP3 at most once per generation, reusing an in-flight or cached
// result. Pre-fetching when audio is ready means the bytes are usually present
// before the user clicks Save, so the FS picker isn't followed by a long await.
function ensureMp3(jobId) {
  if (state.mp3 && state.mp3.jobId === jobId) {
    return Promise.resolve(state.mp3.bytes);
  }
  if (state.mp3Promise && state.mp3Promise.jobId === jobId) {
    return state.mp3Promise.promise;
  }
  const promise = requestEncode(jobId).then((bytes) => {
    if (state.jobId === jobId) state.mp3 = { jobId, bytes };
    if (state.mp3Promise && state.mp3Promise.jobId === jobId) {
      state.mp3Promise = null;
    }
    return bytes;
  });
  state.mp3Promise = { jobId, promise };
  return promise;
}

function prefetchMp3() {
  if (state.gen !== "ready") return;
  ensureMp3(state.jobId).catch(() => {
    /* a failed/aborted prefetch is retried on demand at save time */
  });
}

async function prepareBlob(format, jobAtSave, mime) {
  if (format === "mp3") {
    el.saveLabel.textContent = "Encoding…";
    const mp3 = await ensureMp3(jobAtSave);
    return new Blob([mp3], { type: mime });
  }
  return new Blob([state.wavBuffer], { type: mime });
}

function finishSave() {
  el.saveLabel.textContent = "Save";
  el.save.disabled = state.gen !== "ready";
}

async function onSave() {
  if (state.gen !== "ready" || !state.wavBuffer) return;
  const format = el.format.value;
  const ext = format === "mp3" ? "mp3" : "wav";
  const mime = format === "mp3" ? "audio/mpeg" : "audio/wav";
  const filename = `${suggestedBaseName()}.${ext}`;
  const jobAtSave = state.jobId;

  // Path A: File System Access API. The picker MUST run before any await so the
  // click's transient user activation is still valid; only then do we encode.
  if (supportsFsAccess()) {
    let handle;
    try {
      handle = await pickSaveFile(filename, mime, ext);
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus("Save cancelled.", "");
        return;
      }
      handle = null; // fall through to download
    }
    if (handle) {
      el.save.disabled = true;
      let blob;
      try {
        blob = await prepareBlob(format, jobAtSave, mime);
      } catch (e) {
        finishSave();
        if (e && e.name === "AbortError") {
          setStatus(
            "Save cancelled — the text changed before saving. You can delete the empty file your browser created.",
            "",
          );
        } else {
          setStatus(`Save failed: ${(e && e.message) || e}`, "error");
        }
        return;
      }
      el.saveLabel.textContent = "Saving…";
      try {
        await writeToHandle(handle, blob);
        setStatus(`Saved “${handle.name}”.`, "ok");
      } catch (e) {
        if (e && e.name === "AbortError") {
          setStatus("Save cancelled.", "");
        } else {
          // Don't lose the audio: fall back to a download.
          downloadBlob(blob, filename);
          setStatus(
            `Couldn't write to that location — downloaded “${filename}” instead.`,
            "",
          );
        }
      } finally {
        finishSave();
      }
      return;
    }
  }

  // Path B: download fallback (no FS Access API, or the picker was unavailable).
  el.save.disabled = true;
  try {
    const blob = await prepareBlob(format, jobAtSave, mime);
    el.saveLabel.textContent = "Saving…";
    downloadBlob(blob, filename);
    setStatus(`Downloaded “${filename}”.`, "ok");
  } catch (e) {
    if (e && e.name === "AbortError") {
      setStatus("Save cancelled — the text changed before saving.", "");
    } else {
      setStatus(`Save failed: ${(e && e.message) || e}`, "error");
    }
  } finally {
    finishSave();
  }
}
el.save.addEventListener("click", onSave);

/* ---------- input wiring ---------- */

el.text.addEventListener("input", () => {
  if (state.gen === "ready") {
    invalidateToIdle();
  } else if (state.gen === "busy") {
    cancelGeneration();
  }
  updateCharCount();
});

el.speed.addEventListener("input", updateSpeedLabel);
el.speed.addEventListener("change", () => {
  persistPrefs();
  if (state.gen === "ready") invalidateToIdle();
});
el.voice.addEventListener("change", () => {
  persistPrefs();
  if (state.gen === "ready") invalidateToIdle();
});
el.format.addEventListener("change", () => {
  persistPrefs();
  if (el.format.value === "mp3") prefetchMp3();
});

/* ---------- utils ---------- */

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- init ---------- */

populateVoices();
restorePrefs();
updateCharCount();
sizeCanvas();
clearWaveform();
if (supportsFsAccess()) {
  primeMru();
} else {
  el.playerMsg.title =
    "Your browser will save to the downloads folder. For a remembered save location, use a Chromium-based browser.";
}
refreshTransport();
