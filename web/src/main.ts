/**
 * Entry point — scaffolding only. The imaging pipeline has not been ported yet; see
 * ../PORT.md for what each Python module maps onto and what is still outstanding.
 */
import { Sam } from "./lib/sam";
import { downloadBytes } from "./lib/constants";

const app = document.getElementById("app")!;
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

app.textContent =
  `scanfit (browser build, scaffolding). First-visit model download: ` +
  `tiny/fp32 ${mb(downloadBytes("tiny", "fp32"))}, tiny/fp16 ${mb(downloadBytes("tiny", "fp16"))}, ` +
  `base-plus/fp16 ${mb(downloadBytes("base-plus", "fp16"))}.`;

export { Sam };
