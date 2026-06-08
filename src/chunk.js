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

// Split text into chunks for generation while preserving paragraph structure.
//
// Kokoro speaks each chunk as one continuous breath, so anything folded into the
// same chunk is run together with no pause. A heading or short line that lacks
// sentence-ending punctuation would otherwise be glued onto the neighbouring
// sentence (e.g. "THE STATUE BUILDER CULTURE Little is known of…"). To match how
// kokoro itself segments — its splitter treats newlines as boundaries and the
// reference Python pipeline splits input on `\n+` — we keep paragraph breaks as
// hard boundaries: each paragraph (and each standalone line such as a heading) is
// split into sentences on its own and never merged with its neighbours.
//
// Soft wraps (lone newlines inside a paragraph, common in PDF copies) are
// flattened to spaces so hard-wrapped prose isn't chopped mid-sentence; only
// blank lines separate paragraphs. kokoro's splitter then segments each paragraph
// on real sentence boundaries (keeping abbreviations, decimals, money, quotes,
// and URLs intact), and each sentence is finally capped on word boundaries as a
// safety net against the model's token limit.
//
// Returns `[{ text, paragraphBreakBefore }]`. `paragraphBreakBefore` is true for
// the first chunk of every paragraph after the first, so the caller can render a
// longer pause at paragraph boundaries than between sentences within a paragraph.
export function chunkText(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u2028/g, "\n") // Unicode line separator → soft line break
    .replace(/[\u2029\f]/g, "\n\n") // paragraph separator / form feed → break
    .replace(/[^\S\n]+/g, " ") // collapse spaces/tabs but keep newlines
    .replace(/ *\n */g, "\n") // drop spaces hugging a newline
    .trim();
  if (!normalized) return [];

  const chunks = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const flat = paragraph.replace(/\n/g, " ").replace(/ {2,}/g, " ").trim();
    if (!flat) continue;
    const splitter = new TextSplitterStream();
    splitter.push(flat);
    const sentences = [...splitter].flatMap(capLongRun);
    for (let i = 0; i < sentences.length; i++) {
      chunks.push({
        text: sentences[i],
        paragraphBreakBefore: chunks.length > 0 && i === 0,
      });
    }
  }
  return chunks;
}
