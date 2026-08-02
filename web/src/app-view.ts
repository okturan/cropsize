import type { AppState } from "./app-state";

const HANDLE = 9;

export function createScanView(state: AppState, onCropCommit: () => void) {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const context = canvas.getContext("2d")!;
  const viewport = document.getElementById("scanViewport")!;
  let zoom = 1;
  let panMode = false;
  let panDrag: null | {
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } = null;

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
    const maxWidth = Math.max(120, viewport.clientWidth - 24);
    const maxHeight = Math.max(120, viewport.clientHeight - 24);
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1) * zoom;
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);

    const source = new OffscreenCanvas(image.width, image.height);
    source.getContext("2d")!.putImageData(image, 0, 0);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    if (state.objects.length) {
      context.save();
      context.font = "600 12px system-ui";
      state.objects.forEach((item, index) => {
        const selected = item.id === state.selectedObjectId;
        context.save();
        context.translate(item.cx * canvas.width, item.cy * canvas.height);
        context.rotate(item.angle * Math.PI / 180);
        context.strokeStyle = selected ? "#2f6df6" : "#00a36c";
        context.lineWidth = selected ? 3 : 2;
        context.strokeRect(
          -item.width * canvas.width / 2,
          -item.height * canvas.height / 2,
          item.width * canvas.width,
          item.height * canvas.height,
        );
        context.restore();
        context.fillStyle = selected ? "#2f6df6" : "#00a36c";
        context.fillText(String(index + 1), item.cx * canvas.width + 5, item.cy * canvas.height - 5);
      });
      context.restore();
      return;
    }

    const box = boxPx();
    context.save();
    context.fillStyle = "rgba(10,12,16,.45)";
    context.beginPath();
    context.rect(0, 0, canvas.width, canvas.height);
    context.rect(box.x, box.y, box.w, box.h);
    context.fill("evenodd");
    context.strokeStyle = "#2f6df6";
    context.lineWidth = 2;
    context.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
    context.fillStyle = "#2f6df6";
    for (const [x, y] of corners()) {
      context.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    }
    context.restore();
  }

  const pointerPosition = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect();
    const scale = canvas.width / bounds.width;
    return {
      x: (event.clientX - bounds.left) * scale,
      y: (event.clientY - bounds.top) * scale,
    };
  };

  function updateControls() {
    const reset = document.getElementById("zoomReset")!;
    reset.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
    (document.getElementById("zoomOut") as HTMLButtonElement).disabled = zoom <= 0.5;
    (document.getElementById("zoomIn") as HTMLButtonElement).disabled = zoom >= 4;
    document.getElementById("panTool")!.setAttribute("aria-pressed", String(panMode));
    viewport.classList.toggle("tool-pan", panMode);
  }

  function setZoom(next: number) {
    const centerX = canvas.width > 0
      ? (viewport.scrollLeft + viewport.clientWidth / 2) / canvas.width : 0.5;
    const centerY = canvas.height > 0
      ? (viewport.scrollTop + viewport.clientHeight / 2) / canvas.height : 0.5;
    zoom = Math.min(4, Math.max(0.5, Math.round(next * 4) / 4));
    draw();
    if (zoom === 1) viewport.scrollTo({ left: 0, top: 0 });
    else {
      viewport.scrollTo({
        left: centerX * canvas.width - viewport.clientWidth / 2,
        top: centerY * canvas.height - viewport.clientHeight / 2,
      });
    }
    updateControls();
  }

  canvas.addEventListener("pointerdown", event => {
    if (panMode) {
      panDrag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      };
      viewport.classList.add("panning");
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (state.objects.length) return;
    const point = pointerPosition(event);
    const cornerIndex = corners().findIndex(([x, y]) => (
      Math.abs(x - point.x) < HANDLE * 1.6 && Math.abs(y - point.y) < HANDLE * 1.6
    ));
    const box = boxPx();
    if (cornerIndex >= 0) {
      state.drag = { kind: "handle", i: cornerIndex, ox: 0, oy: 0 };
    } else if (
      point.x > box.x && point.x < box.x + box.w
      && point.y > box.y && point.y < box.y + box.h
    ) {
      state.drag = {
        kind: "move", i: -1, ox: point.x - box.x, oy: point.y - box.y,
      };
    } else return;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", event => {
    if (panDrag?.pointerId === event.pointerId) {
      viewport.scrollLeft = panDrag.scrollLeft - (event.clientX - panDrag.clientX);
      viewport.scrollTop = panDrag.scrollTop - (event.clientY - panDrag.clientY);
      return;
    }
    if (state.objects.length || !state.drag) return;
    const point = pointerPosition(event);
    const normalizedX = Math.min(Math.max(point.x / canvas.width, 0), 1);
    const normalizedY = Math.min(Math.max(point.y / canvas.height, 0), 1);
    const box = state.box;
    if (state.drag.kind === "move") {
      const width = box.x1 - box.x0;
      const height = box.y1 - box.y0;
      const x0 = Math.min(Math.max((point.x - state.drag.ox) / canvas.width, 0), 1 - width);
      const y0 = Math.min(Math.max((point.y - state.drag.oy) / canvas.height, 0), 1 - height);
      state.box = { x0, y0, x1: x0 + width, y1: y0 + height };
    } else {
      if (state.drag.i === 0 || state.drag.i === 2) box.x0 = Math.min(normalizedX, box.x1 - 0.02);
      if (state.drag.i === 1 || state.drag.i === 3) box.x1 = Math.max(normalizedX, box.x0 + 0.02);
      if (state.drag.i === 0 || state.drag.i === 1) box.y0 = Math.min(normalizedY, box.y1 - 0.02);
      if (state.drag.i === 2 || state.drag.i === 3) box.y1 = Math.max(normalizedY, box.y0 + 0.02);
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
    if (state.objects.length || panMode) return;
    state.box = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 };
    draw();
    onCropCommit();
  });

  document.getElementById("zoomOut")!.addEventListener("click", () => setZoom(zoom - 0.25));
  document.getElementById("zoomIn")!.addEventListener("click", () => setZoom(zoom + 0.25));
  document.getElementById("zoomReset")!.addEventListener("click", () => setZoom(1));
  document.getElementById("panTool")!.addEventListener("click", () => {
    panMode = !panMode;
    updateControls();
  });
  viewport.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
  }, { passive: false });
  updateControls();
  return { draw };
}
