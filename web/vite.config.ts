import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    // ORT comes from the CDN script tag; bundling it would blow the Pages file limit.
    rollupOptions: { external: ["onnxruntime-web"] },
  },
  server: {
    headers: {
      // Required for ORT's multi-threaded WASM backend (SharedArrayBuffer).
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
