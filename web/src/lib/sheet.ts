/** Sheet composition and PDF writing; numeric imaging/layout decisions live in the core. */
import { PDFDocument } from "pdf-lib";
import type { Box } from "./detect";
import { measureBox, planLayout, trimImageToMask } from "./imaging-core";
import type { Scan } from "./source";

export const SHEETS = {
  a3: [297, 420], a4: [210, 297], a5: [148, 210],
  letter: [215.9, 279.4], legal: [215.9, 355.6],
} as const;
export type SheetName = keyof typeof SHEETS | "none";

export const PRESETS = {
  "passport-spread": { label: "Passport spread", mm: [125, 176] },
  "passport-page": { label: "Passport page", mm: [125, 88] },
  "id-card": { label: "ID or bank card", mm: [85.6, 54] },
} as const;
export type PresetName = keyof typeof PRESETS;
export type Fit = "true" | "preset" | "fill";
export type OutputDpi = "source" | 150 | 300 | 600;
export type TrimMask = { mask: Float32Array; size: number; box: Box };

export interface Layout {
  sheet: SheetName;
  landscape: boolean;
  fit: Fit;
  preset: PresetName;
  marginMm: number;
  outputDpi: OutputDpi;
}

export async function trimToMask(
  canvas: OffscreenCanvas, box: Box, mask: Float32Array, size: number, maskBox = box,
): Promise<OffscreenCanvas> {
  const context = canvas.getContext("2d")!;
  const input = context.getImageData(0, 0, canvas.width, canvas.height);
  const output = await trimImageToMask(input, box, mask, size, maskBox);
  context.putImageData(output, 0, 0);
  return canvas;
}

export function cropCanvas(img: ImageData, box: Box): OffscreenCanvas {
  const x0 = Math.max(0, Math.round(box.x0 * img.width));
  const y0 = Math.max(0, Math.round(box.y0 * img.height));
  const x1 = Math.min(img.width, Math.round(box.x1 * img.width));
  const y1 = Math.min(img.height, Math.round(box.y1 * img.height));
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
  const source = new OffscreenCanvas(img.width, img.height);
  source.getContext("2d")!.putImageData(img, 0, 0);
  const output = new OffscreenCanvas(width, height);
  output.getContext("2d")!.drawImage(source, x0, y0, width, height, 0, 0, width, height);
  return output;
}

export function measure(
  img: ImageData, box: Box, mmPerPx: number | null,
): [number, number] | null {
  return measureBox(img.width, img.height, box, mmPerPx);
}

export interface Placed {
  sheetMm: [number, number] | null;
  pageMm: [number, number];
  contentMm: [number, number];
  contentOriginMm: [number, number];
  note: string;
}

export function plan(scan: Scan, box: Box, layout: Layout): Placed {
  const sheetMm: [number, number] | null = layout.sheet === "none"
    ? null
    : layout.landscape
      ? [SHEETS[layout.sheet][1], SHEETS[layout.sheet][0]]
      : [SHEETS[layout.sheet][0], SHEETS[layout.sheet][1]];
  const preset = PRESETS[layout.preset];
  const fit = layout.fit === "true" ? 0 : layout.fit === "preset" ? 1 : 2;
  const result = planLayout({
    width: scan.image.width,
    height: scan.image.height,
    box,
    mmPerPx: scan.mmPerPx,
    sheetMm,
    fit,
    presetMm: [...preset.mm],
    marginMm: layout.marginMm,
  });
  const note = result.noteCode === 0
    ? "as measured on the scan"
    : result.noteCode === 1
      ? `forced to ${preset.label}`
      : result.noteCode === 2 ? "filling the sheet, not to scale" : "no scale available";
  const pageMm: [number, number] = sheetMm ?? [
    result.contentMm[0] + 2 * layout.marginMm,
    result.contentMm[1] + 2 * layout.marginMm,
  ];
  return {
    sheetMm,
    pageMm,
    contentMm: result.contentMm,
    contentOriginMm: [
      (pageMm[0] - result.contentMm[0]) / 2,
      (pageMm[1] - result.contentMm[1]) / 2,
    ],
    note,
  };
}

const MM_TO_PT = 72 / 25.4;

