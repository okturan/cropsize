import {
  cleanMask, closeMask, extractRotated, minimumAreaRectScaled, refineRotatedRect,
  mergeRotatedRectangles,
} from "./imaging-core";
import { Sam } from "./sam";
import type { LoadProgress } from "./model-loader";

export interface ObjectCandidate {
  id: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;
  mask: Float32Array;
  maskSize: number;
  alternatives: ObjectCandidate[];
  choices?: ObjectCandidate[];
  choiceIndex?: number;
  mergedParts?: ObjectCandidate[];
}

let nextId = 1;

function bareCandidate(candidate: ObjectCandidate): ObjectCandidate {
  return {
    ...candidate,
    alternatives: [],
    choices: undefined,
    choiceIndex: undefined,
    mergedParts: undefined,
  };
}

export async function candidateFromMask(
  mask: Float32Array,
  size: number,
  imageWidth: number,
  imageHeight: number,
  score: number,
): Promise<ObjectCandidate | null> {
  const closed = await closeMask(mask, size, size, 7);
  let on = 0;
  for (const value of closed) if (value > 0) on++;
  const fraction = on / (size * size);
  if (fraction <= 0.015 || fraction >= 0.92) return null;

  const rect = await minimumAreaRectScaled(
    closed, size, size, imageWidth / size, imageHeight / size,
  );
  if (!rect) return null;
  const [cx, cy, width, height, angle] = rect;
  if (width < 8 || height < 8) return null;
  const rectangularity = (on * (imageWidth / size) * (imageHeight / size)) / (width * height);
  const aspect = width / height;
  if (rectangularity < 0.82 || aspect <= 0.12 || aspect >= 8) return null;

  return {
    id: nextId++,
    cx: cx / imageWidth,
    cy: cy / imageHeight,
    width: width / imageWidth,
    height: height / imageHeight,
    angle,
    score,
    mask: await cleanMask(mask, size),
    maskSize: size,
    alternatives: [],
  };
}

const bounds = (item: ObjectCandidate) => ({
  x0: item.cx - item.width / 2,
  y0: item.cy - item.height / 2,
  x1: item.cx + item.width / 2,
  y1: item.cy + item.height / 2,
});

function intersection(a: ObjectCandidate, b: ObjectCandidate): number {
  const aa = bounds(a), bb = bounds(b);
  return Math.max(0, Math.min(aa.x1, bb.x1) - Math.max(aa.x0, bb.x0))
    * Math.max(0, Math.min(aa.y1, bb.y1) - Math.max(aa.y0, bb.y0));
}

export function groupCandidates(candidates: ObjectCandidate[]): ObjectCandidate[][] {
  const groups: ObjectCandidate[][] = [];
  const sorted = [...candidates].sort((a, b) => (b.score - a.score)
    || (b.width * b.height - a.width * a.height));
  for (const candidate of sorted) {
    const area = candidate.width * candidate.height;
    let placed = false;
    for (const group of groups) {
      const primary = group[0]!;
      const overlap = intersection(candidate, primary);
      const primaryArea = primary.width * primary.height;
      const union = area + primaryArea - overlap;
      const iou = union > 0 ? overlap / union : 0;
      const containment = Math.min(area, primaryArea) > 0
        ? overlap / Math.min(area, primaryArea) : 0;
      if (iou > 0.45 || containment > 0.75) {
        group.push(candidate);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([candidate]);
  }
  return groups;
}

export async function findObjectGroups(
  sam: Sam,
  image: ImageData,
  onProgress: (progress: LoadProgress) => void,
  grid = 8,
  minimumScore = 0.8,
  maximumObjects = 16,
): Promise<ObjectCandidate[][]> {
  await sam.ready(onProgress);
  onProgress({
    fraction: 0,
    loadedBytes: 0,
    totalBytes: 0,
    status: "encoding the scan once for several-item detection",
  });
  const embeddings = await sam.encode(image);
  const candidates: ObjectCandidate[] = [];
  const total = grid * grid;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const index = y * grid + x;
      onProgress({
        fraction: index / total,
        loadedBytes: 0,
        totalBytes: 0,
        status: `checking item prompts, ${index + 1} of ${total}`,
      });
      const proposals = await sam.decodeAll(embeddings, {
        points: [[(x + 0.5) / grid * image.width, (y + 0.5) / grid * image.height, 1]],
      });
      for (const proposal of proposals) {
        if (proposal.score < minimumScore) continue;
        const candidate = await candidateFromMask(
          proposal.mask, proposal.size, image.width, image.height, proposal.score,
        );
        if (candidate) candidates.push(candidate);
      }
    }
  }
  const groups = groupCandidates(candidates).slice(0, maximumObjects);
  for (const group of groups) {
    const primary = group[0]!;
    const refined = await refineObject(image, primary);
    const choices = [bareCandidate(refined), ...group.slice(1).map(bareCandidate)];
    refined.choices = choices;
    refined.choiceIndex = 0;
    refined.alternatives = choices.slice(1);
    group[0] = refined;
  }
  return groups;
}

export async function refineObject(
  image: ImageData, item: ObjectCandidate,
): Promise<ObjectCandidate> {
  const refined = await refineRotatedRect(image, [
    item.cx * image.width,
    item.cy * image.height,
    item.width * image.width,
    item.height * image.height,
    item.angle,
  ]);
  return {
    ...item,
    cx: refined[0] / image.width,
    cy: refined[1] / image.height,
    width: refined[2] / image.width,
    height: refined[3] / image.height,
    angle: refined[4],
  };
}

export function measuredObject(
  item: ObjectCandidate, image: ImageData, mmPerPx: number | null,
): [number, number] | null {
  if (!mmPerPx) return null;
  return [
    Math.round(item.width * image.width * mmPerPx * 10) / 10,
    Math.round(item.height * image.height * mmPerPx * 10) / 10,
  ];
}

export async function extractObject(image: ImageData, item: ObjectCandidate): Promise<ImageData> {
  return extractRotated(image, [
    item.cx * image.width,
    item.cy * image.height,
    item.width * image.width,
    item.height * image.height,
    item.angle,
  ]);
}

export async function mergeObjects(
  image: ImageData, items: ObjectCandidate[],
): Promise<ObjectCandidate> {
  if (items.length < 2) throw new Error("select at least two items to merge");
  const rect = await mergeRotatedRectangles(items.map(item => [
    item.cx * image.width,
    item.cy * image.height,
    item.width * image.width,
    item.height * image.height,
    item.angle,
  ]));
  return {
    id: nextId++,
    cx: rect[0] / image.width,
    cy: rect[1] / image.height,
    width: rect[2] / image.width,
    height: rect[3] / image.height,
    angle: rect[4],
    score: Math.min(...items.map(item => item.score)),
    mask: new Float32Array(),
    maskSize: 0,
    alternatives: [],
    mergedParts: items,
  };
}
