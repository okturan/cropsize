/* scanfit editor — crop box lives in normalised coords against the transformed frame */
const $ = (id) => document.getElementById(id);
const S = {
  doc: null, page: 0, pages: [],
  rot: 0, skew: 0,
  box: { x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95 },
  img: new Image(),
  drag: null, zoom: 1, tool: "crop",
  objects: [], sel: -1, checked: new Set(), mode: "single",
};
const HANDLE = 9;            // px, in canvas space
const cv = $("canvas"), ctx = cv.getContext("2d");

/* ---------------------------------------------------------------- upload */
const drop = $("drop");
["dragenter", "dragover"].forEach(e => drop.addEventListener(e, ev => {
  ev.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach(e => drop.addEventListener(e, () => drop.classList.remove("over")));
drop.addEventListener("drop", ev => { ev.preventDefault(); if (ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0]); });
$("file").addEventListener("change", ev => ev.target.files[0] && upload(ev.target.files[0]));

async function upload(file) {
  busy(true);
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/upload", { method: "POST", body: fd });
  if (!r.ok) { busy(false); return alert((await r.json()).detail || "upload failed"); }
  const d = await r.json();
  S.doc = d.doc_id; S.pages = d.pages; S.page = 0; S.rot = 0; S.skew = 0;
  S.objects = []; S.sel = -1; S.checked.clear(); S.mode = "single"; renderObjects();
  $("drop").hidden = true; $("editor").hidden = false;
  $("panel").hidden = false; $("outPanel").hidden = false;
  document.body.classList.add("loaded");
  const pg = d.pages[0];
  const badge = $("srcBadge");
  badge.hidden = false;
  badge.textContent = pg.source_dpi
    ? `${d.pages.length > 1 ? d.pages.length + " pages · " : ""}${Math.round(pg.source_dpi)} dpi scan`
    : `${pg.w}×${pg.h} px · no dpi recorded`;
  badge.title = pg.scale_origin || "";
  buildStrip();
  S.zoom = 1; $("zoomLevel").textContent = "fit";
  await refresh();
  await detect();                       // first pass is automatic; user can redo or adjust
  busy(false);
}

function buildStrip() {
  const strip = $("pageStrip");
  strip.innerHTML = "";
  if (S.pages.length < 2) return;
  S.pages.forEach((p, i) => {
    const b = document.createElement("button");
    b.textContent = `Page ${i + 1}`;
    b.setAttribute("aria-pressed", String(i === S.page));
    b.onclick = async () => { S.page = i; buildStrip(); await refresh(); await detect(); };
    strip.appendChild(b);
  });
}

/* -------------------------------------------------------------- preview */
function previewURL() {
  const q = new URLSearchParams({
    rot: S.rot, skew: S.skew.toFixed(2),
    clahe: $("clahe").value, stretch: $("stretch").checked ? 1 : 0,
  });
  return `/api/preview/${S.doc}/${S.page}?${q}`;
}

function refresh() {
  return new Promise(res => {
    S.img.onload = () => { draw(); measure(); res(); };
    S.img.src = previewURL();
  });
}

/* Zoom is applied to the canvas backing store, not CSS, so pixels stay sharp when you
   zoom in to place an edge. Crop coords are normalised, so they survive any zoom. */
function fitScale() {
  const wrap = $("canvasWrap");
  const maxW = wrap.clientWidth - 24;
  const maxH = Math.max(240, window.innerHeight * 0.76 - 40);
  return Math.min(maxW / S.img.width, maxH / S.img.height, 1);
}

function setZoom(z, label) {
  S.zoom = Math.min(Math.max(z, 0.15), 6);
  $("zoomLevel").textContent = label || Math.round(S.zoom * fitScale() * 100) + "%";
  draw();
}

function draw() {
  if (!S.img.width) return;
  const scale = fitScale() * (S.zoom || 1);
  cv.width = Math.round(S.img.width * scale);
  cv.height = Math.round(S.img.height * scale);
  ctx.drawImage(S.img, 0, 0, cv.width, cv.height);

  if (S.mode === "objects") { drawObjects(); return; }   // the crop box is not in play

  const r = boxPx();
  ctx.save();
  ctx.fillStyle = "rgba(10,12,16,.45)";
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill("evenodd");

  ctx.strokeStyle = "#2f6df6"; ctx.lineWidth = 2;
  ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {                      // thirds guides
    ctx.beginPath();
    ctx.moveTo(r.x + r.w * i / 3, r.y); ctx.lineTo(r.x + r.w * i / 3, r.y + r.h);
    ctx.moveTo(r.x, r.y + r.h * i / 3); ctx.lineTo(r.x + r.w, r.y + r.h * i / 3);
    ctx.stroke();
  }
  ctx.fillStyle = "#2f6df6";
  corners().forEach(([cx, cy]) => ctx.fillRect(cx - HANDLE / 2, cy - HANDLE / 2, HANDLE, HANDLE));
  ctx.restore();
}

function drawObjects() {
  S.objects.forEach((o, i) => {
    const pts = o.poly.map(([x, y]) => [x * cv.width, y * cv.height]);
    ctx.save();
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    const on = i === S.sel;
    ctx.fillStyle = on ? "rgba(47,109,246,.18)" : "rgba(47,109,246,.08)";
    ctx.fill();
    ctx.strokeStyle = on ? "#2f6df6" : "rgba(47,109,246,.75)";
    ctx.lineWidth = on ? 3 : 2;
    ctx.stroke();

    const cx = o.cx * cv.width, cy = o.cy * cv.height;
    ctx.fillStyle = "#2f6df6";
    ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "600 16px ui-sans-serif, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), cx, cy);
    ctx.restore();
  });
}

const boxPx = () => ({
  x: S.box.x0 * cv.width, y: S.box.y0 * cv.height,
  w: (S.box.x1 - S.box.x0) * cv.width, h: (S.box.y1 - S.box.y0) * cv.height,
});
function corners() {
  const r = boxPx();
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
          [r.x + r.w / 2, r.y], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2]];
}

