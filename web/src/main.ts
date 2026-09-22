/**
 * cropsize in the browser. Loads a scan, runs SAM 2.1 locally, measures the real size from
 * the PDF's own geometry, and writes a PDF at that size. No server, no upload.
 */
import { Sam } from "./lib/sam";
import { detect } from "./lib/detect";
import {
  loadFile, loadSample, type DocumentSource,
} from "./lib/source";
import { estimateSkew } from "./lib/imaging-core";
import { applyTone } from "./lib/imaging-core";
import { rotate, quarterTurns } from "./lib/transform";
import {
  type Fit, type Layout, type OutputDpi, type PresetName, type SheetName,
} from "./lib/sheet";
import {
  findObjectGroups, measuredObject, mergeObjects, refineObject,
  type ObjectCandidate,
} from "./lib/objects";
import { downloadBytes } from "./lib/constants";
import { warmCache } from "./lib/model-loader";
import { turnBox, turnMask } from "./app-controls";
import { createOutputController } from "./app-output";
import { defaultBox, state as S, type PageState } from "./app-state";
import { createScanView } from "./app-view";
import Split from "split.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
import type { Quality } from "./lib/constants";

// Which size to run. Measured against a true 125 by 176 mm passport spread, tiny and base
// plus are identical on an easy scan, and base plus is about 2 mm tighter on a passport
// inside a plastic sleeve, for twice the download and roughly twice the encode time. That is
// a real trade rather than an obvious win, so it is exposed rather than decided here.
let quality: Quality = "base-plus";
let sam = new Sam(quality, "fp16");

let currentFit: Fit = "true";
const mergeSelection = new Set<number>();

const layout = (): Layout => ({
  sheet: $<HTMLSelectElement>("sheet").value as SheetName,
  landscape: $<HTMLInputElement>("landscape").checked,
  fit: currentFit,
  preset: $<HTMLSelectElement>("preset").value as PresetName,
  marginMm: parseFloat($<HTMLInputElement>("margin").value) || 0,
  outputDpi: ($<HTMLSelectElement>("resolution").value === "source"
    ? "source" : Number($<HTMLSelectElement>("resolution").value)) as OutputDpi,
});

/**
 * What the live crop is made of, so the sheet knows whether it already holds it. Anything
 * that changes the pixels or the printed size is in here; the sheet and margin are not,
 * because they change the page around the items rather than the items.
 */
const liveSignature = (): string => JSON.stringify([
  S.scan?.name, S.page, S.skew, S.selectedObjectId,
  [S.box.x0, S.box.y0, S.box.x1, S.box.y1].map(v => v.toFixed(4)),
  $<HTMLInputElement>("clahe").value, $<HTMLInputElement>("stretch").checked,
  $<HTMLInputElement>("trim").checked, currentFit, $<HTMLSelectElement>("preset").value,
]);

const output = createOutputController(
  S,
  layout,
  () => S.objects.length === 0 && $<HTMLInputElement>("trim").checked ? S.mask : null,
  liveSignature,
);
const refreshOutput = () => output.refresh();
const { draw } = createScanView(S, () => {
  refreshOutput();
  rememberPage();
});

/* -------------------------------------------------------------------- split */
let split: ReturnType<typeof Split> | null = null;

/** Split.js rather than a hand rolled drag: it handles the gutter, the sizing maths and the
 *  keyboard, and it is 2 kB. Redraw on drag because the canvas is sized in pixels. */
function initSplit() {
  if (split) return;
  split = Split(["#paneIn", "#paneOut"], {
    sizes: [50, 50], minSize: 260, gutterSize: 14, snapOffset: 0,
    onDrag: () => { draw(); },
  });
}

/* ------------------------------------------------------------------- status */
const MB = (n: number) => `${Math.round(n / 1048576)} MB`;
const total = () => downloadBytes(quality, "fp16");

/**
 * The badge used to claim the model was running before anything had been fetched. It now
 * reports one of four true states: not fetched, downloading with a live figure, cached and
 * ready, or in use with the backend that actually took the work.
 */
function setStatus(text: string, ready = false) {
  const b = $("engine");
  b.textContent = text;
  b.classList.toggle("on", ready);
}

