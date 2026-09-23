/**
 * Getting a scan into the browser, with its physical scale intact.
 *
 * The whole point of cropsize is knowing how big things really are, and that comes from the
 * PDF's own page geometry rather than from the pixels. A scanner writes the scanned area
 * into page space at 1 to 1, so a page that reports 216 by 297 mm and rasterises to 2551 px
 * wide fixes the scale at 25.4 / 300 mm per pixel. Rendering at a different resolution
 * changes the pixel count and the mm per pixel together, so the measurement never moves.
 */
import * as pdfjs from "pdfjs-dist";
// Importing the worker module and exposing it as globalThis.pdfjsWorker makes pdf.js parse
// on the main thread instead of spawning a Worker. One page at a time is a brief block, and
// it removes a separate asset whose URL has to resolve correctly once deployed.
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs";

(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

export const RENDER_DPI = 300;
/** A page is rendered at RENDER_DPI unless that would pass this many pixels. Some PDFs
 *  declare pages in pixels as points, 34 by 48 inches for an A4 scan, which at 300 dpi is a
 *  151-megapixel canvas; those render at the resolution that fits instead. */
const MAX_PAGE_PIXELS = 40e6;

export interface Scan {
  image: ImageData;
  /** millimetres per pixel of `image`, or null when the source carries no scale */
  mmPerPx: number | null;
  /** the camera's focal length in pixels of `image`, from a photo's EXIF; null when unknown */
  focal?: number | null;
  /** physical size of the whole scanned area, when known */
  pageMm: [number, number] | null;
  dpi: number;
  origin: string;
  name: string;
}

export interface DocumentSource {
  name: string;
  pageCount: number;
  loadPage(index: number): Promise<Scan>;
  close(): Promise<void>;
}

function toImageData(canvas: HTMLCanvasElement | OffscreenCanvas): ImageData {
  const ctx = canvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("no 2d context");
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** pdf.js renders into a real canvas element, not an OffscreenCanvas. */
function pageCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export async function loadPdf(
  data: ArrayBuffer, name: string, dpi = RENDER_DPI,
): Promise<DocumentSource> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  const doc = await task.promise;
  const loadPage = async (index: number): Promise<Scan> => {
    if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) {
      throw new Error(`page ${index + 1} is outside this ${doc.numPages}-page PDF`);
    }
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });          // 1 unit == 1 point
    const pageMm: [number, number] = [
      Math.round((base.width / 72) * 25.4 * 10) / 10,
      Math.round((base.height / 72) * 25.4 * 10) / 10,
    ];

    const inches = (base.width / 72) * (base.height / 72);
    const pageDpi = Math.min(dpi, Math.floor(Math.sqrt(MAX_PAGE_PIXELS / Math.max(inches, 1e-6))));
    const viewport = page.getViewport({ scale: pageDpi / 72 });
    const canvas = pageCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;

    return {
      image: toImageData(canvas),
      mmPerPx: 25.4 / pageDpi,
      pageMm,
      dpi: pageDpi,
      origin: `PDF page ${index + 1} of ${doc.numPages}, ${pageMm[0]} by ${pageMm[1]} mm, rendered at ${pageDpi} dpi`,
      name: doc.numPages > 1 ? `${name}, page ${index + 1}` : name,
    };
  };

  return {
    name,
    pageCount: doc.numPages,
    loadPage,
    close: async () => { await task.destroy(); },
  };
}

/**
 * The focal length a camera recorded, as its 35 mm equivalent, from a JPEG's EXIF. Null when
 * it is missing, or when the picture is no longer the frame it was taken at: a crop keeps the
 * original's EXIF, and its focal length would then be wrong for these pixels.
 */
export function exifFocal35(bytes: Uint8Array, width: number, height: number): number | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let p = 2;
  while (p + 10 <= bytes.length && bytes[p] === 0xff) {
    const marker = bytes[p + 1]!;
    const length = (bytes[p + 2]! << 8) | bytes[p + 3]!;
    if (marker === 0xda || marker === 0xd9) break;          // the image data: no EXIF before it
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(p + 4, p + 10)) === "Exif\0\0") {
      return focalInTiff(bytes.subarray(p + 10, p + 2 + length), width, height);
    }
    p += 2 + length;
  }
  return null;
}

function focalInTiff(tiff: Uint8Array, width: number, height: number): number | null {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49;                          // "II", else "MM"
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const entries = (ifd: number) => {
    const found = new Map<number, number>();
    for (let i = 0, n = u16(ifd); i < n; i++) found.set(u16(ifd + 2 + 12 * i), ifd + 2 + 12 * i);
    return found;
  };
  const value = (entry: number) => (u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));   // SHORT or LONG
  try {
    const pointer = entries(u32(4)).get(0x8769);
    if (pointer === undefined) return null;
    const exif = entries(value(pointer));
    const tag = exif.get(0xa405);                           // FocalLengthIn35mmFilm
    const mm = tag === undefined ? 0 : value(tag);
    if (!mm) return null;
    const [px, py] = [exif.get(0xa002), exif.get(0xa003)];  // the frame as taken
    if (px !== undefined && py !== undefined) {
      const [w0, h0] = [value(px), value(py)];
      const ratio = (a: number, b: number) => Math.max(a, b) / Math.max(1, Math.min(a, b));
      if (Math.abs(ratio(width, height) / ratio(w0, h0) - 1) > 0.01) return null;
    }
    return mm;
  } catch {
    return null;                                            // a malformed block says nothing
  }
}

export async function loadRaster(file: Blob, name: string): Promise<DocumentSource> {
  const bitmap = await createImageBitmap(file);
  const canvas = pageCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // A raster file carries no reliable scale in the browser: PNG pHYs and JPEG EXIF
  // resolution are not exposed to canvas, so true size is unavailable and the UI says so.
  // The lens, though, tells how much perspective a photographed page is under.
  const focal35 = exifFocal35(new Uint8Array(await file.arrayBuffer()), canvas.width, canvas.height);
  const scan: Scan = {
    image: toImageData(canvas),
    mmPerPx: null,
    // 35 mm equivalence is defined on the frame's diagonal, 43.27 mm
    focal: focal35 ? (focal35 / 43.27) * Math.hypot(canvas.width, canvas.height) : null,
    pageMm: null,
    dpi: RENDER_DPI,
    origin: "image file, no page geometry to read a scale from",
    name,
  };
  return {
    name,
    pageCount: 1,
    loadPage: async index => {
      if (index !== 0) throw new Error("this image has one page");
      return scan;
    },
    close: async () => {},
  };
}

export async function loadFile(file: File): Promise<DocumentSource> {
  if (file.name.toLowerCase().endsWith(".pdf")) {
    return loadPdf(await file.arrayBuffer(), file.name);
  }
  return loadRaster(file, file.name);
}

export async function loadSample(): Promise<DocumentSource> {
  const res = await fetch("sample-scan.pdf");
  if (!res.ok) throw new Error("sample scan is missing");
  return loadPdf(await res.arrayBuffer(), "sample-scan.pdf");
}