/* ------------------------------------------------------------ crop drag */
function pos(ev) {
  const b = cv.getBoundingClientRect();
  const s = cv.width / b.width;
  return { x: (ev.clientX - b.left) * s, y: (ev.clientY - b.top) * s };
}
function objectAtPoint(nx, ny) {
  // Bounding-circle test on the rect's half-diagonal is close enough for hit-testing.
  return S.objects.findIndex(o =>
    Math.abs(nx - o.cx) < o.w / 2 * 1.05 && Math.abs(ny - o.cy) < o.h / 2 * 1.05);
}

cv.addEventListener("pointerdown", ev => {
  if (spaceDown || ev.button === 1 || S.tool === "pan") return;   // panning, not cropping
  if (S.tool === "select") { selectClick(ev); return; }
  const p = pos(ev), cs = corners();
  const hit = cs.findIndex(([x, y]) => Math.abs(x - p.x) < HANDLE * 1.4 && Math.abs(y - p.y) < HANDLE * 1.4);
  const r = boxPx();
  const inside = p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  if (hit >= 0) S.drag = { kind: "handle", i: hit };
  else if (inside) S.drag = { kind: "move", ox: p.x - r.x, oy: p.y - r.y };
  else return;
  cv.setPointerCapture(ev.pointerId);
});
cv.addEventListener("pointermove", ev => {
  if (!S.drag) return;
  const p = pos(ev);
  const nx = Math.min(Math.max(p.x / cv.width, 0), 1), ny = Math.min(Math.max(p.y / cv.height, 0), 1);
  const b = S.box;
  if (S.drag.kind === "move") {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    let x0 = (p.x - S.drag.ox) / cv.width, y0 = (p.y - S.drag.oy) / cv.height;
    x0 = Math.min(Math.max(x0, 0), 1 - w); y0 = Math.min(Math.max(y0, 0), 1 - h);
    S.box = { x0, y0, x1: x0 + w, y1: y0 + h };
  } else {
    const i = S.drag.i;
    if ([0, 2, 6].includes(i)) b.x0 = Math.min(nx, b.x1 - 0.02);
    if ([1, 3, 7].includes(i)) b.x1 = Math.max(nx, b.x0 + 0.02);
    if ([0, 1, 4].includes(i)) b.y0 = Math.min(ny, b.y1 - 0.02);
    if ([2, 3, 5].includes(i)) b.y1 = Math.max(ny, b.y0 + 0.02);
  }
  draw();
});
["pointerup", "pointercancel"].forEach(e => cv.addEventListener(e, () => {
  if (S.drag) { S.drag = null; measure(); }
}));
cv.addEventListener("dblclick", () => { S.box = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 }; draw(); measure(); });

