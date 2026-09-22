import type { AppState, TrayItem } from "./app-state";
import type { Box } from "./lib/detect";
import { extractObject } from "./lib/objects";
import {
  composeSheet, cropCanvas, exportPdf, exportSheetPdf, measure, mergePdfPages, plan,
  renderSheetPage, trimToMask,
  type Layout, type SheetItem, type TrimMask,
} from "./lib/sheet";
import type { Scan } from "./lib/source";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => (
  document.getElementById(id) as T
);
const fullBox = (): Box => ({ x0: 0, y0: 0, x1: 1, y1: 1 });

let nextTrayId = 1;

export function createOutputController(
  state: AppState,
  getLayout: () => Layout,
  getTrim: () => TrimMask | null,
  /** what the live crop is made of; the tray uses it to know whether it already holds it */
  getSignature: () => string,
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

  /** The live crop as one sheet item: cropped, trimmed, with the scale it was scanned at. */
  async function liveItem(): Promise<SheetItem> {
    const active = await activeOutput();
    const trim = getTrim();
    let crop = cropCanvas(active.scan.image, active.box);
    if (trim) crop = await trimToMask(crop, active.box, trim.mask, trim.size, trim.box);
    const image = crop.getContext("2d")!.getImageData(0, 0, crop.width, crop.height);
    return { image, mmPerPx: active.scan.mmPerPx, label: active.scan.name };
  }

  const liveOnSheet = () => {
    const signature = getSignature();
    return state.tray.some(item => item.signature === signature);
  };

  /** Everything that prints: the pinned items, then the live crop unless it is pinned already. */
  async function sheetItems(): Promise<SheetItem[]> {
    const items: SheetItem[] = [...state.tray];
    if (!liveOnSheet()) items.push(await liveItem());
    return items;
  }

  function showPreview(canvas: OffscreenCanvas, requested: number) {
    void canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }).then(blob => {
      if (requested !== generation) return;
      const image = byId<HTMLImageElement>("sheetImg");
      const old = image.src;
      image.src = URL.createObjectURL(blob);
      if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    });
  }

  function refreshAddButton() {
    const button = byId<HTMLButtonElement>("addToSheet");
    const pinned = liveOnSheet();
    button.disabled = pinned;
    button.textContent = pinned ? "On the sheet" : "Add to sheet";
    button.title = pinned
      ? "this crop is already pinned on the sheet"
      : "pin this crop on the sheet, then open the other side and crop that too";
  }

  async function refreshSingle(layout: Layout, requested: number) {
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
    byId("scaleNote").textContent = `${placed.note}. ${state.scan!.origin}.`;
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
    showPreview(sheet, requested);
  }

  async function refreshSheet(layout: Layout, requested: number) {
    const items = await sheetItems();
    if (requested !== generation) return;
    const composed = composeSheet(items, layout);
    const count = `${items.length} item${items.length === 1 ? "" : "s"}`;
    const sizes = composed.itemsMm.map(size => `${size[0]} by ${size[1]}`);
    const same = sizes.every(size => size === sizes[0]);
    byId("factScan").textContent = count;
    byId("factOut").textContent = same
      ? `${sizes[0]} mm each` : `${sizes.join(", ")} mm`;
    byId("factSheet").textContent = composed.sheetMm
      ? `${composed.sheetMm[0]} by ${composed.sheetMm[1]} mm` : "no sheet";
    const pages = composed.pages.length > 1 ? `, ${composed.pages.length} pages` : "";
    byId("sheetChip").textContent = composed.sheetMm
      ? `${count} on ${composed.sheetMm[0]} by ${composed.sheetMm[1]}${pages}`
      : `${count}${pages}`;
    byId("scaleNote").textContent = `${composed.note}. ${state.scan!.origin}.`;
    showPreview(renderSheetPage(composed.pages[0]!, 110), requested);
  }

  function refresh() {
    clearTimeout(timer);
    const requested = ++generation;
    timer = window.setTimeout(async () => {
      if (!state.scan) return;
      refreshAddButton();
      const layout = getLayout();
      if (state.tray.length) await refreshSheet(layout, requested);
      else await refreshSingle(layout, requested);
    }, 120);
  }

  /** Pin the live crop on the sheet. Returns the new item, or null when it is there already. */
  async function addLiveToSheet(): Promise<TrayItem | null> {
    if (!state.scan || liveOnSheet()) return null;
    const item: TrayItem = { ...await liveItem(), id: nextTrayId++, signature: getSignature() };
    state.tray.push(item);
    refresh();
    return item;
  }

  async function download(): Promise<Blob> {
    if (!state.scan) throw new Error("open a scan first");
    if (state.tray.length) {
      return exportSheetPdf(composeSheet(await sheetItems(), getLayout()), getLayout());
    }
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

  return { refresh, download, addLiveToSheet };
}
