/**
 * A fitted document: its four measured corners, and how the output uses them.
 *
 * - An ID-1 card (ID card, residence permit, bank card, driving licence) whose four edges were
 *   all measured is squared up at exact 85.6 by 54 mm proportions, each corner rounded to the
 *   radius measured on it.
 * - Any other document is squared up to its own proportions, worked out from the perspective
 *   its corners show, which removes a phone's tilt without squashing the page.
 * - A document already square to the frame (a flatbed scan) is not given a fit at all: its
 *   box is cropped as before, source pixels untouched, and no resampling happens.
 */
import type { DetectResult } from "./detect";
import { squareUp } from "./imaging-core";

export const ID1_MM = [85.6, 54] as const;
const ID1_RATIO = ID1_MM[0] / ID1_MM[1];
const ID1_RADIUS_MM = 3.18;
/** Corners this close to their box's corners, in pixels, need no warp. */
const SQUARE_PX = 1.5;

/** Corners normalised 0..1: top-left, top-right, bottom-right, bottom-left. */
export interface Fit {
  quad: number[];
  /** the document's own width over height, the perspective taken out */
  aspect: number;
  /** an ID-1 card: exact proportions and rounded corners */
  card: boolean;
}

const toPixels = (quad: number[], width: number, height: number) =>
  quad.map((v, i) => v * (i % 2 === 0 ? width : height));

/** Lengths of the top, right, bottom and left sides. */
function sideLengths(q: number[]): [number, number, number, number] {
  const side = (i: number, j: number) => Math.hypot(q[2 * j]! - q[2 * i]!, q[2 * j + 1]! - q[2 * i + 1]!);
  return [side(0, 1), side(1, 2), side(3, 2), side(0, 3)];
}

/** A phone's main camera, about 26 mm equivalent: focal length over the frame's diagonal. */
const PHONE_FOCAL = 0.6;

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A photographed rectangle's corners in Zhang and He's form: n2 and n3 are its top and left
 * sides carried back through the perspective, up to one scale. The principal point is the
 * photo's centre; straightening turns about the centre, so it stays there.
 */
function sides3d(q: number[]): { n2: Vec3; n3: Vec3 } | null {
  const m = (i: number): Vec3 => [q[2 * i]!, q[2 * i + 1]!, 1];
  const [m1, m2, m4, m3] = [m(0), m(1), m(2), m(3)];      // top-left, top-right, bottom-right, bottom-left
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
  return {
    n2: m2.map((v, i) => k2 * v - m1[i]!) as Vec3,
    n3: m3.map((v, i) => k3 * v - m1[i]!) as Vec3,
  };
}

/** The focal length the corners themselves fix, in pixels, or null when they cannot: when a
 *  pair of sides runs (nearly) parallel, as in a straight-on or a purely tipped view. */
function focalFromCorners(q: number[], width: number, height: number): number | null {
  const s = sides3d(q);
  if (!s || Math.abs(s.n2[2]) < 0.02 || Math.abs(s.n3[2]) < 0.02) return null;
  const { n2, n3 } = s;
  const [u0, v0] = [width / 2, height / 2];
  const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0)
    + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
  const diagonal = Math.hypot(width, height);
  return f2 > (0.3 * diagonal) ** 2 && f2 < (3 * diagonal) ** 2 ? Math.sqrt(f2) : null;
}

/**
 * The document's width over height, the perspective taken out, for a camera of focal length
 * `f` pixels: Zhang and He's method for a photographed rectangle. A flatbed scan has no
 * perspective, and its answer is the ratio of its sides whatever `f` is.
 */
function aspectAt(q: number[], width: number, height: number, f: number): number {
  const [top, right, bottom, left] = sideLengths(q);
  const naive = (top + bottom) / Math.max(1e-9, right + left);
  const s = sides3d(q);
  if (!s) return naive;
  const [u0, v0] = [width / 2, height / 2];
  const norm = (n: Vec3) => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / (f * f) + n[2] * n[2];
  const aspect = Math.sqrt(norm(s.n2) / norm(s.n3));
  // corners this far from a rectangle in any view are not one; keep the plain ratio
  return Number.isFinite(aspect) && Math.abs(Math.log(aspect / naive)) < 0.35 ? aspect : naive;
}

const ratioOff = (aspect: number) => Math.abs(Math.max(aspect, 1 / aspect) - ID1_RATIO) / ID1_RATIO;

/** Whether the corners already form an upright rectangle, to within SQUARE_PX. */
function squareToFrame(q: number[]): boolean {
  const x0 = Math.min(q[0]!, q[6]!), x1 = Math.max(q[2]!, q[4]!);
  const y0 = Math.min(q[1]!, q[3]!), y1 = Math.max(q[5]!, q[7]!);
  const box = [x0, y0, x1, y0, x1, y1, x0, y1];
  return q.every((v, i) => Math.abs(v - box[i]!) <= SQUARE_PX);
}

/**
 * The fit a detection calls for, or null when the plain box crop is already right. `focal` is
 * the camera's focal length in pixels when the photo recorded it: it fixes how much a tipped
 * page is foreshortened, which the corners alone cannot always say.
 */
export function fitFor(result: DetectResult, image: ImageData, focal: number | null = null): Fit | null {
  if (result.whole) return null;
  const { width, height } = image;
  const q = toPixels(result.quad, width, height);
  const diagonal = Math.hypot(width, height);
  const f = focal ?? focalFromCorners(q, width, height);
  const aspect = aspectAt(q, width, height, f ?? PHONE_FOCAL * diagonal);
  // One lens only: tipped steeply enough, a page through some other lens can look exactly
  // like a card, and a page printed at card size is the worse mistake.
  const measured = result.kinds.every(k => k === "edge" || k === "outer-edge");
  const card = measured && ratioOff(aspect) <= 0.04;
  if (!card && squareToFrame(q)) return null;
  return { quad: result.quad, aspect: card ? (aspect >= 1 ? ID1_RATIO : 1 / ID1_RATIO) : aspect, card };
}

/** The document squared up; for a card, exact ID-1 proportions and rounded corners. The
 *  radii used are returned too, top-left clockwise, in output pixels. */
export async function extractFit(
  image: ImageData, fit: Fit,
): Promise<{ image: ImageData; radii: number[] }> {
  const q = toPixels(fit.quad, image.width, image.height);
  // The nearer, longer side of each pair keeps its resolution; the other follows the
  // proportions. Without perspective the two sides of a pair are the same length anyway.
  const [top, right, bottom, left] = sideLengths(q);
  let width = Math.max(top, bottom), height = Math.max(left, right);
  if (width / height > fit.aspect) height = width / fit.aspect;
  else width = height * fit.aspect;
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const radius = fit.card ? (ID1_RADIUS_MM / ID1_MM[0]) * Math.max(width, height) : 0;
  return squareUp(image, q, width, height, radius);
}

/** A quarter turn of the frame moves the corners; re-label them so top-left stays top-left. */
export function turnFit(fit: Fit, quarters: number): Fit {
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
  return { ...fit, quad: ordered.flat(), aspect: k % 2 ? 1 / fit.aspect : fit.aspect };
}