/* ----------------------------------------------------------------- zoom */
$("zoomIn").onclick = () => setZoom(S.zoom * 1.35);
$("zoomOut").onclick = () => setZoom(S.zoom / 1.35);
$("zoomFit").onclick = () => setZoom(1, "fit");
$("zoom100").onclick = () => setZoom(1 / fitScale(), "100%");

$("canvasWrap").addEventListener("wheel", ev => {
  if (!(ev.ctrlKey || ev.metaKey)) return;         // plain scroll still pans
  ev.preventDefault();
  const wrap = $("canvasWrap"), r = wrap.getBoundingClientRect();
  const fx = (wrap.scrollLeft + ev.clientX - r.left) / Math.max(cv.width, 1);
  const fy = (wrap.scrollTop + ev.clientY - r.top) / Math.max(cv.height, 1);
  setZoom(S.zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12));
  wrap.scrollLeft = fx * cv.width - (ev.clientX - r.left);   // keep cursor anchored
  wrap.scrollTop = fy * cv.height - (ev.clientY - r.top);
}, { passive: false });

/* -------------------------------------------------------------- objects */
async function selectClick(ev) {
  const p = pos(ev);
  const nx = p.x / cv.width, ny = p.y / cv.height;
  const hit = objectAtPoint(nx, ny);

  // ⌥-click inside an object carves that region back out of it — the direct fix for a
  // document sitting in a coloured holder that the mask keeps swallowing.
  if (ev.altKey && hit >= 0) {
    const o = S.objects[hit];
    await requestObject([[o.cx, o.cy, 1], [nx, ny, 0]], hit);
    return;
  }
  if (hit >= 0 && !ev.altKey) { S.sel = hit; draw(); renderObjects(); return; }
  await requestObject([[nx, ny, 1]], -1);
}

async function requestObject(points, replaceIdx) {
  busy(true);
  const r = await fetch("/api/object_at", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_id: S.doc, page: S.page, rot: S.rot, points }),
  });
  busy(false);
  if (!r.ok) { $("detectNote").textContent = (await r.json()).detail || "no object there"; return; }
  const o = await r.json();
  if (replaceIdx >= 0) S.objects[replaceIdx] = o;
  else { S.objects.push(o); S.sel = S.objects.length - 1; }
  draw(); renderObjects(); measure();
}

$("findObjects").onclick = async () => {
  busy(true);
  $("detectNote").textContent = "finding objects…";
  const r = await fetch("/api/objects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_id: S.doc, page: S.page, rot: S.rot, engine: $("engine").value }),
  });
  busy(false);
  const d = await r.json();
  if (!r.ok) { $("detectNote").textContent = d.detail || "failed"; return; }
  S.objects = d.objects || []; S.sel = -1;
  $("detectNote").textContent = S.objects.length
    ? `${d.engine} found ${S.objects.length} object${S.objects.length > 1 ? "s" : ""}`
    : `${d.engine} found nothing document-shaped — try the Select tool`;
  S.checked.clear();
  setMode("objects");
};

