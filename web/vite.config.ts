import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * `?models=local` loads the weights from this origin instead of Hugging Face, which keeps the
 * end-to-end test offline and fast. They live in the ignored `.models/<size>/` folder and are
 * served by the dev server only: anything under public/ would be copied into the build, and
 * Pages refuses files over 25 MiB.
 */
function localModels(): Plugin {
  const root = resolve(__dirname, ".models");
  return {
    name: "cropsize-local-models",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/models", (request, response, next) => {
        const match = /^\/(tiny|base-plus)\/([a-z0-9_]+\.onnx(?:_data)?)$/i.exec(request.url ?? "");
        if (!match) return next();
        const file = resolve(root, match[1]!, match[2]!);
        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", String(size));
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        createReadStream(file).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [localModels()],
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
