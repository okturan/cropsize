/**
 * The model, as the app sees it: which size is chosen, whether it is downloaded or loaded,
 * and a queue so model work runs one job at a time. ONNX Runtime sessions cannot run two
 * inferences at once, and a second detection started mid-way used to fail or interleave.
 */
import { ui, modelButtons } from "./dom";
import { downloadBytes, type Quality } from "./lib/constants";
import { pruneModelCache, warmCache } from "./lib/model-loader";
import { Sam } from "./lib/sam";
import type { StepSpec } from "./ui/progress";

const PRECISION = "fp16";
const CHOICE_KEY = "cropsize.model";
const LABEL: Record<Quality, string> = { "base-plus": "base plus", tiny: "tiny" };

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

function storedChoice(): Quality {
  try {
    const value = localStorage.getItem(CHOICE_KEY);
    return value === "tiny" || value === "base-plus" ? value : "base-plus";
  } catch {
    return "base-plus";
  }
}

export class ModelController {
  quality: Quality = storedChoice();
  sam = new Sam(this.quality, PRECISION);
  private queue: Promise<unknown> = Promise.resolve();
  private running = 0;
  private generation = 0;
  private warming = false;

  constructor() {
    ui.model.value = this.quality;
  }

  get runtimeAvailable(): boolean {
    return typeof ort !== "undefined";
  }

  get busy(): boolean { return this.running > 0; }

  /** Loading steps a job must show before its own, empty when the model is already loaded. */
  loadingSteps(): StepSpec[] {
    if (this.sam.loaded) return [];
    return [
      { id: "download", label: `Download the model, ${megabytes(this.totalBytes)}` },
      { id: "compile", label: "Start the model" },
    ];
  }

  get totalBytes(): number {
    return downloadBytes(this.quality, PRECISION);
  }

  /** Run model work after anything already queued; model buttons are disabled meanwhile. */
  exclusive<T>(job: (sam: Sam) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.running++;
      this.syncButtons();
      try {
        return await job(this.sam);
      } finally {
        this.running--;
        this.syncButtons();
        void this.showStatus();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Switch size. Waits for running work, frees the old sessions, and remembers the choice. */
  async choose(quality: Quality): Promise<void> {
    if (quality === this.quality) return;
    this.generation++;
    await this.exclusive(async previous => {
      this.quality = quality;
      this.sam = new Sam(quality, PRECISION);
      await previous.release();
    });
    try {
      localStorage.setItem(CHOICE_KEY, quality);
    } catch {
      // not remembered, which only costs the default next visit
    }
    await this.showStatus();
  }

  /** The header badge: one true statement about where the model is. */
  async showStatus(): Promise<void> {
    if (this.warming) return;
    const badge = ui.engine;
    const name = `SAM 2.1 ${LABEL[this.quality]}`;
    badge.style.removeProperty("--progress");
    if (!this.runtimeAvailable) {
      badge.textContent = "model runtime did not load; refresh, or check the network";
      badge.classList.remove("on");
      return;
    }
    if (this.sam.loaded) {
      const where = this.sam.backend === "webgpu" ? "WebGPU" : "WASM";
      badge.textContent = `${name} ready on ${where}${Sam.threaded ? "" : ", one thread"}`;
      badge.title = Sam.threaded
        ? "the model is loaded and runs in this tab"
        : "this page is not cross-origin isolated, so the model runs on one thread and is slower";
      badge.classList.add("on");
      return;
    }
    const { have, of } = await this.sam.cached();
    badge.classList.toggle("on", have === of);
    badge.textContent = have === of
      ? `${name} downloaded, ready to start`
      : have > 0
        ? `${name} partly downloaded, ${have} of ${of} files`
        : `${name}, ${megabytes(this.totalBytes)} to download on first use`;
    badge.title = "where the model is and what it runs on";
  }

  /**
   * Download the chosen model in the background once the page is idle, so the first scan
   * finds it cached. A real load joins the download in flight rather than starting over.
   */
  warmUp(): void {
    if (!this.runtimeAvailable || this.warming) return;
    const generation = this.generation;
    const quality = this.quality;
    const name = `SAM 2.1 ${LABEL[quality]}`;
    this.warming = true;
    void pruneModelCache();
    warmCache(quality, PRECISION, () => generation !== this.generation, (loaded, total) => {
      if (total === 0) return;
      ui.engine.classList.remove("on");
      ui.engine.style.setProperty("--progress", String(loaded / total));
      ui.engine.textContent = `Fetching ${name} in the background, ${megabytes(loaded)} of ${megabytes(total)}`;
    })
      .catch(() => undefined)          // offline or blocked: a real load retries and says why
      .finally(() => {
        this.warming = false;
        void this.showStatus();
        // The size changed while this ran: warm the new one instead.
        if (generation !== this.generation) this.warmUp();
      });
  }

  private syncButtons() {
    for (const button of modelButtons()) button.disabled = this.busy;
    ui.model.disabled = this.busy;
  }
}