async function reportModelState() {
  const label = `SAM 2.1 ${quality === "tiny" ? "tiny" : "base plus"}`;
  if (sam.loaded) {
    setStatus(`${label} ready on ${sam.backend === "webgpu" ? "WebGPU" : "WASM"}`, true);
    return;
  }
  const { have, of } = await sam.cached();
  if (have === of) setStatus(`${label} cached, ${MB(total())}, ready`, true);
  else if (have > 0) setStatus(`${label} partly cached, ${have} of ${of} files`);
  else setStatus(`${label} not downloaded yet, ${MB(total())} on first use`);
}

/* ------------------------------------------------------------------ loading */
function showProgress(on: boolean, label?: string) {
  $("progress").hidden = !on;
  if (label) $("progressLabel").textContent = label;
}

/**
 * The model runtime arrives from a CDN script tag. If it never executed — blocked
 * network, filtering proxy, an integrity mismatch — nothing downstream can work, so say
 * so now instead of failing mid-detection with a message about masks.
 */
if (typeof ort === "undefined") {
  setStatus("runtime failed to load — refresh, or check the network");
  for (const id of ["sample", "file", "file2"] as const) {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
    if (el) el.disabled = true;
  }
}

/* ------------------------------------------------------- background model warm-up */
let warmAbort: AbortController | undefined;

/** The weights can start moving while the user is still reading the page. When a scan is
 *  then dropped, detect() finds its four files cached and skips the download entirely. */
function warmModel() {
  if (typeof ort === "undefined") return;
  const controller = new AbortController();
  warmAbort = controller;
  warmCache(quality, "fp16", controller.signal,
    p => setStatus(`warming up — ${MB(p.loadedBytes)} of ${MB(p.totalBytes)} in background`))
    .catch(() => undefined)          // offline or blocked: detect() retries when needed
    .finally(() => { if (!controller.signal.aborted) void reportModelState(); });
}

const whenIdle = (fn: () => void): void => {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: 4000 });
  } else {
    window.setTimeout(fn, 1500);
  }
};

function rememberPage() {
  if (!S.scan || !S.original) return;
  const { image: _image, ...scan } = S.scan;
  S.pages.set(S.page, {
    scan,
    original: S.original,
    skew: S.skew,
    mask: S.mask ? { ...S.mask, box: { ...S.mask.box } } : null,
    box: { ...S.box },
    note: $("note").textContent ?? "",
    objects: S.objects,
    selectedObjectId: S.selectedObjectId,
  });
}

function showPage(state: PageState, index: number) {
  S.page = index;
  S.original = state.original;
  S.skew = state.skew;
  S.scan = { ...state.scan, image: rotate(state.original, state.skew) };
  S.mask = state.mask ? { ...state.mask, box: { ...state.mask.box } } : null;
  S.box = { ...state.box };
  S.objects = state.objects;
  S.selectedObjectId = state.selectedObjectId;
  S.drag = null;
  mergeSelection.clear();
  S.toned = null;
  $<HTMLSelectElement>("pageSelect").value = String(index);
  $<HTMLInputElement>("skew").value = String(S.skew);
  $("skewOut").textContent = S.skew.toFixed(1);
  $("fileName").textContent = state.scan.name;
  updateSourceResolutionLabel();
  $("note").textContent = state.note;
  renderObjects();
  retone();
  showProgress(false);
  draw();
  refreshOutput();
}

function showPageControls(source: DocumentSource) {
  const select = $<HTMLSelectElement>("pageSelect");
  select.replaceChildren();
  for (let i = 0; i < source.pageCount; i++) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = String(i + 1);
    select.append(option);
  }
  $("pageTotal").textContent = `of ${source.pageCount}`;
  $("pageNav").hidden = source.pageCount <= 1;
}

async function loadFreshPage(index: number) {
  if (!S.source) return;
  const source = S.source;
  showProgress(true, source.pageCount > 1
    ? `Reading page ${index + 1} of ${source.pageCount}` : "Reading the scan");
  const scan = await source.loadPage(index);
  S.page = index;
  S.original = scan.image;
  S.scan = null;
  S.toned = null;
  S.mask = null;
  S.objects = [];
  S.selectedObjectId = null;
  S.box = defaultBox();
  S.drag = null;
  mergeSelection.clear();
  $("fileName").textContent = scan.name;
  updateSourceResolutionLabel(scan);
  $<HTMLSelectElement>("pageSelect").value = String(index);
  $("note").textContent = "";
  renderObjects();

  // Straighten before anything else, the same order the Python build uses, so the crop box
  // and the measurement both refer to the upright frame.
  showProgress(true, "Measuring the tilt");
  S.skew = await estimateSkew(scan.image);
  $<HTMLInputElement>("skew").value = String(S.skew);
  $("skewOut").textContent = S.skew.toFixed(1);
  S.scan = { ...scan, image: rotate(scan.image, S.skew) };
  retone();
  draw();
  await runDetect();
  rememberPage();
}

