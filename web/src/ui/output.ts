/**
 * The output pane and the PDF: what prints, how big, and on which sheet. The preview is
 * composed by the same layout code that writes the file, so it cannot drift from it.
 */
import { ui } from "../dom";
import { extractCard, type CardFit } from "../lib/card";
import type { Box } from "../lib/detect";
import { extractObject } from "../lib/objects";
import {
  composeSheet, cropCanvas, exportPdf, exportSheetPdf, measure, mergePdfPages, plan,
  renderSheetPage, trimToMask,
  type Layout, type SheetItem, type TrimMask,
} from "../lib/sheet";
import type { Scan } from "../lib/source";
import type { AppState, TrayItem } from "../state";

const PREVIEW_DPI = 110;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
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
  const selectedObject = () =>
    state.objects.find(item => item.id === state.selectedObjectId) ?? null;

  // The squared-up card for the current image and fit, made once: settings changes recompose
  // the page many times and the warp is the slow part.
  let cardMemo: { image: ImageData; card: CardFit; result: Promise<ImageData> } | null = null;
  function squaredCard(image: ImageData, card: CardFit): Promise<ImageData> {
    if (cardMemo?.image !== image || cardMemo.card !== card) {
      cardMemo = { image, card, result: extractCard(image, card).then(out => out.image) };
    }
    return cardMemo.result;
  }

  async function activeOutput(): Promise<{ scan: Scan; box: Box }> {
    const item = selectedObject();
    if (!item && state.card) {
      const image = await squaredCard(outputImage(), state.card);
      return {
        scan: { ...state.scan!, image, origin: `${state.scan!.origin}; card edges fitted and squared up` },
        box: fullBox(),
      };
    }
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
    if (state.scan && !liveOnSheet()) items.push(await liveItem());
    return items;
  }

  async function showPreview(canvas: OffscreenCanvas, requested: number) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    if (requested !== generation) return;
    const old = ui.sheetImg.src;
    ui.sheetImg.src = URL.createObjectURL(blob);
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
  }

  function refreshAddButton() {
    const pinned = liveOnSheet();
    ui.addToSheet.disabled = pinned || !state.scan;
    ui.addToSheet.textContent = pinned ? "On the sheet" : "Add to sheet";
    ui.addToSheet.title = pinned
      ? "this crop is already pinned on the sheet"
      : "pin this crop on the sheet, then open the other side and crop that too";
  }

  async function refreshSingle(layout: Layout, requested: number) {
    const trim = getTrim();
    const active = await activeOutput();
    if (requested !== generation) return;
    const placed = plan(active.scan, active.box, layout);
    const measured = measure(active.scan.image, active.box, active.scan.mmPerPx);

    ui.factScan.textContent = measured ? `${measured[0]} by ${measured[1]} mm` : "scale unknown";
    ui.factOut.textContent = `${placed.contentMm[0]} by ${placed.contentMm[1]} mm`;
    ui.factSheet.textContent = placed.sheetMm
      ? `${placed.sheetMm[0]} by ${placed.sheetMm[1]} mm` : "no sheet";
    ui.scaleNote.textContent = `${sentence(placed.note)}. ${sentence(state.scan!.origin)}.`;
    ui.sheetChip.textContent = placed.sheetMm
      ? `${placed.contentMm[0]} by ${placed.contentMm[1]} mm on ${placed.sheetMm[0]} by ${placed.sheetMm[1]}`
      : `${placed.contentMm[0]} by ${placed.contentMm[1]} mm`;

    let crop = cropCanvas(active.scan.image, active.box);
    if (trim) crop = await trimToMask(crop, active.box, trim.mask, trim.size, trim.box);
    if (requested !== generation) return;
    const px = (mm: number) => (mm / 25.4) * PREVIEW_DPI;
    const sheet = new OffscreenCanvas(Math.round(px(placed.pageMm[0])), Math.round(px(placed.pageMm[1])));
    const context = sheet.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, sheet.width, sheet.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(crop,
      px(placed.contentOriginMm[0]), px(placed.contentOriginMm[1]),
      Math.round(px(placed.contentMm[0])), Math.round(px(placed.contentMm[1])));
    await showPreview(sheet, requested);
  }

  async function refreshSheet(layout: Layout, requested: number) {
    const items = await sheetItems();
    if (requested !== generation) return;
    const composed = composeSheet(items, layout);
    const count = `${items.length} item${items.length === 1 ? "" : "s"}`;
    const sizes = composed.itemsMm.map(size => `${size[0]} by ${size[1]}`);
    const same = sizes.every(size => size === sizes[0]);
    ui.factScan.textContent = count;
    ui.factOut.textContent = same ? `${sizes[0]} mm each` : `${sizes.join(", ")} mm`;
    ui.factSheet.textContent = composed.sheetMm
      ? `${composed.sheetMm[0]} by ${composed.sheetMm[1]} mm` : "no sheet";
    const pages = composed.pages.length > 1
      ? `, ${composed.pages.length} pages, first shown` : "";
    ui.sheetChip.textContent = composed.sheetMm
      ? `${count} on ${composed.sheetMm[0]} by ${composed.sheetMm[1]}${pages}`
      : `${count}${pages}`;
    ui.scaleNote.textContent = `${sentence(composed.note)}.${state.scan ? ` ${sentence(state.scan.origin)}.` : ""}`;
    await showPreview(renderSheetPage(composed.pages[0]!, PREVIEW_DPI), requested);
  }

  /** Recompose the preview; bursts of changes collapse into one pass. */
  function refresh() {
    window.clearTimeout(timer);
    const requested = ++generation;
    timer = window.setTimeout(() => {
      if (!state.scan) return;
      refreshAddButton();
      const layout = getLayout();
      const work = state.tray.length
        ? refreshSheet(layout, requested) : refreshSingle(layout, requested);
      work.catch((error: unknown) => {
        if (requested !== generation) return;
        ui.scaleNote.textContent = `Could not compose the page. ${(error as Error).message}`;
      });
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

  /** Write the PDF: the sheet when crops are pinned, one page per item in several-items
   *  mode, or the single crop. */
  async function download(): Promise<{ blob: Blob; filename: string }> {
    if (!state.scan) throw new Error("open a scan first");
    const base = state.scan.name.replace(/, page \d+$/, "").replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "cropsize";
    if (state.tray.length) {
      const layout = getLayout();
      return {
        blob: await exportSheetPdf(composeSheet(await sheetItems(), layout), layout),
        filename: `${base}-sheet.pdf`,
      };
    }
    if (state.objects.length) {
      const pages: Blob[] = [];
      for (const item of state.objects) {
        const image = await extractObject(outputImage(), item);
        pages.push(await exportPdf({ ...state.scan, image }, fullBox(), getLayout()));
      }
      return { blob: await mergePdfPages(pages), filename: `${base}-items.pdf` };
    }
    const active = await activeOutput();
    return {
      blob: await exportPdf(active.scan, active.box, getLayout(), getTrim()),
      filename: `${base}-cropsize.pdf`,
    };
  }

  return { refresh, download, addLiveToSheet };
}