$("clearObjects").onclick = () => {
  S.objects = []; S.sel = -1; S.checked.clear(); draw(); renderObjects(); measure();
};

function renderObjects() {
  const list = $("objList"), n = S.objects.length;
  $("objGroup").hidden = S.mode !== "objects" || !n;
  $("objCount").textContent = n ? `${n}` : "";
  $("modeCount").textContent = n ? `(${n})` : "";
  const pages = S.mode === "objects" ? n : 1;
  $("exportPdf").textContent = pages > 1 ? `Download PDF · ${pages} pages` : "Download PDF";
  $("mergeObjects").disabled = S.checked.size < 2;

  list.innerHTML = "";
  S.objects.forEach((o, i) => {
    const li = document.createElement("li");
    li.className = "objRow" + (i === S.sel ? " on" : "");

    const tick = document.createElement("input");
    tick.type = "checkbox"; tick.checked = S.checked.has(i);
    tick.onclick = (e) => {
      e.stopPropagation();
      tick.checked ? S.checked.add(i) : S.checked.delete(i);
      $("mergeObjects").disabled = S.checked.size < 2;
    };
    li.appendChild(tick);

    const size = o.mm ? `${o.mm[0]} × ${o.mm[1]} mm` : `${Math.round(o.w * 100)}%×${Math.round(o.h * 100)}%`;
    li.insertAdjacentHTML("beforeend",
      `<span class="objNum">${i + 1}</span><span class="objSize">${size}</span>` +
      `<span class="objAngle">${o.angle > 0 ? "+" : ""}${o.angle.toFixed(1)}°</span>`);

    const alt = document.createElement("button");
    alt.className = "objAlt"; alt.textContent = "⇄";
    alt.title = `${(o.alts || []).length} alternative boundaries SAM proposed`;
    alt.hidden = !(o.alts || []).length;
    alt.onclick = (e) => { e.stopPropagation(); cycleAlt(i); };
    li.appendChild(alt);

    const del = document.createElement("button");
    del.className = "objDel"; del.textContent = "×"; del.title = "remove";
    del.onclick = (e) => {
      e.stopPropagation();
      S.objects.splice(i, 1); S.sel = -1; S.checked.clear();
      draw(); renderObjects(); measure();
    };
    li.appendChild(del);
    li.onclick = () => { S.sel = i; draw(); renderObjects(); };
    list.appendChild(li);
  });
}

/* Swap an item for the next overlapping candidate. SAM offers a passport's sleeve, each
   of its pages, and sometimes their union — which one is "the document" is a judgement
   call, so it is offered rather than guessed. */
function cycleAlt(i) {
  const o = S.objects[i];
  const alts = o.alts || [];
  if (!alts.length) return;
  const next = { ...alts[0] };
  next.alts = [...alts.slice(1), { ...o, alts: [] }];
  S.objects[i] = next; S.sel = i;
  draw(); renderObjects(); measure();
}

$("mergeObjects").onclick = async () => {
  const picked = [...S.checked].sort((a, b) => a - b).map(i => S.objects[i]);
  if (picked.length < 2) return;
  busy(true);
  const r = await fetch("/api/merge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      doc_id: S.doc, page: S.page, rot: S.rot,
      rects: picked.map(o => ({ cx: o.cx, cy: o.cy, w: o.w, h: o.h, angle: o.angle })),
    }),
  });
  busy(false);
  if (!r.ok) { $("detectNote").textContent = "merge failed"; return; }
  const merged = await r.json();
  merged.alts = picked.map(p => ({ ...p, alts: [] }));      // undo path: cycle back
  S.objects = S.objects.filter((_, i) => !S.checked.has(i));
  S.objects.push(merged);
  S.checked.clear(); S.sel = S.objects.length - 1;
  draw(); renderObjects(); measure();
};