async function selectPage(index: number) {
  if (!S.source || index === S.page) return;
  rememberPage();
  const saved = S.pages.get(index);
  if (saved) {
    showPage(saved, index);
    return;
  }
  await loadFreshPage(index);
}

async function open(loader: () => Promise<DocumentSource>) {
  warmAbort?.abort();                    // a real load outranks the background warm-up
  $("drop").hidden = true;
  $("dropError").hidden = true;
  showProgress(true, "Reading the scan");
  if (typeof ort === "undefined") {
    $("app").hidden = true;
    $("start").hidden = false;
    $("drop").hidden = false;
    $("dropError").textContent =
      "The model runtime did not load, so detection cannot run. Refresh the page.";
    $("dropError").hidden = false;
    showProgress(false);
    return;
  }
  try {
    const source = await loader();
    if (S.source) await S.source.close();
    S.source = source;
    S.pages.clear();
    S.page = 0;
    showPageControls(source);
    $("app").hidden = false;
    $("start").hidden = true;
    initSplit();
    await loadFreshPage(0);
  } catch (err) {
    // Inline rather than alert(): a modal blocks the page, which hides the actual failure
    // and stops any automated capture dead.
    showProgress(false);
    $("app").hidden = true;
    $("start").hidden = false;
    $("drop").hidden = false;
    $("dropError").textContent = `Could not open that. ${(err as Error).message}`;
    $("dropError").hidden = false;
  }
}

async function runDetect() {
  if (!S.scan) return;
  const first = !sam.loaded;
  showProgress(true, first ? "Getting the model ready" : "Looking for the document");
  try {
    const r = await detect(sam, S.scan.image, p => {
      $<HTMLElement>("fill").style.width = `${Math.round(p.fraction * 100)}%`;
      $("progressNote").textContent = p.totalBytes
        ? `${p.status}${Sam.threaded ? "" : "  ·  single threaded, so this is slower than it should be"}`
        : p.status;
      if (p.totalBytes) setStatus(`Downloading, ${MB(p.loadedBytes)} of ${MB(total())}`);
    });
    $("progressLabel").textContent = "Finding the document";
    $("progressNote").textContent = Sam.threaded
      ? "running the model" : "running the model on a single thread";
    if (first) $("progressLabel").textContent = "Looking for the document";
    S.box = { ...r.box };
    S.mask = { mask: r.mask, size: r.maskSize, box: { ...r.box } };
    $("note").textContent =
      `Found it. ${r.note}${S.skew ? `, straightened by ${S.skew.toFixed(1)} degrees` : ""}.`;
  } catch (err) {
    $("note").textContent = `Could not find it, so drag the box yourself. ${(err as Error).message}`;
  }
  await reportModelState();
  showProgress(false);
  draw();
  refreshOutput();
  rememberPage();
}

