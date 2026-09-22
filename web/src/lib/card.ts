/**
 * When a detected document is an ID-1 card (ID card, residence permit, bank card, driving
 * licence), measure its edges at full resolution and square it up, instead of cutting an
 * upright box around it. See core/crates/imaging-core/src/card.rs for the method.
 *
 * The fit is used only when every side agrees with itself; otherwise the crop falls back to
 * the box, which is never worse than before.
 */
import type { Box } from "./detect";
import { fitCardEdges, squareUpCard } from "./imaging-core";

export const ID1_MM = [85.6, 54] as const;
const ID1_RATIO = ID1_MM[0] / ID1_MM[1];
const ID1_RADIUS_MM = 3.18;

/** A fitted card, corners normalised 0..1: top-left, top-right, bottom-right, bottom-left. */
export interface CardFit { quad: number[] }

const ratioOff = (w: number, h: number) =>
  Math.abs(Math.max(w, h) / Math.max(1, Math.min(w, h)) - ID1_RATIO) / ID1_RATIO;

/** Whether a box in this image is shaped like an ID-1 card, allowing for a tilted phone. */
export function looksLikeCard(image: ImageData, box: Box): boolean {
  return ratioOff((box.x1 - box.x0) * image.width, (box.y1 - box.y0) * image.height) <= 0.08;
}

export async function fitCard(image: ImageData, box: Box, turn: number): Promise<CardFit | null> {
  if (!looksLikeCard(image, box)) return null;
  const { width: w, height: h } = image;
  const px: [number, number, number, number] = [box.x0 * w, box.y0 * h, box.x1 * w, box.y1 * h];
  const edges = await fitCardEdges(image, px, turn);
  if (!edges) return null;
  if (edges.scatter.some(sd => sd > 2.5) || edges.agreement.some(share => share < 0.6)) return null;
  const q = edges.quad;
  const side = (i: number, j: number) => Math.hypot(q[2 * j]! - q[2 * i]!, q[2 * j + 1]! - q[2 * i + 1]!);
  const width = (side(0, 1) + side(3, 2)) / 2;
  const height = (side(0, 3) + side(1, 2)) / 2;
  if (ratioOff(width, height) > 0.04) return null;
  // Every corner must stay near the model's box: a fit that wandered found something else.
  const reach = (Math.max(px[2] - px[0], px[3] - px[1]) / ID1_MM[0]) * 4;
  const boxCorners = [px[0], px[1], px[2], px[1], px[2], px[3], px[0], px[3]];
  if (q.some((v, i) => Math.abs(v - boxCorners[i]!) > reach)) return null;
  return { quad: q.map((v, i) => v / (i % 2 === 0 ? w : h)) };
}

/** The card squared up at exact ID-1 proportions, its corners rounded as measured; the
 *  radii used are returned too, top-left clockwise, in output pixels. */
export async function extractCard(
  image: ImageData, fit: CardFit,
): Promise<{ image: ImageData; radii: number[] }> {
  const q = fit.quad.map((v, i) => v * (i % 2 === 0 ? image.width : image.height));
  const side = (i: number, j: number) => Math.hypot(q[2 * j]! - q[2 * i]!, q[2 * j + 1]! - q[2 * i + 1]!);
  const measuredWidth = (side(0, 1) + side(3, 2)) / 2;
  const measuredHeight = (side(0, 3) + side(1, 2)) / 2;
  const landscape = measuredWidth >= measuredHeight;
  const long = Math.round(Math.max(measuredWidth, measuredHeight));
  const short = Math.round(long / ID1_RATIO);
  const [width, height] = landscape ? [long, short] : [short, long];
  return squareUpCard(image, q, width, height, (ID1_RADIUS_MM / ID1_MM[0]) * long);
}

/** A quarter turn of the frame moves the corners; re-label them so top-left stays top-left. */
export function turnCard(fit: CardFit, quarters: number): CardFit {
  const k = ((quarters % 4) + 4) % 4;
  const points: [number, number][] = [];
  for (let i = 0; i < 4; i++) {
    let [x, y] = [fit.quad[2 * i]!, fit.quad[2 * i + 1]!];
    for (let n = 0; n < k; n++) [x, y] = [1 - y, x];       // one clockwise quarter turn
    points.push([x, y]);
  }
  // top-left is the corner nearest the origin; the rest follow clockwise
  const start = points.reduce((best, p, i) => (p[0] + p[1] < points[best]![0] + points[best]![1] ? i : best), 0);
  const ordered = [0, 1, 2, 3].map(i => points[(start + i) % 4]!);
  return { quad: ordered.flat() };
}
