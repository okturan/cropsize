/**
 * Cropping, laying out on a sheet, and writing the PDF.
 *
 * Every size here is millimetres until the last moment, because that is the only unit the
 * person printing the thing cares about. Pixels appear once, to decide how many of them a
 * given number of millimetres needs at the export resolution.
 */
import { PDFDocument } from "pdf-lib";
import type { Box } from "./detect";
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

export interface Layout {
  sheet: SheetName;
  landscape: boolean;
  fit: Fit;
  preset: PresetName;
  marginMm: number;
  trim?: { mask: Float32Array; size: number } | null;
}

/**
 * Clear whatever sits outside the traced document. A crop has to be a rectangle, so the
 * corners of a rounded document pick up the platen or the sleeve behind it. The mask knows
 * where the paper stops, so use it rather than accept the square corners.
 */
export function trimToMask(
  canvas: OffscreenCanvas, _box: Box, mask: Float32Array, size: number,
): OffscreenCanvas {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const at = (x: number, y: number) =>
    mask[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))] ?? -1;

  // Fit the outline to the crop by its own bounds rather than through the detected box.
  // The box is snapped to the strongest edge afterwards, so the two disagree by a millimetre
  // or two, and that offset is what left some corners square and clipped others. Anchoring
  // the outline to the crop puts its arcs exactly at the crop's corners.
  let hx0 = size, hy0 = size, hx1 = -1, hy1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((mask[y * size + x] ?? -1) > 0) {
        if (x < hx0) hx0 = x;
        if (x > hx1) hx1 = x;
        if (y < hy0) hy0 = y;
        if (y > hy1) hy1 = y;
      }
    }
  }
  if (hx1 < hx0 || hy1 < hy0) return canvas;
  const spanX = hx1 - hx0 + 1, spanY = hy1 - hy0 + 1;

  for (let y = 0; y < canvas.height; y++) {
    const my = hy0 + (y / canvas.height) * spanY - 0.5;
    const fy = Math.floor(my), wy = my - fy;
    for (let x = 0; x < canvas.width; x++) {
      const mx = hx0 + (x / canvas.width) * spanX - 0.5;
      const fx = Math.floor(mx), wx = mx - fx;
      // Bilinear, so the boundary is a soft edge rather than a staircase of mask pixels,
      // each one of which is several millimetres across at print size.
      const v = (at(fx, fy) * (1 - wx) + at(fx + 1, fy) * wx) * (1 - wy)
              + (at(fx, fy + 1) * (1 - wx) + at(fx + 1, fy + 1) * wx) * wy;
      if (v >= 0.35) continue;                       // comfortably inside
      const i = (y * canvas.width + x) * 4;
      if (v <= -0.35) {                              // comfortably outside
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      } else {
        const a = (v + 0.35) / 0.7;                  // blend across the boundary
        d[i] = (d[i] ?? 0) * a + 255 * (1 - a);
        d[i + 1] = (d[i + 1] ?? 0) * a + 255 * (1 - a);
        d[i + 2] = (d[i + 2] ?? 0) * a + 255 * (1 - a);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function cropCanvas(img: ImageData, box: Box): OffscreenCanvas {
  const x0 = Math.max(0, Math.round(box.x0 * img.width));
  const y0 = Math.max(0, Math.round(box.y0 * img.height));
  const x1 = Math.min(img.width, Math.round(box.x1 * img.width));
  const y1 = Math.min(img.height, Math.round(box.y1 * img.height));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);

  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  const out = new OffscreenCanvas(w, h);
  out.getContext("2d")!.drawImage(src, x0, y0, w, h, 0, 0, w, h);
  return out;
}

/** Physical size of a crop, when the source told us its scale. */
export function measure(img: ImageData, box: Box, mmPerPx: number | null): [number, number] | null {
  if (!mmPerPx) return null;
  const w = (box.x1 - box.x0) * img.width * mmPerPx;
  const h = (box.y1 - box.y0) * img.height * mmPerPx;
  return [Math.round(w * 10) / 10, Math.round(h * 10) / 10];
}

export interface Placed {
  sheetMm: [number, number] | null;
  contentMm: [number, number];
  note: string;
}

/** Work out the printed size without drawing anything, for the readout. */
export function plan(scan: Scan, box: Box, layout: Layout): Placed {
  const crop = {
    w: (box.x1 - box.x0) * scan.image.width,
    h: (box.y1 - box.y0) * scan.image.height,
  };
  const aspect = crop.h / crop.w;
  const sheetMm: [number, number] | null = layout.sheet === "none"
    ? null
    : layout.landscape
      ? [SHEETS[layout.sheet][1], SHEETS[layout.sheet][0]]
      : [SHEETS[layout.sheet][0], SHEETS[layout.sheet][1]];

  const measured = measure(scan.image, box, scan.mmPerPx);
  let contentMm: [number, number];
  let note: string;

  if (layout.fit === "true" && measured) {
    contentMm = measured;
    note = "as measured on the scan";
  } else if (layout.fit === "preset") {
    const [pw, ph] = PRESETS[layout.preset].mm;
    // A preset is a box, not just a width. An ID-3 page and an ID-3 spread are both 125 mm
    // wide, so matching on width alone would make the two choices identical.
    let w = pw, h = pw * aspect;
    if (h > ph) { h = ph; w = ph / aspect; }
    contentMm = [Math.round(w * 10) / 10, Math.round(h * 10) / 10];
    note = `forced to ${PRESETS[layout.preset].label}`;
  } else if (sheetMm) {
    const availW = sheetMm[0] - 2 * layout.marginMm;
    const availH = sheetMm[1] - 2 * layout.marginMm;
    const s = Math.min(availW / crop.w, availH / crop.h);
    contentMm = [Math.round(crop.w * s * 10) / 10, Math.round(crop.h * s * 10) / 10];
    note = "filling the sheet, not to scale";
  } else {
    contentMm = measured ?? [crop.w, crop.h];
    note = measured ? "as measured on the scan" : "no scale available";
  }

  if (sheetMm) {                                    // never let content exceed the paper
    const s = Math.min(sheetMm[0] / contentMm[0], sheetMm[1] / contentMm[1], 1);
    if (s < 1) contentMm = [Math.round(contentMm[0] * s * 10) / 10, Math.round(contentMm[1] * s * 10) / 10];
  }
  return { sheetMm, contentMm, note };
}

const MM_TO_PT = 72 / 25.4;

export async function exportPdf(
  scan: Scan, box: Box, layout: Layout, dpi = 300,
): Promise<Blob> {
  const { sheetMm, contentMm } = plan(scan, box, layout);
  let crop = cropCanvas(scan.image, box);
  if (layout.trim) crop = trimToMask(crop, box, layout.trim.mask, layout.trim.size);

  // Resample once, to exactly the pixels the printed size needs at the export resolution.
  const wPx = Math.max(1, Math.round((contentMm[0] / 25.4) * dpi));
  const hPx = Math.max(1, Math.round((contentMm[1] / 25.4) * dpi));
  const scaled = new OffscreenCanvas(wPx, hPx);
  const sctx = scaled.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(crop, 0, 0, wPx, hPx);
  const png = await scaled.convertToBlob({ type: "image/png" });

  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(await png.arrayBuffer());
  const pageMm = sheetMm ?? [contentMm[0] + 2 * layout.marginMm, contentMm[1] + 2 * layout.marginMm];
  const page = pdf.addPage([pageMm[0] * MM_TO_PT, pageMm[1] * MM_TO_PT]);
  page.drawImage(embedded, {
    x: (pageMm[0] - contentMm[0]) / 2 * MM_TO_PT,
    y: (pageMm[1] - contentMm[1]) / 2 * MM_TO_PT,
    width: contentMm[0] * MM_TO_PT,
    height: contentMm[1] * MM_TO_PT,
  });
  // pdf-lib returns Uint8Array<ArrayBufferLike>; copy into a plain ArrayBuffer for Blob.
  const bytes = await pdf.save();
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Blob([buf], { type: "application/pdf" });
}