function renderObjects() {
  const panel = $("objPanel");
  const list = $("objList");
  panel.hidden = S.objects.length === 0;
  $<HTMLButtonElement>("findSeveral").textContent = S.objects.length
    ? "Back to one item" : "Find several items";
  $("objCount").textContent = S.objects.length ? `${S.objects.length} items` : "";
  const merge = $<HTMLButtonElement>("mergeObjects");
  merge.disabled = mergeSelection.size < 2;
  merge.title = merge.disabled ? "tick two or more items first" : "combine the ticked items";
  list.replaceChildren();
  if (!S.scan) return;
  S.objects.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = `objRow${item.id === S.selectedObjectId ? " on" : ""}`;
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = mergeSelection.has(item.id);
    tick.title = `Select item ${index + 1} for merging`;
    tick.addEventListener("click", event => {
      event.stopPropagation();
      if (tick.checked) mergeSelection.add(item.id);
      else mergeSelection.delete(item.id);
      renderObjects();
    });
    row.append(tick);
    const measured = measuredObject(item, S.scan!.image, S.scan!.mmPerPx);
    row.innerHTML = `<span class="objNum">${index + 1}</span>`
      + `<span class="objSize">${measured ? `${measured[0]} by ${measured[1]} mm` : "scale unknown"}</span>`
      + `<span class="objAngle">${item.angle.toFixed(1)}°</span>`;
    row.prepend(tick);
    row.addEventListener("click", () => {
      S.selectedObjectId = item.id;
      renderObjects();
      draw();
      refreshOutput();
      rememberPage();
    });
    const choices = item.choices ?? [];
    if (choices.length > 1) {
      const select = document.createElement("select");
      select.className = "objChoices";
      select.title = "Overlapping boundaries proposed for this item";
      choices.forEach((choice, choiceIndex) => {
        const option = document.createElement("option");
        option.value = String(choiceIndex);
        const size = measuredObject(choice, S.scan!.image, S.scan!.mmPerPx);
        option.textContent = `${choiceIndex + 1} of ${choices.length}: ${size
          ? `${size[0]} by ${size[1]} mm` : "scale unknown"}`;
        option.selected = choiceIndex === (item.choiceIndex ?? 0);
        select.append(option);
      });
      select.addEventListener("click", event => event.stopPropagation());
      select.addEventListener("change", async event => {
        event.stopPropagation();
        await chooseObjectCandidate(index, Number(select.value));
      });
      row.append(select);
    }
    if (item.mergedParts?.length) {
      const undo = document.createElement("button");
      undo.className = "objUndo";
      undo.textContent = `Undo merge (${item.mergedParts.length})`;
      undo.addEventListener("click", event => {
        event.stopPropagation();
        undoObjectMerge(index);
      });
      row.append(undo);
    }
    const remove = document.createElement("button");
    remove.className = "objDel";
    remove.type = "button";
    remove.title = `Remove item ${index + 1}`;
    remove.textContent = "×";
    remove.addEventListener("click", event => {
      event.stopPropagation();
      S.objects = S.objects.filter(candidate => candidate.id !== item.id);
      mergeSelection.delete(item.id);
      if (S.selectedObjectId === item.id) S.selectedObjectId = S.objects[0]?.id ?? null;
      renderObjects();
      draw();
      refreshOutput();
      rememberPage();
    });
    row.append(remove);
    list.append(row);
  });
}

async function chooseObjectCandidate(objectIndex: number, choiceIndex: number) {
  if (!S.scan) return;
  const current = S.objects[objectIndex];
  const choices = current?.choices;
  const choice = choices?.[choiceIndex];
  if (!current || !choices || !choice) return;
  const refined = await refineObject(S.scan.image, choice);
  const stable: ObjectCandidate = {
    ...refined,
    id: current.id,
    choices,
    choiceIndex,
    alternatives: choices.filter((_, index) => index !== choiceIndex),
  };
  choices[choiceIndex] = {
    ...refined, alternatives: [], choices: undefined, choiceIndex: undefined,
  };
  S.objects[objectIndex] = stable;
  S.selectedObjectId = stable.id;
  renderObjects();
  draw();
  refreshOutput();
  rememberPage();
}

async function mergeCheckedObjects() {
  if (!S.scan || mergeSelection.size < 2) return;
  const picked = S.objects.filter(item => mergeSelection.has(item.id));
  if (picked.length < 2) return;
  const firstIndex = Math.min(...picked.map(item => S.objects.indexOf(item)));
  const merged = await mergeObjects(S.scan.image, picked);
  S.objects = S.objects.filter(item => !mergeSelection.has(item.id));
  S.objects.splice(firstIndex, 0, merged);
  mergeSelection.clear();
  S.selectedObjectId = merged.id;
  renderObjects();
  draw();
  refreshOutput();
  rememberPage();
}

function undoObjectMerge(index: number) {
  const merged = S.objects[index];
  if (!merged?.mergedParts?.length) return;
  const parts = merged.mergedParts;
  S.objects.splice(index, 1, ...parts);
  mergeSelection.clear();
  S.selectedObjectId = parts[0]?.id ?? null;
  renderObjects();
  draw();
  refreshOutput();
  rememberPage();
}

async function toggleSeveralItems() {
  if (!S.scan) return;
  if (S.objects.length) {
    S.objects = [];
    mergeSelection.clear();
    S.selectedObjectId = null;
    renderObjects();
    draw();
    refreshOutput();
    rememberPage();
    return;
  }
  showProgress(true, "Finding every item");
  try {
    const groups = await findObjectGroups(sam, S.scan.image, progress => {
      $<HTMLElement>("fill").style.width = `${Math.round(progress.fraction * 100)}%`;
      $("progressNote").textContent = progress.status;
    });
    S.objects = groups.map(group => group[0]!).filter(Boolean);
    mergeSelection.clear();
    S.selectedObjectId = S.objects[0]?.id ?? null;
    $("note").textContent = S.objects.length
      ? `Found ${S.objects.length} item${S.objects.length === 1 ? "" : "s"}; each keeps its own angle.`
      : "No separate document-shaped items were found. The single-item crop is unchanged.";
    renderObjects();
    draw();
    refreshOutput();
    rememberPage();
  } catch (error) {
    $("note").textContent = `Could not find several items. ${(error as Error).message}`;
  } finally {
    showProgress(false);
  }
}

