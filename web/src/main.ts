/**
 * cropsize in the browser. Loads a scan, runs SAM 2.1 locally, measures the real size from
 * the PDF's own geometry, and writes a PDF at that size. No server, no upload.
 */
import { Sam } from "./lib/sam";
import { detect, type Box } from "./lib/detect";
import { loadFile, loadSample, type Scan } from "./lib/source";
import { estimateSkew, rotate } from "./lib/deskew";
import { applyTone } from "./lib/tone";
import {
  cropCanvas, exportPdf, measure, plan, trimToMask,
  type Fit, type Layout, type PresetName, type SheetName,
} from "./lib/sheet";
import { downloadBytes } from "./lib/constants";
import Split from "split.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>("canvas");
const ctx = cv.getContext("2d")!;
import type { Quality } from "./lib/constants";

// Which size to run. Measured against a true 125 by 176 mm passport spread, tiny and base
// plus are identical on an easy scan, and base plus is about 2 mm tighter on a passport
// inside a plastic sleeve, for twice the download and roughly twice the encode time. That is
// a real trade rather than an obvious win, so it is exposed rather than decided here.
let quality: Quality = "tiny";
let sam = new Sam(quality, "fp16");

const S: {
  scan: Scan | null;                 // the working frame, straightened, untoned
  toned: ImageData | null;           // the same frame with contrast applied, for output
  original: ImageData | null;        // before straightening, so the slider can redo it
  skew: number;
  mask: { mask: Float32Array; size: number } | null;
  box: Box;
  drag: null | { kind: "move" | "handle"; i: number; ox: number; oy: number };
} = {
  scan: null, toned: null, original: null, skew: 0, mask: null,
  box: { x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95 }, drag: null,
};

let currentFit: Fit = "true";

const layout = (): Layout => ({
  sheet: $<HTMLSelectElement>("sheet").value as SheetName,
  landscape: $<HTMLInputElement>("landscape").checked,
  fit: currentFit,
  preset: $<HTMLSelectElement>("preset").value as PresetName,
  marginMm: parseFloat($<HTMLInputElement>("margin").value) || 0,
  trim: $<HTMLInputElement>("trim").checked ? S.mask : null,
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

async function open(loader: () => Promise<Scan>) {
  $("drop").hidden = true;
  showProgress(true, "Reading the scan");
  try {
    const scan = await loader();
    S.original = scan.image;
    $("fileName").textContent = scan.name;

    // Straighten before anything else, the same order the Python build uses, so the crop box
    // and the measurement both refer to the upright frame.
    showProgress(true, "Measuring the tilt");
    S.skew = estimateSkew(scan.image);
    $<HTMLInputElement>("skew").value = String(S.skew);
    $("skewOut").textContent = S.skew.toFixed(1);
    S.scan = { ...scan, image: rotate(scan.image, S.skew) };
    S.mask = null;
    retone();
    $("app").hidden = false;
    $("start").hidden = true;
    initSplit();
    retone();
    draw();
    await runDetect();
  } catch (err) {
    // Inline rather than alert(): a modal blocks the page, which hides the actual failure
    // and stops any automated capture dead.
    showProgress(false);
    $("start").hidden = false;
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
      $("progressNote").textContent = p.status;
      setStatus(`Downloading, ${MB(p.loadedBytes)} of ${MB(total())}`);
    });
    if (first) $("progressLabel").textContent = "Looking for the document";
    S.mask = { mask: r.mask, size: r.maskSize };
    S.box = r.box;
    $("note").textContent =
      `Found it. ${r.note}${S.skew ? `, straightened by ${S.skew.toFixed(1)} degrees` : ""}.`;
  } catch (err) {
    $("note").textContent = `Could not find it, so drag the box yourself. ${(err as Error).message}`;
  }
  await reportModelState();
  showProgress(false);
  draw();
  refreshOutput();
}

/* ------------------------------------------------------------------- canvas */
const HANDLE = 9;

function draw() {
  if (!S.scan) return;
  const img = S.scan.image;
  const pane = cv.parentElement!;
  const maxW = Math.max(120, pane.clientWidth - 24);
  const maxH = Math.max(120, pane.clientHeight - 24);
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);

  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  ctx.drawImage(src, 0, 0, cv.width, cv.height);

  const r = boxPx();
  ctx.save();
  ctx.fillStyle = "rgba(10,12,16,.45)";
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "#2f6df6";
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  ctx.fillStyle = "#2f6df6";
  for (const [x, y] of corners()) ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
  ctx.restore();
}

const boxPx = () => ({
  x: S.box.x0 * cv.width, y: S.box.y0 * cv.height,
  w: (S.box.x1 - S.box.x0) * cv.width, h: (S.box.y1 - S.box.y0) * cv.height,
});
function corners(): [number, number][] {
  const r = boxPx();
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
}
function at(ev: PointerEvent) {
  const b = cv.getBoundingClientRect();
  const s = cv.width / b.width;
  return { x: (ev.clientX - b.left) * s, y: (ev.clientY - b.top) * s };
}

