/**
 * The scan pane: the image, the crop box with its corner handles, the several-items
 * outlines, zoom and pan. The canvas backing store is sized in device pixels so the scan and
 * the handles stay sharp on high-density screens; all geometry is kept normalised, 0..1.
 */
import { ui } from "../dom";
import { canvasOf } from "../lib/canvas";
import type { AppState } from "../state";

const HANDLE = 9;          // CSS pixels
const MIN_SIZE = 0.02;     // smallest crop, as a fraction of the frame
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

export function createScanView(state: AppState, onCropCommit: () => void) {
  const { canvas, scanViewport: viewport } = ui;
  const context = canvas.getContext("2d")!;
  let zoom = 1;
  let panMode = false;
  let dpr = 1;
  let panDrag: null | {
    pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number;
  } = null;

  const accent = () => getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim() || "#2f6df6";

  const boxPx = () => ({
    x: state.box.x0 * canvas.width,
    y: state.box.y0 * canvas.height,
    w: (state.box.x1 - state.box.x0) * canvas.width,
    h: (state.box.y1 - state.box.y0) * canvas.height,
  });
  const corners = (): [number, number][] => {
    const box = boxPx();
    return [
      [box.x, box.y], [box.x + box.w, box.y],
      [box.x, box.y + box.h], [box.x + box.w, box.y + box.h],
    ];
  };

  function draw() {
    if (!state.scan) return;
    const image = state.scan.image;
    dpr = window.devicePixelRatio || 1;
    const maxWidth = Math.max(120, viewport.clientWidth - 24);
    const maxHeight = Math.max(120, viewport.clientHeight - 24);
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1) * zoom;
    const cssWidth = Math.max(1, Math.round(image.width * scale));
    const cssHeight = Math.max(1, Math.round(image.height * scale));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    context.imageSmoothingQuality = "high";
    context.drawImage(canvasOf(image), 0, 0, canvas.width, canvas.height);
    // The crop, readable from outside: the end-to-end test drags its corners.
    canvas.dataset.box = JSON.stringify(state.box);
    const colour = accent();

    if (state.objects.length) {
      context.save();
      context.font = `600 ${12 * dpr}px system-ui`;
      state.objects.forEach((item, index) => {
        const selected = item.id === state.selectedObjectId;
        const stroke = selected ? colour : "#00a36c";
        context.save();
        context.translate(item.cx * canvas.width, item.cy * canvas.height);
        context.rotate(item.angle * Math.PI / 180);
        context.strokeStyle = stroke;
        context.lineWidth = (selected ? 3 : 2) * dpr;
        context.strokeRect(
          -item.width * canvas.width / 2, -item.height * canvas.height / 2,
          item.width * canvas.width, item.height * canvas.height,
        );
        context.restore();
        context.fillStyle = stroke;
        context.fillText(String(index + 1),
          item.cx * canvas.width + 5 * dpr, item.cy * canvas.height - 5 * dpr);
      });
      context.restore();
      return;
    }

    const box = boxPx();
    const handle = HANDLE * dpr;
    context.save();
    context.fillStyle = "rgba(10,12,16,.45)";
    context.beginPath();
    context.rect(0, 0, canvas.width, canvas.height);
    context.rect(box.x, box.y, box.w, box.h);
    context.fill("evenodd");
    context.strokeStyle = colour;
    context.lineWidth = 2 * dpr;
    context.strokeRect(box.x + dpr, box.y + dpr, box.w - 2 * dpr, box.h - 2 * dpr);
    context.fillStyle = colour;
    for (const [x, y] of corners()) context.fillRect(x - handle / 2, y - handle / 2, handle, handle);
    context.restore();
  }

  /** Pointer position in canvas backing-store pixels. */
  const pointer = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    };
  };

  function updateControls() {
    ui.zoomReset.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
    ui.zoomOut.disabled = zoom <= ZOOM_MIN;
    ui.zoomIn.disabled = zoom >= ZOOM_MAX;
    ui.panTool.setAttribute("aria-pressed", String(panMode));
    viewport.classList.toggle("tool-pan", panMode);
  }

  function setZoom(next: number) {
    const cssWidth = canvas.width / dpr, cssHeight = canvas.height / dpr;
    const centerX = cssWidth > 0 ? (viewport.scrollLeft + viewport.clientWidth / 2) / cssWidth : 0.5;
    const centerY = cssHeight > 0 ? (viewport.scrollTop + viewport.clientHeight / 2) / cssHeight : 0.5;
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 4) / 4));
    draw();
    if (zoom === 1) viewport.scrollTo({ left: 0, top: 0 });
    else {
      viewport.scrollTo({
        left: centerX * (canvas.width / dpr) - viewport.clientWidth / 2,
        top: centerY * (canvas.height / dpr) - viewport.clientHeight / 2,
      });
    }
    updateControls();
  }

  canvas.addEventListener("pointerdown", event => {
    if (panMode) {
      panDrag = {
        pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
      };
      viewport.classList.add("panning");
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (state.objects.length || !state.scan) return;
    const point = pointer(event);
    const reach = HANDLE * 1.6 * dpr;
    const cornerIndex = corners().findIndex(([x, y]) =>
      Math.abs(x - point.x) < reach && Math.abs(y - point.y) < reach);
    const box = boxPx();
    if (cornerIndex >= 0) {
      state.drag = { kind: "handle", i: cornerIndex, ox: 0, oy: 0 };
    } else if (point.x > box.x && point.x < box.x + box.w
        && point.y > box.y && point.y < box.y + box.h) {
      state.drag = { kind: "move", i: -1, ox: point.x - box.x, oy: point.y - box.y };
    } else {
      return;
    }
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", event => {
    if (panDrag?.pointerId === event.pointerId) {
      viewport.scrollLeft = panDrag.scrollLeft - (event.clientX - panDrag.clientX);
      viewport.scrollTop = panDrag.scrollTop - (event.clientY - panDrag.clientY);
      return;
    }
    if (state.objects.length || !state.drag) return;
    const point = pointer(event);
    const nx = Math.min(Math.max(point.x / canvas.width, 0), 1);
    const ny = Math.min(Math.max(point.y / canvas.height, 0), 1);
    const box = { ...state.box };
    if (state.drag.kind === "move") {
      const width = box.x1 - box.x0, height = box.y1 - box.y0;
      const x0 = Math.min(Math.max((point.x - state.drag.ox) / canvas.width, 0), 1 - width);
      const y0 = Math.min(Math.max((point.y - state.drag.oy) / canvas.height, 0), 1 - height);
      state.box = { x0, y0, x1: x0 + width, y1: y0 + height };
    } else {
      const i = state.drag.i;
      if (i === 0 || i === 2) box.x0 = Math.min(nx, box.x1 - MIN_SIZE);
      if (i === 1 || i === 3) box.x1 = Math.max(nx, box.x0 + MIN_SIZE);
      if (i === 0 || i === 1) box.y0 = Math.min(ny, box.y1 - MIN_SIZE);
      if (i === 2 || i === 3) box.y1 = Math.max(ny, box.y0 + MIN_SIZE);
      state.box = box;
    }
    draw();
  });

  for (const name of ["pointerup", "pointercancel"] as const) {
    canvas.addEventListener(name, event => {
      if (panDrag?.pointerId === event.pointerId) {
        panDrag = null;
        viewport.classList.remove("panning");
      }
      if (state.drag) {
        state.drag = null;
        onCropCommit();
      }
    });
  }
  canvas.addEventListener("dblclick", () => {
    if (state.objects.length || panMode || !state.scan) return;
    state.box = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 };
    draw();
    onCropCommit();
  });

  ui.zoomOut.addEventListener("click", () => setZoom(zoom - 0.25));
  ui.zoomIn.addEventListener("click", () => setZoom(zoom + 0.25));
  ui.zoomReset.addEventListener("click", () => setZoom(1));
  ui.panTool.addEventListener("click", () => {
    panMode = !panMode;
    updateControls();
  });
  viewport.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
  }, { passive: false });
  updateControls();

  return { draw, resetZoom: () => setZoom(1) };
}
