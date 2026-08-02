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