/* ----------------------------------------------------------------- mode */
function setMode(mode, opts = {}) {
  S.mode = mode;
  $("modeSingle").setAttribute("aria-pressed", String(mode === "single"));
  $("modeObjects").setAttribute("aria-pressed", String(mode === "objects"));
  $("singleActions").hidden = mode !== "single";
  $("objectActions").hidden = mode !== "objects";
  $("objGroup").hidden = mode !== "objects" || !S.objects.length;
  $("straightenGroup").classList.toggle("off", mode === "objects");

  // Objects carry their own angle and export ignores the global one. Leaving a non-zero
  // skew would rotate the preview image while the object outlines stayed put, so the
  // overlay would drift away from what export actually produces.
  if (mode === "objects" && S.skew !== 0) {
    S.skew = 0; $("skew").value = 0; $("skewOut").textContent = "0.0°";
    refresh();
  } else if (!opts.quiet) { draw(); }
  setTool(mode === "objects" ? "select" : "crop");
  renderObjects();
  measure();
}
$("modeSingle").onclick = () => setMode("single");
$("modeObjects").onclick = () => setMode("objects");

/* ---------------------------------------------------------------- tools */
const HINTS = {
  crop: "Drag the box to move it · drag a handle to resize · double-click to reset",
  select: "Click an item to add it · ⌥-click inside one to exclude a region · click a row to highlight",
  pan: "Drag to move the view · ⌘/Ctrl + scroll to zoom",
};

function setTool(tool) {
  S.tool = tool;
  $("hint").textContent = HINTS[tool] + " · space or middle-drag pans anywhere";
  for (const [id, name] of [["toolCrop", "crop"], ["toolSelect", "select"], ["toolPan", "pan"]])
    $(id).setAttribute("aria-pressed", String(tool === name));
  $("canvasWrap").classList.toggle("tool-pan", tool === "pan");
  $("canvasWrap").classList.toggle("tool-select", tool === "select");
}
$("toolCrop").onclick = () => setTool("crop");
$("toolSelect").onclick = () => setTool("select");
$("toolPan").onclick = () => setTool("pan");

let spaceDown = false, pan = null;
const typing = (t) => ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);
addEventListener("keydown", e => {
  if (typing(e.target)) return;
  if (e.code === "Space" && !e.repeat) {
    spaceDown = true; $("canvasWrap").classList.add("panning"); e.preventDefault();
  }
  if (e.key === "h" || e.key === "H") setTool("pan");
  if (e.key === "s" || e.key === "S") setTool("select");
  if (e.key === "c" || e.key === "C") setTool("crop");
});
addEventListener("keyup", e => {
  if (e.code === "Space") { spaceDown = false; $("canvasWrap").classList.remove("panning"); }
});
$("canvasWrap").addEventListener("pointerdown", ev => {
  if (!(spaceDown || ev.button === 1 || S.tool === "pan")) return;
  const wrap = $("canvasWrap");
  wrap.classList.add("panning");
  pan = { x: ev.clientX, y: ev.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
  ev.preventDefault();
});
addEventListener("pointermove", ev => {
  if (!pan) return;
  const wrap = $("canvasWrap");
  wrap.scrollLeft = pan.l - (ev.clientX - pan.x);
  wrap.scrollTop = pan.t - (ev.clientY - pan.y);
});
addEventListener("pointerup", () => {
  if (pan && !spaceDown) $("canvasWrap").classList.remove("panning");
  pan = null;
});

/* --------------------------------------------------------------- detect */
async function detect() {
  busy(true);
  $("detectNote").textContent = "detecting…";
  const r = await fetch("/api/detect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      doc_id: S.doc, page: S.page, rot: S.rot,
      engine: $("engine").value, deskew: $("autoDeskew").checked,
    }),
  });
  const d = await r.json();
  if (!r.ok) { busy(false); $("detectNote").textContent = d.detail || "detect failed"; return; }
  S.box = { x0: d.box[0], y0: d.box[1], x1: d.box[2], y1: d.box[3] };
  S.outline = d.outline || null;
  S.skew = d.skew || 0;
  if (S.mode !== "single") setMode("single", { quiet: true });
  $("skew").value = S.skew; $("skewOut").textContent = S.skew.toFixed(1) + "°";
  $("detectNote").textContent =
    `${d.engine}${d.note ? " — " + d.note : ""}${d.skew ? `, skew ${d.skew.toFixed(2)}°` : ", no skew"}`;
  await refresh();
  busy(false);
}
$("detect").onclick = detect;