cv.addEventListener("pointerdown", ev => {
  const p = at(ev), cs = corners();
  const hit = cs.findIndex(([x, y]) =>
    Math.abs(x - p.x) < HANDLE * 1.6 && Math.abs(y - p.y) < HANDLE * 1.6);
  const r = boxPx();
  if (hit >= 0) S.drag = { kind: "handle", i: hit, ox: 0, oy: 0 };
  else if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h)
    S.drag = { kind: "move", i: -1, ox: p.x - r.x, oy: p.y - r.y };
  else return;
  cv.setPointerCapture(ev.pointerId);
});
cv.addEventListener("pointermove", ev => {
  if (!S.drag) return;
  const p = at(ev);
  const nx = Math.min(Math.max(p.x / cv.width, 0), 1);
  const ny = Math.min(Math.max(p.y / cv.height, 0), 1);
  const b = S.box;
  if (S.drag.kind === "move") {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const x0 = Math.min(Math.max((p.x - S.drag.ox) / cv.width, 0), 1 - w);
    const y0 = Math.min(Math.max((p.y - S.drag.oy) / cv.height, 0), 1 - h);
    S.box = { x0, y0, x1: x0 + w, y1: y0 + h };
  } else {
    if (S.drag.i === 0 || S.drag.i === 2) b.x0 = Math.min(nx, b.x1 - 0.02);
    if (S.drag.i === 1 || S.drag.i === 3) b.x1 = Math.max(nx, b.x0 + 0.02);
    if (S.drag.i === 0 || S.drag.i === 1) b.y0 = Math.min(ny, b.y1 - 0.02);
    if (S.drag.i === 2 || S.drag.i === 3) b.y1 = Math.max(ny, b.y0 + 0.02);
  }
  draw();
});
for (const e of ["pointerup", "pointercancel"] as const) {
  cv.addEventListener(e, () => { if (S.drag) { S.drag = null; refreshOutput(); } });
}
cv.addEventListener("dblclick", () => {
  S.box = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 };
  draw();
  refreshOutput();
});

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

const outputImage = () => S.toned ?? S.scan!.image;

/* ------------------------------------------------------------------- output */
let outTimer: number | undefined;
function refreshOutput() {
  clearTimeout(outTimer);
  outTimer = window.setTimeout(async () => {
    if (!S.scan) return;
    const L = layout();
    const p = plan(S.scan, S.box, L);
    const m = measure(S.scan.image, S.box, S.scan.mmPerPx);

    $("factScan").textContent = m ? `${m[0]} by ${m[1]} mm` : "scale unknown";
    $("factOut").textContent = `${p.contentMm[0]} by ${p.contentMm[1]} mm`;
    $("factSheet").textContent = p.sheetMm ? `${p.sheetMm[0]} by ${p.sheetMm[1]} mm` : "no sheet";
    $("scaleNote").textContent = `${p.note}. ${S.scan.origin}.`;
    $("sheetChip").textContent = p.sheetMm
      ? `${p.contentMm[0]} by ${p.contentMm[1]} mm on ${p.sheetMm[0]} by ${p.sheetMm[1]}`
      : `${p.contentMm[0]} by ${p.contentMm[1]} mm`;

    // Compose the sheet the same way the export does, so the preview cannot drift from it.
    let crop = cropCanvas(outputImage(), S.box);
    if (L.trim) crop = trimToMask(crop, S.box, L.trim.mask, L.trim.size);
    const dpi = 110;
    const sheetMm = p.sheetMm
      ?? [p.contentMm[0] + 2 * L.marginMm, p.contentMm[1] + 2 * L.marginMm];
    const sw = Math.round((sheetMm[0] / 25.4) * dpi);
    const sh = Math.round((sheetMm[1] / 25.4) * dpi);
    const sheet = new OffscreenCanvas(sw, sh);
    const sc = sheet.getContext("2d")!;
    sc.fillStyle = "#fff";
    sc.fillRect(0, 0, sw, sh);
    const cw = Math.round((p.contentMm[0] / 25.4) * dpi);
    const ch = Math.round((p.contentMm[1] / 25.4) * dpi);
    sc.drawImage(crop, (sw - cw) / 2, (sh - ch) / 2, cw, ch);
    const blob = await sheet.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const img = $<HTMLImageElement>("sheetImg");
    const old = img.src;
    img.src = URL.createObjectURL(blob);
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
  }, 120);
}

/* ------------------------------------------------------------------ controls */
for (const id of ["file", "file2"]) {
  $(id).addEventListener("change", e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) open(() => loadFile(f));
  });
}
$("startOver").addEventListener("click", () => location.reload());

$("model").addEventListener("change", async e => {
  quality = (e.target as HTMLSelectElement).value as Quality;
  sam = new Sam(quality, "fp16");          // a session is tied to its weights
  await reportModelState();
  if (S.scan) await runDetect();
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
for (const id of ["sheet", "margin", "landscape", "preset"]) {
  $(id).addEventListener("change", refreshOutput);
}

$("download").addEventListener("click", async () => {
  if (!S.scan) return;
  const btn = $<HTMLButtonElement>("download");
  btn.disabled = true;
  btn.textContent = "Writing the PDF";
  try {
    const blob = await exportPdf({ ...S.scan, image: outputImage() }, S.box, layout());
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
if (new URLSearchParams(location.search).get("sample")) {
  addEventListener("DOMContentLoaded", () => $("sample").click());
}
