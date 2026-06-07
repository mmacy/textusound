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
import { tidyReport } from "./audio.js";

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
  tidy: $("tidy"),
  notice: $("tidy-notice"),
  noticeMsg: $("tidy-notice-msg"),
  undo: $("tidy-undo"),
};

const MAX_CHARS = 8000;

const state = {
  gen: "idle", // idle | busy | ready
  jobId: 0,
  wavBuffer: null,
  peaks: null,
  duration: 0,
  audioUrl: null,
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
  updateSpeedLabel();
}

function persistPrefs() {
  savePrefs({
    voice: el.voice.value,
    speed: Number(el.speed.value),
  });
}

function updateSpeedLabel() {
  el.speedVal.textContent = `${Number(el.speed.value).toFixed(1)}×`;
}

function updateCharCount() {
  const n = el.text.value.length;
  el.charCount.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
  el.charCount.classList.toggle("over", n > MAX_CHARS);
  refreshTidyLamp();
  refreshTransport();
}

// Light the TIDY lamp only when the current script actually has something to
// clean up, so it reads as a gentle, honest nudge rather than ever-present
// chrome.
function refreshTidyLamp() {
  el.tidy.disabled = !tidyReport(el.text.value).changed;
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

// Single source of truth for discarding generated audio: bumps the job id so
// any in-flight worker result is ignored and returns the UI to the idle state.
function invalidateToIdle() {
  state.jobId += 1;
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
  state.jobId += 1; // any in-flight result for the old id is now stale
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
      state.gen = "idle";
      el.genProgress.classList.remove("active");
      el.genStatus.textContent = "Error";
      el.genPercent.textContent = "";
      setStatus(msg.message || "Something went wrong.", "error");
      refreshTransport();
      break;
    }
  }
};

worker.onerror = (e) => {
  setStatus(`Worker error: ${e.message || e}`, "error");
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

function finishSave() {
  el.saveLabel.textContent = "Save";
  el.save.disabled = state.gen !== "ready";
}

async function onSave() {
  if (state.gen !== "ready" || !state.wavBuffer) return;
  const filename = `${suggestedBaseName()}.wav`;
  // WAV bytes are already in hand, so the blob is built synchronously — this
  // keeps the save picker within the click's user activation and means there's
  // never a half-written file.
  const blob = new Blob([state.wavBuffer], { type: "audio/wav" });

  // Path A: File System Access API (remembers the directory).
  if (supportsFsAccess()) {
    let handle;
    try {
      handle = await pickSaveFile(filename, "audio/wav", "wav");
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus("Save cancelled.", "");
        return;
      }
      handle = null; // fall through to download
    }
    if (handle) {
      el.save.disabled = true;
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
  downloadBlob(blob, filename);
  setStatus(`Downloaded “${filename}”.`, "ok");
}
el.save.addEventListener("click", onSave);

/* ---------- input wiring ---------- */

el.text.addEventListener("input", () => {
  if (state.gen === "ready") {
    invalidateToIdle();
  } else if (state.gen === "busy") {
    cancelGeneration();
  }
  // A genuine edit supersedes any standing undo offer.
  hideTidyNotice();
  updateCharCount();
});

/* ---------- tidy (clean pasted / messy text) ---------- */

// Auto-tidy pasted text (e.g. from PDFs) so soft line wraps and hyphenated word
// breaks don't muddy the speech. Only intervene when tidying changes something,
// so an ordinary paste keeps the browser's native undo behavior.
el.text.addEventListener("paste", (e) => {
  const data = e.clipboardData || window.clipboardData;
  if (!data) return;
  const raw = data.getData("text/plain");
  if (!raw) return;
  // Don't trim the fragment's edges — a leading/trailing space may be the only
  // thing separating it from text already in the field.
  const report = tidyReport(raw, { trimEdges: false });
  if (!report.changed) return;
  e.preventDefault();

  // Remember what the field WOULD be with the raw paste, so Undo can restore it.
  const start = el.text.selectionStart ?? el.text.value.length;
  const end = el.text.selectionEnd ?? el.text.value.length;
  const rawFull = el.text.value.slice(0, start) + raw + el.text.value.slice(end);

  insertIntoTextarea(el.text, report.text); // fires input → resets state + lamp
  flashTextarea();
  showTidyNotice(report, rawFull);
});

// The manual lamp: tidy whatever is already in the box (typed, drag-dropped, or
// pasted before the user noticed the auto behavior).
el.tidy.addEventListener("click", () => {
  const before = el.text.value;
  const report = tidyReport(before);
  if (!report.changed) return;
  el.text.value = report.text;
  el.text.selectionStart = el.text.selectionEnd = report.text.length;
  el.text.dispatchEvent(new Event("input", { bubbles: true })); // resets state + lamp
  flashTextarea();
  showTidyNotice(report, before);
  el.text.focus();
});

el.undo.addEventListener("click", () => {
  if (!pendingUndo) return;
  // Bail if the script changed since we offered the undo — never clobber edits.
  if (el.text.value !== pendingUndo.expect) {
    hideTidyNotice();
    return;
  }
  const restore = pendingUndo.revertTo;
  hideTidyNotice();
  el.text.value = restore;
  el.text.selectionStart = el.text.selectionEnd = restore.length;
  el.text.dispatchEvent(new Event("input", { bubbles: true }));
  el.text.focus();
});

let pendingUndo = null;
let noticeTimer = null;

function describeTidy(report) {
  const parts = [];
  if (report.joinedWraps > 0) {
    const w = report.joinedWraps;
    parts.push(`joined <b>${w}</b> wrapped ${w === 1 ? "line" : "lines"}`);
  }
  if (report.mendedSplits > 0) {
    const s = report.mendedSplits;
    parts.push(`mended <b>${s}</b> split ${s === 1 ? "word" : "words"}`);
  }
  return parts.length ? `Tidied — ${parts.join(" · ")}.` : "Tidied spacing.";
}

function showTidyNotice(report, revertTo) {
  pendingUndo = { revertTo, expect: el.text.value };
  el.noticeMsg.innerHTML = describeTidy(report);
  el.notice.hidden = false;
  // Replay the slide-in even on a rapid second tidy.
  el.notice.style.animation = "none";
  void el.notice.offsetWidth;
  el.notice.style.animation = "";
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideTidyNotice, 9000);
}

function hideTidyNotice() {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  el.notice.hidden = true;
  pendingUndo = null;
}

function flashTextarea() {
  el.text.classList.remove("flash-tidy");
  void el.text.offsetWidth; // restart the animation
  el.text.classList.add("flash-tidy");
}

function insertIntoTextarea(textarea, text) {
  textarea.focus();
  // execCommand keeps the native undo stack intact where supported.
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText(text, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

el.speed.addEventListener("input", updateSpeedLabel);
el.speed.addEventListener("change", () => {
  persistPrefs();
  if (state.gen === "ready") invalidateToIdle();
});
el.voice.addEventListener("change", () => {
  persistPrefs();
  if (state.gen === "ready") invalidateToIdle();
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