/* -------------------------------------------------------------------- sheet tray */
function renderTray() {
  const panel = $("trayPanel");
  const list = $("trayList");
  panel.hidden = S.tray.length === 0;
  $("trayCount").textContent = S.tray.length
    ? `${S.tray.length} on the sheet` : "";
  list.replaceChildren();
  S.tray.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = "objRow trayRow";
    const measured = item.mmPerPx
      ? [item.image.width * item.mmPerPx, item.image.height * item.mmPerPx]
        .map(v => Math.round(v * 10) / 10) : null;
    row.innerHTML = `<span class="objNum">${index + 1}</span>`
      + `<span class="objLabel"></span>`
      + `<span class="objSize">${measured ? `${measured[0]} by ${measured[1]} mm` : "scale unknown"}</span>`;
    const label = row.querySelector<HTMLElement>(".objLabel")!;
    label.textContent = item.label;
    label.title = item.label;
    const remove = document.createElement("button");
    remove.className = "objDel";
    remove.type = "button";
    remove.title = `Take item ${index + 1} off the sheet`;
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      S.tray = S.tray.filter(candidate => candidate.id !== item.id);
      renderTray();
      refreshOutput();
    });
    row.append(remove);
    list.append(row);
  });
}

$("addToSheet").addEventListener("click", async () => {
  const added = await output.addLiveToSheet();
  if (!added) return;
  renderTray();
  $("note").textContent = S.tray.length === 1
    ? "Pinned on the sheet. Now open the other side; its crop will join this one on the page."
    : `Pinned. ${S.tray.length} items on the sheet.`;
});
$("clearTray").addEventListener("click", () => {
  S.tray = [];
  renderTray();
  refreshOutput();
});

function updateSourceResolutionLabel(scan = S.scan) {
  const option = $<HTMLSelectElement>("resolution")
    .querySelector<HTMLOptionElement>('option[value="source"]');
  if (!option) return;
  option.textContent = scan?.mmPerPx
    ? `Match source pixels (${Math.round(scan.dpi)} dpi)`
    : "Match source pixels";
}

/**
 * Contrast is applied to the whole straightened frame, not to the crop, so the percentiles
 * behind the white point are taken from the whole page. That matches the Python build, and it
 * stops the tone shifting every time you nudge the crop box.
 */
function retone() {
  if (!S.scan) return;
  const clip = parseFloat($<HTMLInputElement>("clahe").value) || 0;
  const stretch = $<HTMLInputElement>("stretch").checked;
  S.toned = (clip > 0 || stretch) ? applyTone(S.scan.image, clip, stretch) : null;
}


/* ------------------------------------------------------------------ controls */
for (const id of ["file", "file2"]) {
  $(id).addEventListener("change", e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) open(() => loadFile(f));
  });
}

$("pageSelect").addEventListener("change", async event => {
  const select = event.target as HTMLSelectElement;
  const next = Number(select.value);
  if (!Number.isInteger(next)) return;
  select.disabled = true;
  try {
    await selectPage(next);
  } catch (err) {
    showProgress(false);
    select.value = String(S.page);
    $("note").textContent = `Could not open that page. ${(err as Error).message}`;
  } finally {
    select.disabled = false;
  }
});
$("startOver").addEventListener("click", () => location.reload());

/**
 * Quarter turns.
 *
 * Nothing is recomputed. Rotating used to re-measure the tilt and re-run the model, which
 * meant sitting through an encode for an operation that changes no information at all. A
 * quarter turn is exact: the crop box, the mask and the tilt all rotate with the frame, so
 * they are transformed rather than rediscovered, and the turn is instant.
 */
