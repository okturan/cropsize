/** Turning a SAM mask into a crop box; pixel and geometry cleanup lives in the core. */
import { Sam, type DecodedMask, type Embeddings } from "./sam";
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

interface MaskShape {
  box: Box;
  /** fraction of the frame the mask covers */
  area: number;
  /** how much of its own bounding box the mask fills; a document is close to 1 */
  rectangularity: number;
}

function maskShape(mask: Float32Array, size: number): MaskShape | null {
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
  return {
    box: { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size },
    area: on / (size * size),
    rectangularity: on / ((x1 - x0 + 1) * (y1 - y0 + 1)),
  };
}

const area = (box: Box) => (box.x1 - box.x0) * (box.y1 - box.y0);

function iou(a: Box, b: Box): number {
  const overlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
    * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const union = area(a) + area(b) - overlap;
  return union > 0 ? overlap / union : 0;
}

/** Sides of the box lying on the frame edge; three or four means the frame, not a thing in it. */
function edgesTouched(box: Box, reach = 0.015): number {
  return [box.x0, box.y0, 1 - box.x1, 1 - box.y1].filter(distance => distance <= reach).length;
}

interface Candidate extends MaskShape { decoded: DecodedMask }

/**
 * Whether a mask could be the document rather than the surface it lies on or a detail of it.
 * Shape carries this decision, not the model's own score: on a phone photo of an ID card the
 * card comes back with an IoU score of 0.004 from one prompt and 0.99 from the next, while its
 * rectangularity is above 0.96 every time.
 */
const documentLike = (shape: MaskShape) =>
  shape.area <= 0.85 && shape.rectangularity >= 0.88 && edgesTouched(shape.box) < 3;

/**
 * Ask for the document from many places at once and let the answers vote.
 *
 * A single point in the middle of a card lands on the smoothest part of it, and the
 * highest-scoring mask for that point is a speck of text rather than the card. Points spread
 * over the frame each propose three masks; the ones shaped like a document are grouped by
 * overlap, and the group proposed from the most places wins. Everything is one encode; the
 * dozen decodes cost well under a second.
 */
async function voteForDocument(
  sam: Sam, embeddings: Embeddings, width: number, height: number,
): Promise<Candidate | null> {
  const prompts: Parameters<Sam["decodeAll"]>[1][] = [
    { box: [width * 0.10, height * 0.10, width * 0.90, height * 0.90] },
    { box: [width * 0.20, height * 0.20, width * 0.80, height * 0.80] },
  ];
  const grid = 3;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      prompts.push({ points: [[(gx + 0.5) / grid * width, (gy + 0.5) / grid * height, 1]] });
    }
  }
  const candidates: Candidate[] = [];
  for (const prompt of prompts) {
    for (const decoded of await sam.decodeAll(embeddings, prompt)) {
      const shape = maskShape(decoded.mask, decoded.size);
      if (shape && documentLike(shape)) candidates.push({ ...shape, decoded });
    }
  }
  const groups: Candidate[][] = [];
  for (const candidate of candidates) {
    const group = groups.find(members => iou(members[0]!.box, candidate.box) >= 0.8);
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const winner = groups.sort((a, b) =>
    (b.length - a.length) || (area(b[0]!.box) - area(a[0]!.box)))[0];
  if (!winner) return null;
  return winner.reduce((best, member) => {
    const better = (member.rectangularity - best.rectangularity)
      || (member.decoded.score - best.decoded.score);
    return better > 0 ? member : best;
  });
}

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
  let shape = maskShape(result.mask, result.size);
  let how = "box prompt";

  // A near-full-frame or ragged answer is the platen, the desk or the sheet of paper the
  // document was photographed on. Look for a document-shaped thing inside it instead.
  if (!shape || !documentLike(shape)) {
    const voted = await voteForDocument(sam, embeddings, width, height);
    // A photo taken tight on a card is the other case: the frame is the document, and the
    // only smaller rectangles in it are its chip, photo or QR code. A rectangular
    // full-frame answer keeps its place against a winner that small.
    const detail = voted && shape && shape.rectangularity >= 0.88
      && area(voted.box) < 0.06;
    if (voted && !detail) {
      result = voted.decoded;
      shape = voted;
      how = "voted from several prompts, the box prompt found the whole frame";
    }
  }
  if (!shape) throw new Error("nothing found in this scan");

  // The mask is only precise to one of its own pixels, and it stops at the printed area
  // when a card's pale rim reads as background, so it sits a little inside the physical
  // edge. Half a mask pixel of bleed keeps the rim and the rounded corners; the edge snap
  // still pulls the box onto a real edge where there is one.
  const bleed = 0.5 / result.size;
  const bled: Box = {
    x0: Math.max(0, shape.box.x0 - bleed),
    y0: Math.max(0, shape.box.y0 - bleed),
    x1: Math.min(1, shape.box.x1 + bleed),
    y1: Math.min(1, shape.box.y1 + bleed),
  };

  return {
    box: await snapEdges(img, bled),
    score: result.score,
    note: `${how}, score ${result.score.toFixed(3)}`,
    mask: await cleanMask(result.mask, result.size),
    maskSize: result.size,
  };
}
