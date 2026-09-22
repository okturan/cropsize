import init, {
  RgbaFrame,
  clean_mask,
  measure_box,
  merge_rotated_rectangles,
  minimum_area_rect,
  minimum_area_rect_scaled,
  morphology,
  plan_layout,
} from "../generated/imaging-core/cropsize_imaging_core";

let initialising: Promise<unknown> | null = null;
let ready = false;

export async function initImagingCore(): Promise<void> {
  initialising ??= init();
  await initialising;
  ready = true;
}

/**
 * Copy browser-owned pixels into WebAssembly once, then keep every imaging call on that
 * allocation. `pixels_view()` is a live view over WASM memory rather than a returned copy.
 */
export async function frameInCore(image: ImageData): Promise<RgbaFrame> {
  await initImagingCore();
  return frameInReadyCore(image);
}

function frameInReadyCore(image: ImageData): RgbaFrame {
  if (!ready) throw new Error("the imaging core has not been initialised");
  const frame = new RgbaFrame(image.width, image.height);
  const pixels = frame.pixels_view();
  if (pixels.byteLength !== image.data.byteLength) {
    frame.free();
    throw new Error("the imaging core allocated the wrong frame size");
  }
  pixels.set(image.data);
  return frame;
}

function imageFromFrame(frame: RgbaFrame, width: number, height: number): ImageData {
  const view = frame.pixels_view();
  // The browser image has to outlive the temporary frame. This is the one egress copy;
  // operations performed repeatedly on the frame itself stay on the WASM allocation.
  return new ImageData(new Uint8ClampedArray(view), width, height);
}

export async function estimateSkew(image: ImageData): Promise<number> {
  const frame = await frameInCore(image);
  try {
    return frame.estimate_skew();
  } finally {
    frame.free();
  }
}

export interface CoreBox { x0: number; y0: number; x1: number; y1: number }

export async function snapEdges(
  image: ImageData, box: CoreBox, reach = 0.025, prominence = 6,
): Promise<CoreBox> {
  const frame = await frameInCore(image);
  try {
    const result = frame.snap_edges(
      box.x0, box.y0, box.x1, box.y1, reach, prominence,
    );
    return { x0: result[0]!, y0: result[1]!, x1: result[2]!, y1: result[3]! };
  } finally {
    frame.free();
  }
}

export async function cleanMask(mask: Float32Array, size: number): Promise<Float32Array> {
  await initImagingCore();
  return clean_mask(mask, size);
}

export async function trimImageToMask(
  image: ImageData, box: CoreBox, mask: Float32Array, size: number, maskBox: CoreBox,
): Promise<ImageData> {
  const frame = await frameInCore(image);
  try {
    frame.trim_mask(
      mask, size, box.x0, box.y0, box.x1, box.y1,
      maskBox.x0, maskBox.y0, maskBox.x1, maskBox.y1,
    );
    return imageFromFrame(frame, image.width, image.height);
  } finally {
    frame.free();
  }
}

export function applyTone(image: ImageData, clipLimit: number, stretch: boolean): ImageData {
  const frame = frameInReadyCore(image);
  try {
    frame.apply_tone(clipLimit, stretch);
    return imageFromFrame(frame, image.width, image.height);
  } finally {
    frame.free();
  }
}

export function measureBox(
  width: number, height: number, box: CoreBox, mmPerPx: number | null,
): [number, number] | null {
  if (!ready) throw new Error("the imaging core has not been initialised");
  const result = measure_box(
    width, height, box.x0, box.y0, box.x1, box.y1, mmPerPx ?? Number.NaN,
  );
  return result.length === 2 ? [result[0]!, result[1]!] : null;
}

export function planLayout(args: {
  width: number;
  height: number;
  box: CoreBox;
  mmPerPx: number | null;
  sheetMm: [number, number] | null;
  fit: 0 | 1 | 2;
  presetMm: [number, number];
  marginMm: number;
}): { contentMm: [number, number]; noteCode: 0 | 1 | 2 | 3 } {
  if (!ready) throw new Error("the imaging core has not been initialised");
  const { width, height, box, mmPerPx, sheetMm, fit, presetMm, marginMm } = args;
  const result = plan_layout(
    width, height, box.x0, box.y0, box.x1, box.y1, mmPerPx ?? Number.NaN,
    sheetMm?.[0] ?? Number.NaN, sheetMm?.[1] ?? Number.NaN,
    fit, presetMm[0], presetMm[1], marginMm,
  );
  return {
    contentMm: [result[2]!, result[3]!],
    noteCode: result[4]! as 0 | 1 | 2 | 3,
  };
}