export function outputPixelSize(
  scan: Scan, box: Box, layout: Layout,
): [number, number] {
  if (layout.outputDpi === "source") {
    const x0 = Math.max(0, Math.round(box.x0 * scan.image.width));
    const y0 = Math.max(0, Math.round(box.y0 * scan.image.height));
    const x1 = Math.min(scan.image.width, Math.round(box.x1 * scan.image.width));
    const y1 = Math.min(scan.image.height, Math.round(box.y1 * scan.image.height));
    return [Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
  }
  const { contentMm } = plan(scan, box, layout);
  return [
    Math.max(1, Math.round((contentMm[0] / 25.4) * layout.outputDpi)),
    Math.max(1, Math.round((contentMm[1] / 25.4) * layout.outputDpi)),
  ];
}

export async function exportPdf(
  scan: Scan, box: Box, layout: Layout, trim: TrimMask | null = null,
): Promise<Blob> {
  const { pageMm, contentMm, contentOriginMm } = plan(scan, box, layout);
  let crop = cropCanvas(scan.image, box);
  if (trim) {
    crop = await trimToMask(crop, box, trim.mask, trim.size, trim.box);
  }

  const [widthPx, heightPx] = outputPixelSize(scan, box, layout);
  const scaled = new OffscreenCanvas(widthPx, heightPx);
  const context = scaled.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(crop, 0, 0, widthPx, heightPx);
  const png = await scaled.convertToBlob({ type: "image/png" });

  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(await png.arrayBuffer());
  const page = pdf.addPage([pageMm[0] * MM_TO_PT, pageMm[1] * MM_TO_PT]);
  page.drawImage(embedded, {
    x: contentOriginMm[0] * MM_TO_PT,
    y: contentOriginMm[1] * MM_TO_PT,
    width: contentMm[0] * MM_TO_PT,
    height: contentMm[1] * MM_TO_PT,
  });
  const bytes = await pdf.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "application/pdf" });
}

export async function mergePdfPages(blobs: Blob[]): Promise<Blob> {
  const output = await PDFDocument.create();
  for (const blob of blobs) {
    const source = await PDFDocument.load(await blob.arrayBuffer());
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  const bytes = await output.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "application/pdf" });
}

/* ---------------------------------------------------------------- several on one sheet */

/** One cropped thing to print, kept as its own pixels plus the scale they were scanned at. */
export interface SheetItem {
  image: ImageData;
  mmPerPx: number | null;
  label: string;
}