/* -------------------------------------------------------------- controls */
$("rotL").onclick = async () => { S.rot = (S.rot + 3) % 4; await refresh(); };
$("rotR").onclick = async () => { S.rot = (S.rot + 1) % 4; await refresh(); };
$("rot180").onclick = async () => { S.rot = (S.rot + 2) % 4; await refresh(); };

let skewTimer;
$("skew").oninput = (e) => {
  S.skew = parseFloat(e.target.value);
  $("skewOut").textContent = S.skew.toFixed(1) + "°";
  clearTimeout(skewTimer); skewTimer = setTimeout(refresh, 180);
};
let toneTimer;
$("clahe").oninput = (e) => {
  const v = parseFloat(e.target.value);
  $("claheOut").textContent = v > 0 ? v.toFixed(1) : "off";
  clearTimeout(toneTimer); toneTimer = setTimeout(refresh, 180);
};
$("stretch").onchange = refresh;

$("preset").onchange = (e) => {
  const v = e.target.value;
  if (v !== "custom") $("targetW").value = parseFloat(v.split("x")[0]);
  measure();
};
document.querySelectorAll('input[name="fit"]').forEach(el =>
  el.addEventListener("change", () => {
    $("presetBox").hidden = fitMode() !== "real";
    measure();
  }));
["pageSize", "landscape", "targetW", "margin", "outDpi", "trimOutline"].forEach(id =>
  $(id).addEventListener("change", measure));
$("reset").onclick = () => location.reload();

/* -------------------------------------------------------- measure/export */
function exportBody(format) {
  const pages = (S.mode === "objects" && S.objects.length)
    ? S.objects.map(o => ({
        page: S.page, rot: S.rot, outline: o.outline || null,
        rect: { cx: o.cx, cy: o.cy, w: o.w, h: o.h, angle: o.angle },
      }))
    : [{ page: S.page, box: [S.box.x0, S.box.y0, S.box.x1, S.box.y1],
         rot: S.rot, skew: S.skew, outline: S.outline || null }];
  return {
    doc_id: S.doc,
    pages,
    format,
    page_size: $("pageSize").value,
    landscape: $("landscape").checked,
    fit: fitMode(),
    target_width_mm: parseFloat($("targetW").value) || null,
    target_height_mm: presetHeight(),
    margin_mm: parseFloat($("margin").value) || 0,
    clahe: parseFloat($("clahe").value),
    stretch: $("stretch").checked,
    out_dpi: parseFloat($("outDpi").value) || null,
    trim_outline: $("trimOutline").checked,
  };
}

const fitMode = () => document.querySelector('input[name="fit"]:checked').value;

// A preset is a box, not just a width: an ID-3 page and an ID-3 spread are both 125 mm
// wide, so width alone made the two choices do exactly the same thing.
function presetHeight() {
  const v = $("preset").value;
  if (v === "custom" || fitMode() !== "real") return null;
  const [w, h] = v.split("x").map(parseFloat);
  const typed = parseFloat($("targetW").value);
  return (h && Math.abs(typed - w) < 0.05) ? h : null;    // only while it matches the preset
}

