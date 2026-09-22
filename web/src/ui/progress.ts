/**
 * The loading panel: one row per step, each with its own bar.
 *
 * Three kinds of bar, and each says which it is. A download knows its bytes, so its bar is
 * exact and carries speed and time left. Counted work (decoder passes) is exact too.
 * Compiling a session and running the encoder report nothing, so those bars fill against how
 * long the same step took last time on this device, lighter in colour, and the label says
 * "usually"; before this device has any history they fill against a rough built-in guess and
 * show only the elapsed time, claiming nothing.
 */
import { ui } from "../dom";
import type { Report } from "../lib/progress";

export type StepId = "read" | "straighten" | "download" | "compile" | "encode" | "decode" | "refine";
export interface StepSpec { id: StepId; label: string }

const ORDER: StepId[] = ["read", "straighten", "download", "compile", "encode", "decode", "refine"];
const SHOW_AFTER_MS = 250;
const TIMINGS_KEY = "cropsize.timings.v1";

/* --------------------------------------------------------------- remembered timings */
function readTimings(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(TIMINGS_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function recordTiming(key: string, ms: number) {
  try {
    const timings = readTimings();
    const previous = timings[key];
    timings[key] = Math.round(previous ? previous * 0.5 + ms * 0.5 : ms);
    localStorage.setItem(TIMINGS_KEY, JSON.stringify(timings));
  } catch {
    // storage blocked: the next run starts without an estimate, which is still honest
  }
}

/* ---------------------------------------------------------------------- formatting */
const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const megabytes = (bytes: number) => {
  const mb = bytes / 1e6;       // decimal, as file browsers count
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
};

/* ---------------------------------------------------------------------------- steps */
type State = "pending" | "active" | "done" | "failed";

interface Step {
  id: StepId;
  row: HTMLLIElement;
  bar: HTMLElement;
  fill: HTMLElement;
  meta: HTMLElement;
  state: State;
  startedAt: number;
  /** estimated bars only: the stored timing key and the expected duration */
  timingKey?: string;
  expectedMs?: number;
  measured?: boolean;
  metaPrefix?: string;
  /** downloads only: where the byte count stood when network bytes started arriving */
  download?: { t0: number; bytes0: number };
}

function stepRow(spec: StepSpec): Step {
  const row = document.createElement("li");
  row.className = "step";
  row.dataset.state = "pending";
  const mark = document.createElement("span");
  mark.className = "stepMark";
  mark.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "stepLabel";
  label.textContent = spec.label;
  const meta = document.createElement("span");
  meta.className = "stepMeta";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", spec.label);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("div");
  fill.className = "barFill";
  bar.append(fill);
  row.append(mark, label, meta, bar);
  return { id: spec.id, row, bar, fill, meta, state: "pending", startedAt: 0 };
}

/** Default expectations before this device has been measured, used only to shape the bar. */
const FIRST_GUESS_MS: Record<string, number> = {
  "compile:tiny": 2500, "compile:base-plus": 5000,
  "encode:tiny": 2000, "encode:base-plus": 5000,
};

/* ------------------------------------------------------------------------------ run */
export class ProgressRun {
  private readonly steps = new Map<StepId, Step>();
  private readonly startedAt = performance.now();
  private readonly showTimer: number;
  private readonly ticker: number;
  private closed = false;
  private compileStartedAt = 0;

  constructor(
    private readonly panel: ProgressPanel,
    title: string,
    specs: StepSpec[],
    /** which model the timings belong to, so tiny and base plus learn separately */
    private readonly scope: string,
    delayMs: number,
  ) {
    ui.progressTitle.textContent = title;
    ui.progressElapsed.textContent = "";
    ui.progressFoot.hidden = true;
    ui.progressFoot.replaceChildren();
    ui.progressFoot.classList.remove("warn");
    ui.progressSteps.replaceChildren();
    for (const spec of [...specs].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))) {
      const step = stepRow(spec);
      this.steps.set(spec.id, step);
      ui.progressSteps.append(step.row);
    }
    this.showTimer = window.setTimeout(() => {
      if (!this.closed) ui.progress.hidden = false;
    }, delayMs);
    this.ticker = window.setInterval(() => this.tick(), 200);
  }

  has(id: StepId): boolean { return this.steps.has(id); }

  /** Begin a step. Steps earlier in the order that never started are dropped: they did not
   *  apply this time, such as the download when everything was already cached. */
  start(id: StepId, meta = ""): void {
    const step = this.steps.get(id);
    if (!step || step.state !== "pending") return;
    for (const earlier of ORDER.slice(0, ORDER.indexOf(id))) {
      const other = this.steps.get(earlier);
      if (other?.state === "pending") {
        other.row.remove();
        this.steps.delete(earlier);
      } else if (other?.state === "active") {
        this.done(earlier);
      }
    }
    step.state = "active";
    step.startedAt = performance.now();
    step.row.dataset.state = "active";
    step.meta.textContent = meta;
    this.setFraction(step, 0);
  }

  /** Exact progress, 0..1. */
  set(id: StepId, fraction: number, meta?: string): void {
    const step = this.steps.get(id);
    if (!step) return;
    if (step.state === "pending") this.start(id);
    if (step.state !== "active") return;
    step.bar.classList.remove("indeterminate", "estimated");
    step.timingKey = undefined;
    this.setFraction(step, fraction);
    if (meta !== undefined) step.meta.textContent = meta;
  }

  /** A step that reports nothing: fill against its remembered duration, if there is one. */
  estimate(id: StepId, kind: "compile" | "encode", metaPrefix = ""): void {
    const step = this.steps.get(id);
    if (!step) return;
    if (step.state === "pending") this.start(id);
    const key = `${kind}:${this.scope}`;
    const measured = readTimings()[key];
    step.timingKey = key;
    step.measured = measured !== undefined;
    step.expectedMs = measured ?? FIRST_GUESS_MS[key];
    step.metaPrefix = metaPrefix;
    step.bar.classList.toggle("estimated", step.expectedMs !== undefined);
    step.bar.classList.toggle("indeterminate", step.expectedMs === undefined);
    this.tick();
  }

  done(id: StepId, meta?: string): void {
    const step = this.steps.get(id);
    if (!step || step.state === "done") return;
    if (step.state === "pending") this.start(id);
    step.state = "done";
    step.row.dataset.state = "done";
    step.bar.classList.remove("indeterminate", "estimated");
    this.setFraction(step, 1);
    step.meta.textContent = meta ?? seconds(performance.now() - step.startedAt);
  }

  /** Stop with an error: the failing step turns red, the message stays until dismissed. */
  fail(message: string): void {
    for (const step of this.steps.values()) {
      if (step.state === "active") {
        step.state = "failed";
        step.row.dataset.state = "failed";
      }
    }
    this.stopTimers();
    ui.progressFoot.textContent = message;
    ui.progressFoot.classList.add("warn");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.style.marginLeft = "10px";
    close.addEventListener("click", () => this.close());
    ui.progressFoot.append(close);
    ui.progressFoot.hidden = false;
    ui.progress.hidden = false;
    close.focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    ui.progress.hidden = true;
    this.panel.release(this);
  }

  /** Model work reports here; see lib/progress.ts for the events. */
  readonly report: Report = event => {
    switch (event.phase) {
      case "download": {
        const step = this.steps.get("download");
        if (!step) return;
        if (event.loaded >= event.total) {
          this.done("download", event.fromCache
            ? "already in this browser" : megabytes(event.total));
          return;
        }
        if (step.state === "pending") this.start("download");
        const now = performance.now();
        step.download ??= { t0: now, bytes0: event.loaded };
        const elapsed = (now - step.download.t0) / 1000;
        const rate = elapsed > 0.8 ? (event.loaded - step.download.bytes0) / elapsed : 0;
        const parts = [`${megabytes(event.loaded)} of ${megabytes(event.total)}`];
        if (rate > 0) {
          parts.push(`${megabytes(rate)}/s`);
          parts.push(`${seconds(((event.total - event.loaded) / rate) * 1000)} left`);
        }
        this.set("download", event.loaded / event.total, parts.join(" · "));
        return;
      }
      case "compile":
        if (event.part === "encoder" && event.state === "start") {
          this.compileStartedAt = performance.now();
          this.estimate("compile", "compile", "image encoder");
        } else if (event.part === "decoder" && event.state === "start") {
          const step = this.steps.get("compile");
          if (step) step.metaPrefix = "prompt decoder";
        } else if (event.part === "decoder" && event.state === "done") {
          const took = performance.now() - this.compileStartedAt;
          recordTiming(`compile:${this.scope}`, took);
          this.done("compile", seconds(took));
        }
        return;
      case "encode": {
        if (event.state === "start") this.estimate("encode", "encode");
        else if (event.state === "reused") this.done("encode", "reused");
        else {
          const step = this.steps.get("encode");
          const took = step ? performance.now() - step.startedAt : 0;
          if (step) recordTiming(`encode:${this.scope}`, took);
          this.done("encode", seconds(took));
        }
        return;
      }
      case "decode":
      case "refine": {
        const id = event.phase;
        if (!this.steps.has(id)) return;
        if (event.total === 0) return;
        this.set(id, event.done / event.total, `${event.done} of ${event.total}`);
        return;
      }
    }
  };

  private setFraction(step: Step, fraction: number) {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    step.fill.style.width = `${percent}%`;
    step.bar.setAttribute("aria-valuenow", String(percent));
  }

  /** Estimated bars: 90% at the expected time, then a slow crawl that never claims done. */
  private tick() {
    const now = performance.now();
    ui.progressElapsed.textContent = seconds(now - this.startedAt);
    for (const step of this.steps.values()) {
      if (step.state !== "active" || !step.timingKey) continue;
      const elapsed = now - step.startedAt;
      const prefix = step.metaPrefix ? `${step.metaPrefix} · ` : "";
      if (step.expectedMs === undefined) {
        step.meta.textContent = `${prefix}${seconds(elapsed)}`;
        continue;
      }
      const ratio = elapsed / step.expectedMs;
      const fraction = ratio <= 1 ? 0.9 * ratio : 0.9 + 0.09 * (1 - Math.exp(-(ratio - 1)));
      this.setFraction(step, fraction);
      step.meta.textContent = step.measured
        ? `${prefix}${seconds(elapsed)} · usually ${seconds(step.expectedMs)}`
        : `${prefix}${seconds(elapsed)}`;
    }
  }

  private stopTimers() {
    window.clearTimeout(this.showTimer);
    window.clearInterval(this.ticker);
  }
}

export class ProgressPanel {
  private current: ProgressRun | null = null;

  /** Open a run; a previous one still on screen (say, a failure message) is replaced. */
  begin(
    title: string, steps: StepSpec[], scope: string,
    { delayMs = SHOW_AFTER_MS }: { delayMs?: number } = {},
  ): ProgressRun {
    this.current?.close();
    this.current = new ProgressRun(this, title, steps, scope, delayMs);
    return this.current;
  }

  release(run: ProgressRun): void {
    if (this.current === run) this.current = null;
  }
}