export interface SheetPlacement {
  item: SheetItem;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

export interface SheetPage {
  pageMm: [number, number];
  placements: SheetPlacement[];
}

export interface ComposedSheet {
  pages: SheetPage[];
  sheetMm: [number, number] | null;
  /** printed size of every item, in item order */
  itemsMm: [number, number][];
  note: string;
}

const tenth = (value: number) => Math.round(value * 10) / 10;

/** The size each item wants before any sheet is considered; null means "no scale". */
function naturalSizes(
  items: SheetItem[], layout: Layout,
): { sizes: [number, number][]; fill: boolean; note: string } {
  const preset = PRESETS[layout.preset];
  if (layout.fit === "preset") {
    return {
      note: `forced to ${preset.label}`,
      fill: false,
      sizes: items.map(({ image }) => {
        const aspect = image.height / image.width;
        let width = preset.mm[0], height = width * aspect;
        if (height > preset.mm[1]) { height = preset.mm[1]; width = height / aspect; }
        return [tenth(width), tenth(height)];
      }),
    };
  }
  const measured = items.map(({ image, mmPerPx }) =>
    measureBox(image.width, image.height, { x0: 0, y0: 0, x1: 1, y1: 1 }, mmPerPx));
  if (layout.fit === "true" && measured.every(size => size !== null)) {
    return { note: "as measured on the scan", fill: false, sizes: measured as [number, number][] };
  }
  // Fill, or real size asked for without a scale to honour: pixels become relative units and
  // the group is scaled to the sheet as one block, so the items keep their relative sizes.
  const note = layout.fit === "true"
    ? "no scale available, so filling the sheet"
    : "filling the sheet, not to scale";
  return {
    note,
    fill: true,
    sizes: items.map(({ image }) => [image.width, image.height]),
  };
}

type Arrangement = "column" | "row";

function centred(
  sizes: [number, number][], arrangement: Arrangement, gap: number,
  pageMm: [number, number], margin: number,
): { x: number; y: number }[] {
  const along = arrangement === "column" ? 1 : 0;
  const across = 1 - along;
  const length = sizes.reduce((sum, size) => sum + size[along], 0) + gap * (sizes.length - 1);
  const available = [pageMm[0] - 2 * margin, pageMm[1] - 2 * margin];
  let cursor = margin + Math.max(0, (available[along]! - length) / 2);
  return sizes.map(size => {
    const position: [number, number] = [0, 0];
    position[along] = cursor;
    position[across] = margin + Math.max(0, (available[across]! - size[across]!) / 2);
    cursor += size[along]! + gap;
    return { x: position[0], y: position[1] };
  });
}

/**
 * Lay several items out on the chosen sheet. Two sides of a card go on one page, stacked
 * when they fit that way, side by side otherwise; anything that will not fit at its size
 * flows onto further pages rather than being shrunk, because the size is the point.
 */
export function composeSheet(items: SheetItem[], layout: Layout): ComposedSheet {
  const margin = Math.max(0, layout.marginMm);
  const gap = Math.max(margin, 4);
  const natural = naturalSizes(items, layout);
  const sheetMm: [number, number] | null = layout.sheet === "none"
    ? null
    : layout.landscape
      ? [SHEETS[layout.sheet][1], SHEETS[layout.sheet][0]]
      : [SHEETS[layout.sheet][0], SHEETS[layout.sheet][1]];
  let sizes = natural.sizes;
  let note = natural.note;

  const place = (page: [number, number], arrangement: Arrangement, chosen: [number, number][]) => ({
    pageMm: page,
    placements: centred(chosen, arrangement, gap, page, margin).map(({ x, y }, index) => ({
      item: items[index]!, xMm: tenth(x), yMm: tenth(y),
      wMm: chosen[index]![0], hMm: chosen[index]![1],
    })),
  });

  if (!sheetMm) {
    if (natural.fill) {
      // No sheet to fill: fall back to the scan's own scale, or a pixel-per-millimetre guess.
      sizes = items.map(({ image, mmPerPx }) =>
        measureBox(image.width, image.height, { x0: 0, y0: 0, x1: 1, y1: 1 }, mmPerPx)
          ?? [image.width, image.height]);
      note = "no sheet to fill, so as measured where a scale exists";
    }
    const width = Math.max(...sizes.map(size => size[0]));
    const height = sizes.reduce((sum, size) => sum + size[1], 0) + gap * (sizes.length - 1);
    const page: [number, number] = [tenth(width + 2 * margin), tenth(height + 2 * margin)];
    return { pages: [place(page, "column", sizes)], sheetMm, itemsMm: sizes, note };
  }

  const available: [number, number] = [sheetMm[0] - 2 * margin, sheetMm[1] - 2 * margin];
  const stacked = (arrangement: Arrangement, chosen: [number, number][]) => {
    const along = arrangement === "column" ? 1 : 0;
    return [
      Math.max(...chosen.map(size => size[1 - along]!)),
      chosen.reduce((sum, size) => sum + size[along]!, 0) + gap * (chosen.length - 1),
    ] as const;   // [across, along]
  };
  const scaleFor = (arrangement: Arrangement) => {
    const [across, along] = stacked(arrangement, sizes);
    const alongIndex = arrangement === "column" ? 1 : 0;
    return Math.min(available[1 - alongIndex]! / across, available[alongIndex]! / along);
  };

  if (natural.fill) {
    const column = scaleFor("column"), row = scaleFor("row");
    const arrangement: Arrangement = column >= row ? "column" : "row";
    const scale = Math.max(column, row);
    const scaled = sizes.map(size => [tenth(size[0] * scale), tenth(size[1] * scale)] as [number, number]);
    return { pages: [place(sheetMm, arrangement, scaled)], sheetMm, itemsMm: scaled, note };
  }

  // Never enlarge, but an item wider or taller than the printable area is shrunk to it, as
  // the single-item path does, rather than being clipped.
  sizes = sizes.map(size => {
    const scale = Math.min(1, available[0] / size[0], available[1] / size[1]);
    return scale < 1 ? [tenth(size[0] * scale), tenth(size[1] * scale)] : size;
  });
  if (sizes.some((size, index) => size !== natural.sizes[index])) {
    note = `${note}, shrunk to the sheet`;
  }
  for (const arrangement of ["column", "row"] as const) {
    if (scaleFor(arrangement) >= 1) {
      return { pages: [place(sheetMm, arrangement, sizes)], sheetMm, itemsMm: sizes, note };
    }
  }

  // Shelf packing across as many pages as it takes.
  const pages: SheetPage[] = [];
  let rows: { sizes: [number, number][]; indices: number[] }[] = [];
  let rowWidth = 0, usedHeight = 0;
  const flush = () => {
    if (!rows.length) return;
    const blockHeight = rows.reduce((sum, row) => sum + Math.max(...row.sizes.map(s => s[1])), 0)
      + gap * (rows.length - 1);
    let y = margin + Math.max(0, (available[1] - blockHeight) / 2);
    const placements: SheetPlacement[] = [];
    for (const row of rows) {
      const rowHeight = Math.max(...row.sizes.map(s => s[1]));
      const width = row.sizes.reduce((sum, s) => sum + s[0], 0) + gap * (row.sizes.length - 1);
      let x = margin + Math.max(0, (available[0] - width) / 2);
      row.sizes.forEach((size, i) => {
        placements.push({
          item: items[row.indices[i]!]!, xMm: tenth(x), yMm: tenth(y + (rowHeight - size[1]) / 2),
          wMm: size[0], hMm: size[1],
        });
        x += size[0] + gap;
      });
      y += rowHeight + gap;
    }
    pages.push({ pageMm: sheetMm, placements });
    rows = [];
    rowWidth = 0;
    usedHeight = 0;
  };
  sizes.forEach((size, index) => {
    const current = rows[rows.length - 1];
    const fitsRow = current && rowWidth + gap + size[0] <= available[0];
    if (!fitsRow) {
      const rowHeight = current ? Math.max(...current.sizes.map(s => s[1])) : 0;
      const nextHeight = usedHeight + (current ? rowHeight + gap : 0) + size[1];
      if (current && nextHeight > available[1]) flush();
      else if (current) usedHeight += rowHeight + gap;
      rows.push({ sizes: [size], indices: [index] });
      rowWidth = size[0];
    } else {
      current.sizes.push(size);
      current.indices.push(index);
      rowWidth += gap + size[0];
    }
  });
  flush();
  return {
    pages, sheetMm, itemsMm: sizes,
    note: `${note}, ${pages.length} pages because they do not all fit on one`,
  };
}

function canvasOf(image: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas;
}

/** Rasterise one composed page, used for the preview. */
export function renderSheetPage(page: SheetPage, dpi: number): OffscreenCanvas {
  const px = (mm: number) => (mm / 25.4) * dpi;
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(px(page.pageMm[0]))), Math.max(1, Math.round(px(page.pageMm[1]))),
  );
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = "high";
  for (const placed of page.placements) {
    context.drawImage(
      canvasOf(placed.item.image), px(placed.xMm), px(placed.yMm), px(placed.wMm), px(placed.hMm),
    );
  }
  return canvas;
}