function turn(quarters: number) {
  if (!S.scan || !S.original) return;
  const k = ((quarters % 4) + 4) % 4;
  if (S.objects.length) {
    S.objects = [];
    mergeSelection.clear();
    S.selectedObjectId = null;
    renderObjects();
  }
  S.original = quarterTurns(S.original, k);
  // The tilt relative to the axes is unchanged by a quarter turn, so it carries over as is.
  S.scan = { ...S.scan, image: rotate(S.original, S.skew) };
  S.box = turnBox(S.box, k);
  if (S.mask) {
    S.mask = {
      mask: turnMask(S.mask.mask, S.mask.size, k),
      size: S.mask.size,
      box: turnBox(S.mask.box, k),
    };
  }
  retone();
  draw();
  refreshOutput();
}
$("rotL").addEventListener("click", () => turn(3));
$("rotR").addEventListener("click", () => turn(1));
$("rot180").addEventListener("click", () => turn(2));

$("model").addEventListener("change", async e => {
  quality = (e.target as HTMLSelectElement).value as Quality;
  const stale = sam;
  sam = new Sam(quality, "fp16");          // a session is tied to its weights
  void stale.release();                    // free the old native sessions now, not at GC
  S.objects = [];
  mergeSelection.clear();
  S.selectedObjectId = null;
  renderObjects();
  await reportModelState();
  if (S.scan) await runDetect();
  else whenIdle(warmModel);              // start fetching the freshly chosen weights too
});

// Redo the straightening by hand. Detection ran against the old angle, so say so rather
// than leaving a stale box looking authoritative.
let skewTimer: number | undefined;
$("skew").addEventListener("input", e => {
  S.skew = parseFloat((e.target as HTMLInputElement).value);
  $("skewOut").textContent = S.skew.toFixed(1);
  clearTimeout(skewTimer);
  skewTimer = window.setTimeout(() => {
    if (!S.scan || !S.original) return;
    S.scan = { ...S.scan, image: rotate(S.original, S.skew) };
    S.mask = null;
    S.objects = [];
    mergeSelection.clear();
    S.selectedObjectId = null;
    renderObjects();
    retone();
    $("note").textContent = "Straightened by hand. Detect again to refit the box.";
    draw();
    refreshOutput();
  }, 200);
});
$("trim").addEventListener("change", refreshOutput);

let toneTimer: number | undefined;
for (const id of ["clahe", "stretch"]) {
  $(id).addEventListener("input", () => {
    const v = parseFloat($<HTMLInputElement>("clahe").value);
    $("claheOut").textContent = v > 0 ? v.toFixed(1) : "off";
    clearTimeout(toneTimer);
    toneTimer = window.setTimeout(() => { retone(); refreshOutput(); }, 200);
  });
}
$("sample").addEventListener("click", () => open(loadSample));
$("redetect").addEventListener("click", runDetect);
$("findSeveral").addEventListener("click", toggleSeveralItems);
$("mergeObjects").addEventListener("click", mergeCheckedObjects);

const drop = $("drop");
for (const e of ["dragenter", "dragover"] as const) {
  drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add("over"); });
}
for (const e of ["dragleave", "drop"] as const) {
  drop.addEventListener(e, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", ev => {
  ev.preventDefault();
  const f = ev.dataTransfer?.files[0];
  if (f) open(() => loadFile(f));
});

document.querySelectorAll<HTMLButtonElement>(".segBtn").forEach(btn =>
  btn.addEventListener("click", () => {
    currentFit = (btn.dataset.fit ?? "true") as Fit;
    document.querySelectorAll<HTMLButtonElement>(".segBtn").forEach(b =>
      b.setAttribute("aria-pressed", String(b === btn)));
    $("preset").hidden = currentFit !== "preset";
    refreshOutput();
  }));
for (const id of ["sheet", "margin", "landscape", "preset", "resolution"]) {
  $(id).addEventListener("change", refreshOutput);
}

$("download").addEventListener("click", async () => {
  if (!S.scan) return;
  const btn = $<HTMLButtonElement>("download");
  btn.disabled = true;
  btn.textContent = S.tray.length
    ? "Writing the sheet"
    : S.objects.length > 1 ? `Writing ${S.objects.length} pages` : "Writing the PDF";
  try {
    const blob = await output.download();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cropsize.pdf";
    a.click();
    URL.revokeObjectURL(a.href);
  } finally {
    btn.disabled = false;
    btn.textContent = "Download the PDF";
  }
});

let resizeTimer: number | undefined;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(draw, 120);
});

void reportModelState();
whenIdle(warmModel);
if (new URLSearchParams(location.search).get("sample")) {
  addEventListener("DOMContentLoaded", () => $("sample").click());
}
