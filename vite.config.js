import { defineConfig } from "vite";

// Relative base so the app works both at a domain root and under a
// GitHub Pages project subpath (e.g. https://USER.github.io/justsayit/).
export default defineConfig({
  base: "./",
  build: {
    target: "esnext",
    sourcemap: false,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["kokoro-js", "@huggingface/transformers"],
  },
});
