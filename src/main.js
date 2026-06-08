import "./styles.css";
import { VOICE_GROUPS, DEFAULT_VOICE, gradeScore } from "./voices.js";
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
  voicePicker: $("voice-picker"),
  voiceButton: $("voice-button"),
  voicePop: $("voice-pop"),
  voiceList: $("voice-listbox"),
  voiceCurrentName: $("voice-current-name"),
  voiceCurrentGrade: $("voice-current-grade"),
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

/* ---------- voice picker (accessible select-only combobox) ---------- */

const voiceById = new Map();
const voiceOrder = []; // option elements in display order, for keyboard nav
let selectedVoice = DEFAULT_VOICE;
let pickerOpen = false;
let activeVoice = null; // keyboard-active option while the list is open
let typeahead = "";
let typeaheadTimer = 0;

function tierClass(grade) {
  const c = grade[0];
  return "g" + (c === "A" || c === "B" || c === "C" || c === "D" ? c : "F");
}

function buildVoicePicker() {
  const frag = document.createDocumentFragment();
  let gi = 0;
  for (const group of VOICE_GROUPS) {
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "group");
    const headId = `vg-${gi++}`;
    wrap.setAttribute("aria-labelledby", headId);

    const head = document.createElement("div");
    head.className = "vp-grp";
    head.id = headId;
    head.textContent = group.label;
    wrap.appendChild(head);

    const sorted = [...group.voices].sort(
      (a, b) =>
        gradeScore(b.grade) - gradeScore(a.grade) ||
        a.name.localeCompare(b.name)
    );
    for (const v of sorted) {
      const opt = document.createElement("div");
      opt.className = "vp-opt";
      opt.id = `vopt-${v.id}`;
      opt.dataset.id = v.id;
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", "false");

      const name = document.createElement("span");
      name.className = "vp-opt-name";
      name.textContent = v.name;

      const grade = document.createElement("span");
      grade.className = `grade ${tierClass(v.grade)}`;
      grade.textContent = v.grade;

      opt.append(name, grade);
      wrap.appendChild(opt);

      voiceById.set(v.id, v);
      voiceOrder.push(opt);
    }
    frag.appendChild(wrap);
  }
  el.voiceList.appendChild(frag);

  el.voiceButton.addEventListener("click", () =>
    pickerOpen ? closePicker() : openPicker()
  );
  el.voiceButton.addEventListener("keydown", onTriggerKeydown);
  el.voiceList.addEventListener("click", onListClick);
  el.voiceList.addEventListener("pointermove", onListPointerMove);
  document.addEventListener("pointerdown", onDocPointerDown);
}

function getVoice() {
  return selectedVoice;
}

function setVoice(id, { fromUser = false } = {}) {
  if (!voiceById.has(id)) id = DEFAULT_VOICE;
  const changed = id !== selectedVoice;

  const prev = document.getElementById(`vopt-${selectedVoice}`);
  if (prev) prev.setAttribute("aria-selected", "false");
  selectedVoice = id;
  const cur = document.getElementById(`vopt-${id}`);
  if (cur) cur.setAttribute("aria-selected", "true");

  const v = voiceById.get(id);
  el.voiceCurrentName.textContent = v.name;
  el.voiceCurrentGrade.textContent = v.grade;
  el.voiceCurrentGrade.className = `grade vp-grade ${tierClass(v.grade)}`;

  if (fromUser && changed) {
    persistPrefs();
    if (state.gen === "ready") invalidateToIdle();
  }
}

function openPicker() {
  if (pickerOpen) return;
  pickerOpen = true;
  el.voicePop.hidden = false;
  el.voiceButton.setAttribute("aria-expanded", "true");
  setActive(selectedVoice, { scroll: true });
}

function closePicker({ focus = true } = {}) {
  if (!pickerOpen) return;
  pickerOpen = false;
  el.voicePop.hidden = true;
  el.voiceButton.setAttribute("aria-expanded", "false");
  el.voiceButton.removeAttribute("aria-activedescendant");
  clearActive();
  if (focus) el.voiceButton.focus();
}

function clearActive() {
  if (activeVoice) {
    const a = document.getElementById(`vopt-${activeVoice}`);
    if (a) a.classList.remove("active");
  }
  activeVoice = null;
}

