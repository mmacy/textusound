import { TextSplitterStream } from "kokoro-js";

// Kokoro truncates input past ~510 phoneme tokens, silently dropping audio.
// TextSplitterStream splits on sentence boundaries but never caps length, so a
// single run-on sentence could overflow. 400 chars is a measured safety margin:
// using Kokoro's real tokenizer, 400 chars phonemizes to ~427 tokens for plain
// prose and ~451 for phoneme-dense long-word text — both comfortably under 510
// (500 chars overflowed at ~529). 400 also exceeds virtually every real sentence,
// so this cap almost never fires; it's a backstop, not the normal path.
const MAX_CHUNK_CHARS = 400;

// Word-boundary fallback for the rare sentence longer than the cap.
function capLongRun(sentence) {
  const out = [];
  let t = sentence.trim();
  while (t.length > MAX_CHUNK_CHARS) {
    let cut = t.lastIndexOf(" ", MAX_CHUNK_CHARS);
    if (cut <= 0) cut = MAX_CHUNK_CHARS;
    const head = t.slice(0, cut).trim();
    if (head) out.push(head);
    t = t.slice(cut).trim();
  }
  if (t) out.push(t);
  return out;
}

// Split text into sentence-sized chunks for generation. Whitespace is collapsed
// first so hard-wrapped lines never become false sentence boundaries; kokoro's
// splitter then segments on real sentence boundaries (keeping abbreviations,
// decimals, money, quotes, and URLs intact); each sentence is finally capped on
// word boundaries as a safety net against the model's token limit.
export function chunkText(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const splitter = new TextSplitterStream();
  splitter.push(clean);
  return [...splitter].flatMap(capLongRun);
}