export async function exportSheetPdf(sheet: ComposedSheet, layout: Layout): Promise<Blob> {
  const pdf = await PDFDocument.create();
  const embedded = new Map<SheetItem, Awaited<ReturnType<typeof pdf.embedPng>>>();
  for (const page of sheet.pages) {
    const pdfPage = pdf.addPage([page.pageMm[0] * MM_TO_PT, page.pageMm[1] * MM_TO_PT]);
    for (const placed of page.placements) {
      let image = embedded.get(placed.item);
      if (!image) {
        const source = canvasOf(placed.item.image);
        let output = source;
        if (layout.outputDpi !== "source") {
          const width = Math.max(1, Math.round((placed.wMm / 25.4) * layout.outputDpi));
          const height = Math.max(1, Math.round((placed.hMm / 25.4) * layout.outputDpi));
          output = new OffscreenCanvas(width, height);
          const context = output.getContext("2d")!;
          context.imageSmoothingQuality = "high";
          context.drawImage(source, 0, 0, width, height);
        }
        const png = await output.convertToBlob({ type: "image/png" });
        image = await pdf.embedPng(await png.arrayBuffer());
        embedded.set(placed.item, image);
      }
      pdfPage.drawImage(image, {
        x: placed.xMm * MM_TO_PT,
        y: (page.pageMm[1] - placed.yMm - placed.hMm) * MM_TO_PT,
        width: placed.wMm * MM_TO_PT,
        height: placed.hMm * MM_TO_PT,
      });
    }
  }
  const bytes = await pdf.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "application/pdf" });
}