export async function minimumAreaRect(
  mask: Float32Array, width: number, height: number,
): Promise<[number, number, number, number, number] | null> {
  await initImagingCore();
  const result = minimum_area_rect(mask, width, height);
  return result.length === 5
    ? [result[0]!, result[1]!, result[2]!, result[3]!, result[4]!]
    : null;
}

export async function minimumAreaRectScaled(
  mask: Float32Array, width: number, height: number, scaleX: number, scaleY: number,
): Promise<[number, number, number, number, number] | null> {
  await initImagingCore();
  const result = minimum_area_rect_scaled(mask, width, height, scaleX, scaleY);
  return result.length === 5
    ? [result[0]!, result[1]!, result[2]!, result[3]!, result[4]!]
    : null;
}

export async function closeMask(
  mask: Float32Array, width: number, height: number, radius: number,
): Promise<Float32Array> {
  await initImagingCore();
  const binary = Uint8Array.from(mask, value => value > 0 ? 255 : 0);
  const closed = morphology(binary, width, height, radius, 2);
  return Float32Array.from(closed, value => value > 0 ? 1 : -1);
}

export async function extractRotated(
  image: ImageData, rect: [number, number, number, number, number],
): Promise<ImageData> {
  const frame = await frameInCore(image);
  let extracted: RgbaFrame | null = null;
  try {
    extracted = frame.extract_rotated(...rect);
    return imageFromFrame(extracted, Math.max(1, Math.round(rect[2])), Math.max(1, Math.round(rect[3])));
  } finally {
    extracted?.free();
    frame.free();
  }
}

export async function refineRotatedRect(
  image: ImageData, rect: [number, number, number, number, number],
): Promise<[number, number, number, number, number]> {
  const frame = await frameInCore(image);
  try {
    const result = frame.refine_rotated_rect(...rect);
    return [result[0]!, result[1]!, result[2]!, result[3]!, result[4]!];
  } finally {
    frame.free();
  }
}

export async function mergeRotatedRectangles(
  rectangles: [number, number, number, number, number][],
): Promise<[number, number, number, number, number]> {
  await initImagingCore();
  const result = merge_rotated_rectangles(Float64Array.from(rectangles.flat()));
  if (result.length !== 5) throw new Error("at least one rectangle is required");
  return [result[0]!, result[1]!, result[2]!, result[3]!, result[4]!];
}

export type { RgbaFrame };

/** A card's four fitted edges: corners top-left, top-right, bottom-right, bottom-left. */
export interface CardEdges {
  quad: [number, number, number, number, number, number, number, number];
  /** per side, top, right, bottom, left: scatter of the edge points about the line, pixels */
  scatter: [number, number, number, number];
  /** per side: the fraction of measured points that agreed with the fitted line */
  agreement: [number, number, number, number];
}

/** Fit a card's edges inside a rough box in pixels, in a frame straightened by `turn`. */
export async function fitCardEdges(
  image: ImageData, box: [number, number, number, number], turn: number,
): Promise<CardEdges | null> {
  const frame = await frameInCore(image);
  try {
    const out = frame.fit_card(box[0], box[1], box[2], box[3], turn);
    if (out.length !== 16) return null;
    const v = Array.from(out);
    return {
      quad: v.slice(0, 8) as CardEdges["quad"],
      scatter: v.slice(8, 12) as CardEdges["scatter"],
      agreement: v.slice(12, 16) as CardEdges["agreement"],
    };
  } finally {
    frame.free();
  }
}

/** Square up a quadrilateral into a width by height image, then round its corners starting
 *  from `radius` pixels, each corner measured on its own. */
export async function squareUpCard(
  image: ImageData, quad: readonly number[], width: number, height: number, radius: number,
): Promise<{ image: ImageData; radii: number[] }> {
  const frame = await frameInCore(image);
  let card: RgbaFrame | undefined;
  try {
    card = frame.warp_quad(Float64Array.from(quad), width, height);
    const radii = radius > 0 ? Array.from(card.round_card_corners(radius)) : [];
    return { image: imageFromFrame(card, width, height), radii };
  } finally {
    card?.free();
    frame.free();
  }
}
