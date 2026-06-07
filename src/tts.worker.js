import { KokoroTTS } from "kokoro-js";
import {
  splitText,
  concatFloat32,
  silence,
  computePeaks,
  floatToWav,
} from "./audio.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000;
const INTER_CHUNK_SILENCE = 0.18; // seconds between sentences
const WAVEFORM_BUCKETS = 1600;

const state = {
  tts: null,
  backend: null,
  loadPromise: null,
  cancelRequested: false,
  currentJobId: 0,
  genChain: Promise.resolve(), // serializes generation so generate() never overlaps
};

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

async function webgpuAvailable() {
  try {
    if (!("gpu" in navigator) || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function makeProgressCallback() {
  const files = new Map();
  return (data) => {
    if (!data) return;
    if (data.status === "progress" && data.file) {
      files.set(data.file, {
        loaded: data.loaded || 0,
        total: data.total || 0,
      });
    } else if (data.status === "done" && data.file && files.has(data.file)) {
      const f = files.get(data.file);
      files.set(data.file, { loaded: f.total, total: f.total });
    }
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const progress = total > 0 ? loaded / total : 0;
    post({
      type: "progress",
      phase: "load",
      progress,
      loaded,
      total,
    });
  };
}

async function ensureLoaded() {
  if (state.tts) return;
  if (state.loadPromise) return state.loadPromise;

  state.loadPromise = (async () => {
    const progress_callback = makeProgressCallback();
    const useWebgpu = await webgpuAvailable();

    if (useWebgpu) {
      try {
        post({ type: "backend", backend: "webgpu", stage: "loading" });
        state.tts = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: "fp32",
          device: "webgpu",
          progress_callback,
        });
        state.backend = "webgpu";
        post({ type: "backend", backend: "webgpu", stage: "ready" });
        return;
      } catch (e) {
        post({
          type: "backend",
          backend: "wasm",
          stage: "fallback",
          message: String((e && e.message) || e),
        });
      }
    }

    state.tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      progress_callback,
    });
    state.backend = "wasm";
    post({ type: "backend", backend: "wasm", stage: "ready" });
  })();

  try {
    await state.loadPromise;
  } finally {
    state.loadPromise = null;
  }
}

async function handleGenerate(jobId, text, voice, speed) {
  // Superseded before we even started (newer job arrived while queued).
  if (jobId !== state.currentJobId) {
    post({ type: "cancelled", jobId });
    return;
  }

  try {
    await ensureLoaded();
  } catch (e) {
    post({
      type: "error",
      jobId,
      message: "Failed to load the speech model. " + ((e && e.message) || e),
    });
    return;
  }
  if (state.cancelRequested || jobId !== state.currentJobId) {
    post({ type: "cancelled", jobId });
    return;
  }

  const chunks = splitText(text);
  if (chunks.length === 0) {
    post({ type: "error", jobId, message: "There is no text to speak." });
    return;
  }

  const parts = [];
  const total = chunks.length;
  post({ type: "progress", jobId, phase: "generate", done: 0, total });

  for (let i = 0; i < total; i++) {
    if (state.cancelRequested || jobId !== state.currentJobId) {
      post({ type: "cancelled", jobId });
      return;
    }
    try {
      const audio = await state.tts.generate(chunks[i], { voice, speed });
      parts.push(audio.audio);
      if (i < total - 1) parts.push(silence(INTER_CHUNK_SILENCE, SAMPLE_RATE));
    } catch (e) {
      post({
        type: "error",
        jobId,
        message: "Generation failed. " + ((e && e.message) || e),
      });
      return;
    }
    post({ type: "progress", jobId, phase: "generate", done: i + 1, total });
  }

  if (state.cancelRequested || jobId !== state.currentJobId) {
    post({ type: "cancelled", jobId });
    return;
  }

  const pcm = concatFloat32(parts);
  const wav = floatToWav(pcm, SAMPLE_RATE);
  const peaks = computePeaks(pcm, WAVEFORM_BUCKETS);

  post(
    {
      type: "done",
      jobId,
      wav,
      peaks,
      sampleRate: SAMPLE_RATE,
      duration: pcm.length / SAMPLE_RATE,
      backend: state.backend,
    },
    [wav, peaks.buffer],
  );
}

self.onmessage = (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case "generate":
      // Mark this as the active job synchronously so any in-flight generation
      // bails at its next chunk boundary, then queue this one so generate()
      // calls never overlap on the shared model instance. The trailing catch
      // keeps the queue alive if a job throws unexpectedly.
      state.currentJobId = msg.jobId;
      state.cancelRequested = false;
      state.genChain = state.genChain
        .then(() => handleGenerate(msg.jobId, msg.text, msg.voice, msg.speed))
        .catch((e) => {
          post({
            type: "error",
            jobId: msg.jobId,
            message: "Generation failed. " + ((e && e.message) || e),
          });
        });
      break;
    case "cancel":
      state.cancelRequested = true;
      break;
    default:
      break;
  }
};
