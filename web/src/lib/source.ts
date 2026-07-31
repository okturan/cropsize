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

export interface Scan {
  image: ImageData;
  /** millimetres per pixel of `image`, or null when the source carries no scale */
  mmPerPx: number | null;
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

    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = pageCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;

    return {
      image: toImageData(canvas),
      mmPerPx: 25.4 / dpi,
      pageMm,
      dpi,
      origin: `PDF page ${index + 1} of ${doc.numPages}, ${pageMm[0]} by ${pageMm[1]} mm, rendered at ${dpi} dpi`,
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

export async function loadRaster(file: Blob, name: string): Promise<DocumentSource> {
  const bitmap = await createImageBitmap(file);
  const canvas = pageCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // A raster file carries no reliable scale in the browser: PNG pHYs and JPEG EXIF
  // resolution are not exposed to canvas, so true size is unavailable and the UI says so.
  const scan: Scan = {
    image: toImageData(canvas),
    mmPerPx: null,
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
