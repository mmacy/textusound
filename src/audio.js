export function concatFloat32(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Float32Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function silence(seconds, sampleRate) {
  return new Float32Array(Math.max(0, Math.round(seconds * sampleRate)));
}

export function computePeaks(samples, buckets) {
  const out = new Float32Array(buckets);
  if (samples.length === 0) return out;
  const size = samples.length / buckets;
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(samples.length, Math.floor((i + 1) * size));
    let max = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > max) max = a;
    }
    out[i] = max;
  }
  return out;
}

// Deterministic sentence/word chunking so generation progress is exact.
// Uses Intl.Segmenter (keeps decimals like "3.14" and many abbreviations
// intact) with a regex fallback, then hard-caps very long runs on word
// boundaries so a single chunk never grows unbounded.
export function splitText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  let sentences = null;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      sentences = [...seg.segment(clean)]
        .map((s) => s.segment.trim())
        .filter(Boolean);
    } catch {
      sentences = null;
    }
  }
  if (!sentences || sentences.length === 0) {
    sentences = (
      clean.match(/[^.!?…]+[.!?…]+["')\]]*(?:\s|$)|[^.!?…]+$/g) || [clean]
    )
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const MAX = 300;
  const out = [];
  for (const segment of sentences) {
    let t = segment;
    while (t.length > MAX) {
      let cut = t.lastIndexOf(" ", MAX);
      if (cut <= 0) cut = MAX;
      const head = t.slice(0, cut).trim();
      if (head) out.push(head);
      t = t.slice(cut).trim();
    }
    if (t) out.push(t);
  }
  return out;
}

function clampSample(s) {
  if (s > 1) s = 1;
  else if (s < -1) s = -1;
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

export function floatToWav(samples, sampleRate) {
  const numFrames = samples.length;
  const buffer = new ArrayBuffer(44 + numFrames * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + numFrames * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, numFrames * 2, true);
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    view.setInt16(offset, clampSample(samples[i]), true);
    offset += 2;
  }
  return buffer;
}