function setActive(id, { scroll = false } = {}) {
  if (!voiceById.has(id)) return;
  clearActive();
  activeVoice = id;
  const optEl = document.getElementById(`vopt-${id}`);
  optEl.classList.add("active");
  el.voiceButton.setAttribute("aria-activedescendant", optEl.id);
  if (scroll) optEl.scrollIntoView({ block: "nearest" });
}

function moveActive(delta) {
  const idx = voiceOrder.findIndex((o) => o.dataset.id === activeVoice);
  let next = idx < 0 ? 0 : idx + delta;
  next = Math.max(0, Math.min(voiceOrder.length - 1, next));
  setActive(voiceOrder[next].dataset.id, { scroll: true });
}

function setActiveEdge(which) {
  const o = which === "first" ? voiceOrder[0] : voiceOrder[voiceOrder.length - 1];
  setActive(o.dataset.id, { scroll: true });
}

function commitActive() {
  if (activeVoice) setVoice(activeVoice, { fromUser: true });
}

function isTypeaheadKey(e) {
  return (
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    /\S/.test(e.key)
  );
}

function typeaheadFind(ch) {
  clearTimeout(typeaheadTimer);
  typeaheadTimer = window.setTimeout(() => (typeahead = ""), 600);
  const lower = ch.toLowerCase();
  const cycling = typeahead === "" || typeahead === lower.repeat(typeahead.length);
  typeahead += lower;
  const query = cycling ? lower : typeahead;
  const n = voiceOrder.length;
  const curIdx = voiceOrder.findIndex(
    (o) => o.dataset.id === (activeVoice || selectedVoice)
  );
  const startOffset = cycling ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const idx = (curIdx + startOffset + i + n) % n;
    const name = voiceById.get(voiceOrder[idx].dataset.id).name.toLowerCase();
    if (name.startsWith(query)) {
      setActive(voiceOrder[idx].dataset.id, { scroll: true });
      return;
    }
  }
}

function onTriggerKeydown(e) {
  const k = e.key;
  if (!pickerOpen) {
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " " || k === "Spacebar") {
      e.preventDefault();
      openPicker();
    } else if (k === "Home") {
      e.preventDefault();
      openPicker();
      setActiveEdge("first");
    } else if (k === "End") {
      e.preventDefault();
      openPicker();
      setActiveEdge("last");
    } else if (isTypeaheadKey(e)) {
      openPicker();
      typeaheadFind(k);
    }
    return;
  }
  switch (k) {
    case "ArrowDown":
      e.preventDefault();
      moveActive(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveActive(-1);
      break;
    case "Home":
      e.preventDefault();
      setActiveEdge("first");
      break;
    case "End":
      e.preventDefault();
      setActiveEdge("last");
      break;
    case "Enter":
    case " ":
    case "Spacebar":
      e.preventDefault();
      commitActive();
      closePicker();
      break;
    case "Escape":
      e.preventDefault();
      closePicker();
      break;
    case "Tab":
      commitActive();
      closePicker({ focus: false });
      break;
    default:
      if (isTypeaheadKey(e)) typeaheadFind(k);
  }
}

function onListClick(e) {
  const opt = e.target.closest(".vp-opt");
  if (!opt) return;
  setVoice(opt.dataset.id, { fromUser: true });
  closePicker();
}

function onListPointerMove(e) {
  const opt = e.target.closest(".vp-opt");
  if (opt && opt.dataset.id !== activeVoice) setActive(opt.dataset.id);
}

function onDocPointerDown(e) {
  if (pickerOpen && !el.voicePicker.contains(e.target)) {
    closePicker({ focus: false });
  }
}

function restorePrefs() {
  const prefs = loadPrefs();
  setVoice(prefs.voice || DEFAULT_VOICE);
  el.speed.value = String(prefs.speed ?? 1);
  updateSpeedLabel();
}

function persistPrefs() {
  savePrefs({
    voice: getVoice(),
    speed: Number(el.speed.value),
  });
}

function updateSpeedLabel() {
  el.speedVal.textContent = `${Number(el.speed.value).toFixed(1)}×`;
}

function updateCharCount() {
  const n = el.text.value.length;
  el.charCount.textContent = `${n.toLocaleString()} ${n === 1 ? "character" : "characters"}`;
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
    voice: getVoice(),
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

/* ---------- utils ---------- */

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- init ---------- */

buildVoicePicker();
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
