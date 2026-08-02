import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtures = resolve(here, "../fixtures");
const privateFixturesAvailable = ["ilkyaz.pdf", "irene.pdf"]
  .every(name => existsSync(resolve(fixtures, "private", name)));

export default defineConfig({
  // This server exists only for the corpus suite. It gives public and ignored private
  // fixtures the same stable URLs without adding identity documents to web/public.
  publicDir: fixtures,
  optimizeDeps: { include: ["onnxruntime-web"] },
  define: {
    __PRIVATE_FIXTURES_AVAILABLE__: JSON.stringify(privateFixturesAvailable),
    __RUN_MODEL_CORPUS__: JSON.stringify(process.env.CROPSIZE_RUN_BROWSER_MODEL_FIXTURES === "1"),
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { channel: "chrome" },
        persistentContext: true,
      }),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
    },
    fileParallelism: false,
  },
});
