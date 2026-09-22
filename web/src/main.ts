/**
 * cropsize in the browser. Loads a scan, runs SAM 2.1 locally, measures the real size from
 * the PDF's own geometry, and writes a PDF at that size. No server, no upload.
 *
 * This file only wires modules together:
 *   model.ts        which model, its download state, one-job-at-a-time queue
 *   workspace.ts    the open document, its pages, detection, several items, the sheet tray
 *   ui/progress.ts  the loading panel      ui/scan-view.ts  the scan pane
 *   ui/output.ts    preview and PDF        ui/settings.ts   the settings strip
 *   ui/lists.ts     item and tray lists    dom.ts           every element, looked up once
 */
import Split from "split.js";
import { ui } from "./dom";
import type { Quality } from "./lib/constants";
import { loadFile, loadSample } from "./lib/source";
import { ModelController } from "./model";
import { state as S } from "./state";
import { createOutputController } from "./ui/output";
import { ProgressPanel } from "./ui/progress";
import { createScanView } from "./ui/scan-view";
import { bindSettings, currentFit, layout, tone } from "./ui/settings";
import { createWorkspace } from "./workspace";

const model = new ModelController();
const progress = new ProgressPanel();

/**
 * What the live crop is made of, so the sheet knows whether it already holds it. Anything
 * that changes the pixels or the printed size is here; the sheet and margin are not,
 * because they change the page around the items rather than the items.
 */
const liveSignature = (): string => JSON.stringify([
  S.scan?.name, S.page, S.skew, S.selectedObjectId,
  [S.box.x0, S.box.y0, S.box.x1, S.box.y1].map(v => v.toFixed(4)),
  tone(), ui.trim.checked, currentFit(), ui.preset.value,
]);

const trimMask = () => (S.objects.length === 0 && ui.trim.checked ? S.mask : null);
const output = createOutputController(S, layout, trimMask, liveSignature);
const view = createScanView(S, () => {
  output.refresh();
  workspace.remember();
});

let split: ReturnType<typeof Split> | null = null;
const workspace = createWorkspace({
  model,
  progress,
  draw: view.draw,
  refresh: output.refresh,
  addLiveToSheet: output.addLiveToSheet,
  onShown() {
    // Split.js rather than a hand-rolled drag: gutter, sizing maths and keyboard in 2 kB.
    // Redraw on drag because the canvas is sized in pixels.
    split ??= Split(["#paneIn", "#paneOut"], {
      sizes: [50, 50], minSize: 260, gutterSize: 14, snapOffset: 0, onDrag: view.draw,
    });
  },
});

/* --------------------------------------------------------------------- opening files */
const openFile = (file: File | undefined) => {
  if (file) void workspace.open(() => loadFile(file));
};
for (const input of [ui.file, ui.file2]) {
  input.addEventListener("change", () => {
    openFile(input.files?.[0]);
    input.value = "";                     // choosing the same file again should reopen it
  });
}
ui.sample.addEventListener("click", () => void workspace.open(loadSample));

// Drop a file anywhere: on the start screen, or onto the app to open another.
let dragDepth = 0;
addEventListener("dragenter", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth++;
  ui.drop.classList.add("over");
});
addEventListener("dragover", event => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.drop.classList.remove("over");
});
addEventListener("drop", event => {
  event.preventDefault();
  dragDepth = 0;
  ui.drop.classList.remove("over");
  openFile(event.dataTransfer?.files[0]);
});

/* -------------------------------------------------------------------------- toolbar */
ui.pageSelect.addEventListener("change", async () => {
  const next = Number(ui.pageSelect.value);
  if (!Number.isInteger(next)) return;
  ui.pageSelect.disabled = true;
  try {
    await workspace.selectPage(next);
  } catch (error) {
    ui.pageSelect.value = String(S.page);
    workspace.setNote({ text: "Could not open that page.", detail: (error as Error).message, warn: true });
  } finally {
    ui.pageSelect.disabled = false;
  }
});
ui.startOver.addEventListener("click", () => location.reload());
ui.rotL.addEventListener("click", () => workspace.turn(3));
ui.rotR.addEventListener("click", () => workspace.turn(1));
ui.rot180.addEventListener("click", () => workspace.turn(2));
ui.redetect.addEventListener("click", () => void workspace.redetect());
ui.findSeveral.addEventListener("click", () => void workspace.toggleObjects());
ui.mergeObjects.addEventListener("click", () => void workspace.mergeTicked());
ui.trim.addEventListener("change", output.refresh);

ui.model.addEventListener("change", async () => {
  await model.choose(ui.model.value as Quality);
  if (S.scan) await workspace.redetect();
  else model.warmUp();                  // fetch the newly chosen weights in the background
});

// Straightening re-renders the whole frame, so wait for the slider to settle.
let skewTimer: number | undefined;
ui.skew.addEventListener("input", () => {
  ui.skewOut.textContent = Number.parseFloat(ui.skew.value).toFixed(1);
  window.clearTimeout(skewTimer);
  skewTimer = window.setTimeout(() => workspace.setSkew(Number.parseFloat(ui.skew.value)), 200);
});

/* ------------------------------------------------------------------- settings, output */
bindSettings(output.refresh, () => {
  workspace.retone();
  output.refresh();
});
ui.addToSheet.addEventListener("click", () => void workspace.addToSheet());
ui.clearTray.addEventListener("click", workspace.clearSheet);

ui.download.addEventListener("click", async () => {
  if (!S.scan) return;
  const label = ui.download.textContent;
  ui.download.disabled = true;
  ui.download.textContent = "Writing the PDF";
  try {
    const { blob, filename } = await output.download();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    // Revoking straight after click() can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  } catch (error) {
    workspace.setNote({ text: "Could not write the PDF.", detail: (error as Error).message, warn: true });
  } finally {
    ui.download.disabled = false;
    ui.download.textContent = label;
  }
});

let resizeTimer: number | undefined;
addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(view.draw, 120);
});

/* ----------------------------------------------------------------------------- start */
if (!model.runtimeAvailable) {
  // The runtime comes from a CDN script tag. If it never ran (blocked network, filtering
  // proxy, integrity mismatch) nothing downstream can work, so say so before anyone tries.
  for (const control of [ui.sample, ui.file, ui.file2]) control.disabled = true;
}
void model.showStatus();
const whenIdle = (fn: () => void) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 4000 });
  else window.setTimeout(fn, 1500);
};
whenIdle(() => model.warmUp());
if (new URLSearchParams(location.search).get("sample")) void workspace.open(loadSample);
