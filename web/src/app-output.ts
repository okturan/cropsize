import type { AppState } from "./app-state";
import type { Box } from "./lib/detect";
import { extractObject } from "./lib/objects";
import {
  cropCanvas, exportPdf, measure, mergePdfPages, plan, trimToMask,
  type Layout, type TrimMask,
} from "./lib/sheet";
import type { Scan } from "./lib/source";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => (
  document.getElementById(id) as T
);
const fullBox = (): Box => ({ x0: 0, y0: 0, x1: 1, y1: 1 });

export function createOutputController(
  state: AppState, getLayout: () => Layout, getTrim: () => TrimMask | null,
) {
  let timer: number | undefined;
  let generation = 0;
  const outputImage = () => state.toned ?? state.scan!.image;
  const selectedObject = () => (
    state.objects.find(item => item.id === state.selectedObjectId) ?? null
  );

  async function activeOutput(): Promise<{ scan: Scan; box: Box }> {
    const item = selectedObject();
    if (!item) return { scan: { ...state.scan!, image: outputImage() }, box: state.box };
    const image = await extractObject(outputImage(), item);
    return {
      scan: {
        ...state.scan!,
        image,
        origin: `${state.scan!.origin}; item angle ${item.angle.toFixed(1)} degrees`,
        name: `${state.scan!.name}, item ${state.objects.indexOf(item) + 1}`,
      },
      box: fullBox(),
    };
  }

  function refresh() {
    clearTimeout(timer);
    const requested = ++generation;
    timer = window.setTimeout(async () => {
      if (!state.scan) return;
      const layout = getLayout();
      const trim = getTrim();
      const active = await activeOutput();
      if (requested !== generation) return;
      const placed = plan(active.scan, active.box, layout);
      const measured = measure(active.scan.image, active.box, active.scan.mmPerPx);

      byId("factScan").textContent = measured
        ? `${measured[0]} by ${measured[1]} mm` : "scale unknown";
      byId("factOut").textContent = `${placed.contentMm[0]} by ${placed.contentMm[1]} mm`;
      byId("factSheet").textContent = placed.sheetMm
        ? `${placed.sheetMm[0]} by ${placed.sheetMm[1]} mm` : "no sheet";
      byId("scaleNote").textContent = `${placed.note}. ${state.scan.origin}.`;
      byId("sheetChip").textContent = placed.sheetMm
        ? `${placed.contentMm[0]} by ${placed.contentMm[1]} mm on ${placed.sheetMm[0]} by ${placed.sheetMm[1]}`
        : `${placed.contentMm[0]} by ${placed.contentMm[1]} mm`;

      let crop = cropCanvas(active.scan.image, active.box);
      if (trim) {
        crop = await trimToMask(
          crop, active.box, trim.mask, trim.size, trim.box,
        );
      }
      if (requested !== generation) return;
      const previewDpi = 110;
      const sheetWidth = Math.round((placed.pageMm[0] / 25.4) * previewDpi);
      const sheetHeight = Math.round((placed.pageMm[1] / 25.4) * previewDpi);
      const sheet = new OffscreenCanvas(sheetWidth, sheetHeight);
      const context = sheet.getContext("2d")!;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, sheetWidth, sheetHeight);
      const contentWidth = Math.round((placed.contentMm[0] / 25.4) * previewDpi);
      const contentHeight = Math.round((placed.contentMm[1] / 25.4) * previewDpi);
      context.drawImage(
        crop,
        placed.contentOriginMm[0] / 25.4 * previewDpi,
        placed.contentOriginMm[1] / 25.4 * previewDpi,
        contentWidth,
        contentHeight,
      );
      const blob = await sheet.convertToBlob({ type: "image/jpeg", quality: 0.85 });
      if (requested !== generation) return;
      const image = byId<HTMLImageElement>("sheetImg");
      const old = image.src;
      image.src = URL.createObjectURL(blob);
      if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    }, 120);
  }

  async function download(): Promise<Blob> {
    if (!state.scan) throw new Error("open a scan first");
    if (state.objects.length) {
      const pages: Blob[] = [];
      for (const item of state.objects) {
        const image = await extractObject(outputImage(), item);
        pages.push(await exportPdf({ ...state.scan, image }, fullBox(), getLayout()));
      }
      return mergePdfPages(pages);
    }
    return exportPdf(
      { ...state.scan, image: outputImage() }, state.box, getLayout(), getTrim(),
    );
  }

  return { refresh, download };
}