let measureTimer;
function measure() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(async () => {
    if (!S.doc) return;
    const body = exportBody("pdf");
    const r = await fetch("/api/measure", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return;
    const d = await r.json();
    const m = d.measured_mm, p = d.placed_mm;

    $("factMeasured").textContent = m ? `${m[0]} × ${m[1]} mm` : "scale unknown";
    $("factOutput").textContent = p ? `${p[0]} × ${p[1]} mm` : "scaled to fit";
    $("factDpi").textContent = d.out_dpi
      ? `${d.out_dpi} dpi${d.render_dpi && d.render_dpi !== d.out_dpi ? ` (source ${d.render_dpi})` : ""}`
      : "—";
    $("pageLabel").textContent = `${d.page_mm[0]} × ${d.page_mm[1]} mm`;

    // Make "keep real size" state what it will actually do, rather than describe it.
    $("fitTrueSub").textContent = m
      ? `print it at ${m[0]} × ${m[1]} mm, as measured`
      : "this file carries no scale — falls back to fitting";

    // Measured vs forced is the useful cross-check: a gap means the crop is wrong,
    // not that the preset is.
    const warn = $("sizeWarn");
    warn.hidden = true;
    if (fitMode() === "real") {
      const pv = $("preset").value;
      const cropAspect = p ? p[1] / p[0] : null;
      if (pv !== "custom" && cropAspect) {
        const [pw, ph] = pv.split("x").map(parseFloat);
        const want = ph / pw;
        if (Math.abs(cropAspect - want) / want > 0.08) {
          warn.hidden = false;
          warn.textContent = `Your crop is shaped ${p[0]} × ${p[1]} mm, but ${$("preset").selectedOptions[0].text.split(" — ")[0]}`
            + ` is ${pw} × ${ph} mm. The shapes do not match — you have probably cropped a different part than the preset describes.`;
        }
      }
      if (warn.hidden && m && p && Math.abs(p[0] - m[0]) > 1.5) {
        warn.hidden = false;
        warn.textContent = `You are forcing ${p[0]} mm, but the crop measures ${m[0]} mm on the scan `
          + `(${(p[0] - m[0]).toFixed(1)} mm difference). If the size is meant to be exact, the crop is probably off.`;
      }
    }

    $("marginNote").textContent = ["true", "real"].includes(fitMode())
      ? "Margin applies to “fill the sheet” and “no sheet” only — at a fixed size the item is simply centred."
      : "";
    refreshSheet(body);
  }, 180);
}

let sheetTimer, sheetSeq = 0;
function refreshSheet(body) {
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(async () => {
    const seq = ++sheetSeq;
    $("sheetBusy").hidden = false;
    const r = await fetch("/api/page_preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok || seq !== sheetSeq) { $("sheetBusy").hidden = true; return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const old = $("sheet").src;
    $("sheet").onload = () => { if (old.startsWith("blob:")) URL.revokeObjectURL(old); };
    $("sheet").src = url;
    $("sheetBusy").hidden = true;
  }, 120);
}

async function download(format) {
  busy(true);
  const r = await fetch("/api/export", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exportBody(format)),
  });
  busy(false);
  if (!r.ok) return alert("export failed");
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `scanfit.${format}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
$("exportPdf").onclick = () => download("pdf");
$("exportPng").onclick = () => download("png");

function busy(on) { $("spinner").hidden = !on; }

/* ------------------------------------------------------------ capabilities */
fetch("/api/capabilities").then(r => r.json()).then(c => {
  const b = $("samBadge");
  b.textContent = c.sam ? `SAM 2 · ${(c.sam_model || "").split("hiera-")[1] || "ready"}`
                        : "classic CV (SAM 2 not installed)";
  b.classList.toggle("on", c.sam);
  b.title = c.sam ? c.sam_model : "pip install -r requirements-sam.txt to enable SAM 2";
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => S.img.width && draw(), 120);
});
