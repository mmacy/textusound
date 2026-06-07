// Kokoro-82M v1.0 voices, grouped for the picker.
// `grade` is Kokoro's training-data quality estimate (VOICES.md): A best → F.
export const VOICE_GROUPS = [
  {
    label: "American · Female",
    voices: [
      { id: "af_heart", name: "Heart", grade: "A" },
      { id: "af_bella", name: "Bella", grade: "A-" },
      { id: "af_nicole", name: "Nicole", grade: "B-" },
      { id: "af_aoede", name: "Aoede", grade: "C+" },
      { id: "af_kore", name: "Kore", grade: "C+" },
      { id: "af_sarah", name: "Sarah", grade: "C+" },
      { id: "af_nova", name: "Nova", grade: "C" },
      { id: "af_sky", name: "Sky", grade: "C-" },
      { id: "af_alloy", name: "Alloy", grade: "C" },
      { id: "af_jessica", name: "Jessica", grade: "D" },
      { id: "af_river", name: "River", grade: "D" },
    ],
  },
  {
    label: "American · Male",
    voices: [
      { id: "am_michael", name: "Michael", grade: "C+" },
      { id: "am_fenrir", name: "Fenrir", grade: "C+" },
      { id: "am_puck", name: "Puck", grade: "C+" },
      { id: "am_echo", name: "Echo", grade: "D" },
      { id: "am_eric", name: "Eric", grade: "D" },
      { id: "am_liam", name: "Liam", grade: "D" },
      { id: "am_onyx", name: "Onyx", grade: "D" },
      { id: "am_adam", name: "Adam", grade: "F+" },
      { id: "am_santa", name: "Santa", grade: "D-" },
    ],
  },
  {
    label: "British · Female",
    voices: [
      { id: "bf_emma", name: "Emma", grade: "B-" },
      { id: "bf_isabella", name: "Isabella", grade: "C" },
      { id: "bf_alice", name: "Alice", grade: "D" },
      { id: "bf_lily", name: "Lily", grade: "D" },
    ],
  },
  {
    label: "British · Male",
    voices: [
      { id: "bm_george", name: "George", grade: "C" },
      { id: "bm_fable", name: "Fable", grade: "C" },
      { id: "bm_daniel", name: "Daniel", grade: "D" },
      { id: "bm_lewis", name: "Lewis", grade: "D+" },
    ],
  },
];

export const DEFAULT_VOICE = "af_heart";

// Higher is better; used to sort each group best → worst (then by name).
export function gradeScore(grade) {
  const base = { A: 4, B: 3, C: 2, D: 1, F: 0 }[grade[0]] ?? 0;
  const mod = grade[1] === "+" ? 0.3 : grade[1] === "-" ? -0.3 : 0;
  return base + mod;
}
