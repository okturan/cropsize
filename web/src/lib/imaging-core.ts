import init, { RgbaFrame } from "../generated/imaging-core/cropsize_imaging_core";

let initialising: Promise<unknown> | null = null;

export async function initImagingCore(): Promise<void> {
  initialising ??= init();
  await initialising;
}

/**
 * Copy browser-owned pixels into WebAssembly once, then keep every imaging call on that
 * allocation. `pixels_view()` is a live view over WASM memory rather than a returned copy.
 */
export async function frameInCore(image: ImageData): Promise<RgbaFrame> {
  await initImagingCore();
  const frame = new RgbaFrame(image.width, image.height);
  const pixels = frame.pixels_view();
  if (pixels.byteLength !== image.data.byteLength) {
    frame.free();
    throw new Error("the imaging core allocated the wrong frame size");
  }
  pixels.set(image.data);
  return frame;
}

export async function estimateSkew(image: ImageData): Promise<number> {
  const frame = await frameInCore(image);
  try {
    return frame.estimate_skew();
  } finally {
    frame.free();
  }
}

export type { RgbaFrame };
