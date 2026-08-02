/** Turning a SAM mask into a crop box; pixel and geometry cleanup lives in the core. */
import { Sam } from "./sam";
import type { LoadProgress } from "./model-loader";
import { cleanMask, snapEdges } from "./imaging-core";

export interface Box { x0: number; y0: number; x1: number; y1: number }   // normalised

export interface DetectResult {
  box: Box;
  score: number;
  note: string;
  /** the winning mask, kept so the rounded corners can be trimmed later */
  mask: Float32Array;
  maskSize: number;
}

function maskBounds(mask: Float32Array, size: number): Box | null {
  let x0 = size, y0 = size, x1 = -1, y1 = -1, on = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((mask[y * size + x] ?? -1) > 0) {
        on++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || on / (size * size) < 0.02) return null;
  return { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size };
}

const area = (box: Box) => (box.x1 - box.x0) * (box.y1 - box.y0);

export async function detect(
  sam: Sam, img: ImageData, onProgress: (p: LoadProgress) => void,
): Promise<DetectResult> {
  await sam.ready(onProgress);
  const embeddings = await sam.encode(img);
  const { width, height } = img;

  const boxPrompt: [number, number, number, number] = [
    width * 0.04, height * 0.04, width * 0.96, height * 0.96,
  ];
  let result = await sam.decode(embeddings, { box: boxPrompt });
  let bounds = maskBounds(result.mask, result.size);
  let how = "box prompt";

  // A near-full-frame answer is usually the platen. Ask at the centre and prefer that
  // answer only when it isolates a smaller object.
  if (!bounds || area(bounds) > 0.85) {
    const alternative = await sam.decode(embeddings, {
      points: [[width / 2, height / 2, 1]],
    });
    const alternativeBounds = maskBounds(alternative.mask, alternative.size);
    if (alternativeBounds && area(alternativeBounds) < 0.85) {
      result = alternative;
      bounds = alternativeBounds;
      how = "centre point, the box prompt found the whole frame";
    }
  }
  if (!bounds) throw new Error("nothing found in this scan");

  return {
    box: await snapEdges(img, bounds),
    score: result.score,
    note: `${how}, score ${result.score.toFixed(3)}`,
    mask: await cleanMask(result.mask, result.size),
    maskSize: result.size,
  };
}
