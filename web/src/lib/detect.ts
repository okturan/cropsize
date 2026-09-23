/**
 * Finding the document: which region of the photo it is, then exactly where its four edges run.
 *
 * The model answers "which pixels belong to the thing I pointed at", from a 256 by 256 view.
 * It has no idea what a document is, so its answer is weighed here against a map of where the
 * photo has print, and the decisions it cannot make are made explicitly:
 *
 * - the box prompt's answer is the document when it is shaped like one;
 * - a larger answer that adds a band of print (an ornamental border) is the whole certificate;
 * - a ragged answer is replaced by a clean rectangle the model also offered (a whole card);
 * - otherwise several prompts vote, ignoring blank regions (the gap between two cards);
 * - a winner inside a larger candidate that has plain surround is one page of a spread;
 * - a winner with print running on past it is part of a page that fills the frame (a form's
 *   table), so the whole frame is kept.
 *
 * The region then goes to the core, which measures each edge at full resolution (see
 * core/crates/imaging-core/src/document.rs). Every rule was tuned by eye on 36 real documents.
 */
import { Sam, type DecodedMask, type Embeddings, type Prompt } from "./sam";
import { cleanMask, DocumentFrame, type PrintMapData, type SideKind } from "./imaging-core";
import { silent, type Report } from "./progress";

export interface Box { x0: number; y0: number; x1: number; y1: number }   // normalised

export interface DetectResult {
  /** the box around the fitted document, normalised */
  box: Box;
  /** corners top-left, top-right, bottom-right, bottom-left, normalised 0..1 */
  quad: number[];
  /** how each side, top, right, bottom, left, was found */
  kinds: SideKind[];
  /** the document is the whole photo */
  whole: boolean;
  score: number;
  /** "frame": the box prompt found it; "vote": several prompts voted; "page": the document
   *  fills the photo */
  method: "frame" | "vote" | "page";
  /** the model's mask for the region, for trimming a hand-drawn crop; empty when whole */
  mask: Float32Array;
  maskSize: number;
}

/* ---------------------------------------------------------------------- the outline */

/** A side as a line: across = a + b (along - t). Top and bottom run along x, left and right
 *  along y. */
interface Line { a: number; b: number; t: number }

function median(values: number[]): number {
  const sorted = values.slice().sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Theil and Sen's line through (along, across) points: the median of the pairwise slopes,
 *  which a ragged stretch of mask cannot pull over, with the points' median distance from it.
 *  Null when the points cannot say. */
function robustLine(all: [number, number][], t: number, minGap: number): (Line & { scatter: number }) | null {
  const every = Math.ceil(all.length / 96);
  const points = every > 1 ? all.filter((_, i) => i % every === 0) : all;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = points[j]![0] - points[i]![0];
      if (Math.abs(d) >= minGap) slopes.push((points[j]![1] - points[i]![1]) / d);
    }
  }
  if (points.length < 8 || slopes.length < 8) return null;
  const b = median(slopes);
  const a = median(points.map(([along, across]) => across - b * (along - t)));
  const scatter = median(points.map(([along, across]) => Math.abs(across - a - b * (along - t))));
  return { a, b, t, scatter };
}

/** Where a horizontal side meets a vertical one. */
function meet(h: Line, v: Line): [number, number] {
  const x = (v.a + v.b * (h.a - h.b * h.t - v.t)) / (1 - h.b * v.b);
  return [x, h.a + h.b * (x - h.t)];
}

/** Tilted this little, a side's box edge stays inside the core's search band all along the
 *  side (a band of 1.2% of its length, either way): about 1 degree. */
const BOX_TILT = 0.02;
/** Steeper than this is not a document side seen at an angle (about 24 degrees). */
const MAX_TILT = 0.45;

/**
 * The model's outline as a quadrilateral in pixels, corners top-left, top-right,
 * bottom-right, bottom-left. A side stays on the mask's bounding box, where the core's own
 * search finds it, unless the mask's boundary runs tilted beyond BOX_TILT, straight and tight:
 * a document photographed at an angle. That side then starts out along its tilt, fitted
 * through the boundary with the rounded corners left out. Only a document lying wholly
 * inside the photo is outlined so: one that runs off it is found by what it holds, and the
 * mask follows its text there, whose lines are as straight as any edge.
 */
function outline(mask: Float32Array, size: number, box: Box, width: number, height: number): number[] {
  const x0 = Math.round(box.x0 * size), x1 = Math.round(box.x1 * size);
  const y0 = Math.round(box.y0 * size), y1 = Math.round(box.y1 * size);
  const on = (x: number, y: number) => (mask[y * size + x] ?? -1) > 0;
  const tx = (x0 + x1) / 2, ty = (y0 + y1) / 2;
  const my = Math.floor(0.15 * (y1 - y0)), mx = Math.floor(0.15 * (x1 - x0));
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let y = y0 + my; y < y1 - my; y++) {
    let first = -1, last = -1;
    for (let x = x0; x < x1; x++) {
      if (on(x, y)) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      left.push([y + 0.5, first]);
      right.push([y + 0.5, last + 1]);
    }
  }
  const top: [number, number][] = [], bottom: [number, number][] = [];
  for (let x = x0 + mx; x < x1 - mx; x++) {
    let first = -1, last = -1;
    for (let y = y0; y < y1; y++) {
      if (on(x, y)) {
        if (first < 0) first = y;
        last = y;
      }
    }
    if (first >= 0) {
      top.push([x + 0.5, first]);
      bottom.push([x + 0.5, last + 1]);
    }
  }
  // fitted in mask cells, then scaled to pixels; a cell is width/size by height/size
  const sx = width / size, sy = height / size;
  const inside = edgesTouched(box) === 0;
  const side = (points: [number, number][], t: number, fallback: number, horizontal: boolean): Line => {
    const gap = Math.max(4, 0.2 * (horizontal ? x1 - x0 : y1 - y0));
    const line = robustLine(points, t, gap);
    const [along, across] = horizontal ? [sx, sy] : [sy, sx];
    const tilt = line ? Math.abs(line.b * across / along) : 0;
    if (!inside || !line || tilt <= BOX_TILT || tilt > MAX_TILT || line.scatter > 1) {
      return { a: fallback * across, b: 0, t: t * along };
    }
    return { a: line.a * across, b: (line.b * across) / along, t: t * along };
  };
  const t = side(top, tx, y0, true), b = side(bottom, tx, y1, true);
  const l = side(left, ty, x0, false), r = side(right, ty, x1, false);
  return [...meet(t, l), ...meet(t, r), ...meet(b, r), ...meet(b, l)];
}

interface MaskShape {
  box: Box;
  /** fraction of the frame the mask covers */
  area: number;
  /** how much of its own bounding box the mask fills; a document square to the frame is
   *  close to 1 */
  rectangularity: number;
  /** how well the mask and its own outline agree, their overlap over their union: close to
   *  1 for a document seen at an angle too, where the bounding box takes in wedges of desk */
  fill: number;
}

/** Overlap over union of a mask and a quadrilateral in mask cells. */
function quadAgreement(mask: Float32Array, size: number, q: number[]): number {
  const turn = Math.sign(
    q[0]! * q[3]! - q[2]! * q[1]! + q[2]! * q[5]! - q[4]! * q[3]!
    + q[4]! * q[7]! - q[6]! * q[5]! + q[6]! * q[1]! - q[0]! * q[7]!) || 1;
  let both = 0, either = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [px, py] = [x + 0.5, y + 0.5];
      let inside = true;
      for (let i = 0; i < 4 && inside; i++) {
        const [ax, ay, bx, by] = [q[2 * i]!, q[2 * i + 1]!, q[(2 * i + 2) % 8]!, q[(2 * i + 3) % 8]!];
        inside = turn * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) >= 0;
      }
      const on = (mask[y * size + x] ?? -1) > 0;
      if (on && inside) both++;
      if (on || inside) either++;
    }
  }
  return either ? both / either : 0;
}

/** The shape of a mask over a width by height frame: its cells are rarely square, and a
 *  side's tilt is measured in the frame's own pixels. */
function maskShape(mask: Float32Array, size: number, width: number, height: number): MaskShape | null {
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
  const box = { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size };
  return {
    box,
    area: on / (size * size),
    rectangularity: on / ((x1 - x0 + 1) * (y1 - y0 + 1)),
    fill: quadAgreement(mask, size,
      outline(mask, size, box, width, height).map((v, i) => (v * size) / (i % 2 === 0 ? width : height))),
  };
}

/** Four straight sides: square to the frame, or seen at an angle. A round thing fills its
 *  box by 0.79 at most, and its curved boundary gives no straight tilted side to fit. */
const fourSided = (shape: MaskShape) => shape.rectangularity >= 0.88 || shape.fill >= 0.95;

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

/**
 * Whether a mask could be the document rather than the surface it lies on or a detail of it.
 * Shape carries this, not the model's own score: on a phone photo of an ID card the card
 * comes back scored 0.004 from one prompt and 0.99 from the next, while its rectangularity
 * is above 0.96 every time.
 */
const documentLike = (shape: MaskShape) =>
  shape.area <= 0.85 && fourSided(shape) && edgesTouched(shape.box) < 3;

/** A clean rectangle that may fill most of a tight shot, as long as it is not the frame. */
const wholeLike = (shape: MaskShape) =>
  fourSided(shape) && shape.area <= 0.97 && edgesTouched(shape.box) < 3;

/* ------------------------------------------------------------------ the print map */

class Print {
  constructor(private readonly map: PrintMapData) {}

  /** Fraction of print in a normalised rectangle, over photo pixels only; null when the
   *  rectangle holds too little photo to say. */
  density(x0: number, y0: number, x1: number, y1: number): number | null {
    const { width: w, height: h, data } = this.map;
    const a = Math.trunc(Math.max(0, x0) * w), b = Math.trunc(Math.min(1, x1) * w);
    const c = Math.trunc(Math.max(0, y0) * h), d = Math.trunc(Math.min(1, y1) * h);
    if (b - a < 2 || d - c < 2) return null;
    let valid = 0, print = 0;
    for (let y = c; y < d; y++) {
      for (let x = a; x < b; x++) {
        const v = data[y * w + x];
        if (v === 2) continue;
        valid++;
        if (v === 1) print++;
      }
    }
    return valid < 20 ? null : print / valid;
  }

  /** Fraction of print under a mask of the model's resolution. */
  maskDensity(mask: Uint8Array, size: number): number {
    const { width: w, height: h, data } = this.map;
    let n = 0, print = 0;
    for (let y = 0; y < h; y++) {
      const my = Math.min(size - 1, Math.floor((y * size) / h));
      for (let x = 0; x < w; x++) {
        const mx = Math.min(size - 1, Math.floor((x * size) / w));
        if (!mask[my * size + mx]) continue;
        const v = data[y * w + x];
        if (v === 2) continue;
        n++;
        if (v === 1) print++;
      }
    }
    return n > 50 ? print / n : 0;
  }

  /** Whether print carries on just outside the box on some side: the box is part of a page. */
  continuesBeyond(box: Box): boolean {
    const { x0, y0, x1, y1 } = box;
    const w = x1 - x0, h = y1 - y0;
    // the strips' sizes were tuned as written: top and bottom take their depth from the width
    let gap = 0.012 + 0.01 * h, depth = 0.15 * w;
    const strips: [number, number, number, number][] = [
      [x0, y0 - gap - depth, x1, y0 - gap], [x0, y1 + gap, x1, y1 + gap + depth],
    ];
    gap = 0.012 + 0.01 * w; depth = 0.15 * h;
    strips.push([x0 - gap - depth, y0, x0 - gap, y1], [x1 + gap, y0, x1 + gap + depth, y1]);
    const worst = strips.reduce((max, s) => Math.max(max, this.density(...s) ?? 0), 0);
    return worst > 0.02;
  }
}

const binary = (mask: Float32Array) => Uint8Array.from(mask, v => (v > 0 ? 1 : 0));

function dilate3(mask: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < size && ny < size && mask[ny * size + nx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * size + x] = on;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- decision */

interface Decision {
  mode: "object" | "page";
  chosen: DecodedMask | null;
  shape: MaskShape | null;
  method: DetectResult["method"];
}

export const VOTE_PROMPTS = 11;

async function decide(
  sam: Sam, embeddings: Embeddings, width: number, height: number,
  print: Print, pass: () => void,
): Promise<Decision> {
  const frame = await sam.decodeAll(embeddings, {
    box: [width * 0.04, height * 0.04, width * 0.96, height * 0.96],
  });
  pass();
  const best = frame.reduce((a, b) => (b.score > a.score ? b : a));
  const shape = maskShape(best.mask, best.size, width, height);
  if (shape && documentLike(shape)) {
    // A larger answer to the same prompt may add a band of print the best one left out: an
    // ornamental border. A plastic sleeve or a cover adds a plain ring instead.
    const grown = dilate3(binary(best.mask), best.size);
    for (const other of frame) {
      if (other === best) continue;
      const s2 = maskShape(other.mask, other.size, width, height);
      if (!s2 || s2.area < 1.04 * shape.area || !wholeLike(s2)) continue;
      const ring = binary(other.mask).map((v, i) => (v && !grown[i] ? 1 : 0));
      if (print.maskDensity(ring, other.size) >= 0.05) {
        return { mode: "object", chosen: other, shape: s2, method: "frame" };
      }
    }
    return { mode: "object", chosen: best, shape, method: "frame" };
  }
  // A ragged best answer, but the model also offered a clean rectangle: a whole card.
  let clean: { mask: DecodedMask; s: MaskShape } | null = null;
  for (const mask of frame) {
    const s = maskShape(mask.mask, mask.size, width, height);
    if (s && wholeLike(s) && (!clean || s.area > clean.s.area)) clean = { mask, s };
  }
  if (clean) return { mode: "object", chosen: clean.mask, shape: clean.s, method: "frame" };

  // Vote: several prompts, blank regions left out (the gap between two cards on a page).
  const prompts: Prompt[] = [
    { box: [width * 0.10, height * 0.10, width * 0.90, height * 0.90] },
    { box: [width * 0.20, height * 0.20, width * 0.80, height * 0.80] },
  ];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      prompts.push({ points: [[(gx + 0.5) / 3 * width, (gy + 0.5) / 3 * height, 1]] });
    }
  }
  const candidates: { mask: DecodedMask; s: MaskShape }[] = [];
  for (const prompt of prompts) {
    for (const mask of await sam.decodeAll(embeddings, prompt)) {
      const s = maskShape(mask.mask, mask.size, width, height);
      if (!s || !documentLike(s)) continue;
      const density = print.density(s.box.x0, s.box.y0, s.box.x1, s.box.y1);
      if (density !== null && density < 0.003) continue;
      candidates.push({ mask, s });
    }
    pass();
  }
  const groups: typeof candidates[] = [];
  for (const c of candidates) {
    const group = groups.find(g => iou(g[0]!.s.box, c.s.box) >= 0.8);
    if (group) group.push(c);
    else groups.push([c]);
  }
  groups.sort((a, b) => (b.length - a.length) || (area(b[0]!.s.box) - area(a[0]!.s.box)));
  if (!groups.length) {
    return shape
      ? { mode: "object", chosen: best, shape, method: "frame" }
      : { mode: "page", chosen: null, shape: null, method: "page" };
  }
  const winner = groups[0]!.reduce((a, b) =>
    ((b.s.rectangularity - a.s.rectangularity) || (b.mask.score - a.mask.score)) > 0 ? b : a);
  // A photo taken tight on a card: the frame is the document, and the only smaller
  // rectangles in it are its chip, photo or QR code.
  if (shape && fourSided(shape) && area(winner.s.box) < 0.06) {
    return { mode: "object", chosen: best, shape, method: "frame" };
  }
  // One page of a spread outvotes the spread; prefer a whole that contains the winner.
  const wb = winner.s.box;
  const wholes = candidates
    .filter(c => area(c.s.box) > 1.15 * area(wb)
      && c.s.box.x0 <= wb.x0 + 0.01 && c.s.box.y0 <= wb.y0 + 0.01
      && c.s.box.x1 >= wb.x1 - 0.01 && c.s.box.y1 >= wb.y1 - 0.01)
    .sort((a, b) => area(b.s.box) - area(a.s.box));
  for (const c of wholes) {
    if (!print.continuesBeyond(c.s.box)) {
      return { mode: "object", chosen: c.mask, shape: c.s, method: "vote" };
    }
  }
  // Print running on past the winner: it is part of a page that fills the photo.
  if (print.continuesBeyond(wb)) return { mode: "page", chosen: null, shape: null, method: "page" };
  return { mode: "object", chosen: winner.mask, shape: winner.s, method: "vote" };
}

/**
 * Find the document in a straightened photo. `turn` is the straightening angle in degrees,
 * so the white fill it brought into the corners is never taken for an edge.
 */
export async function detect(
  sam: Sam, img: ImageData, turn: number, report: Report = silent,
): Promise<DetectResult> {
  await sam.ready(report);
  const embeddings = await sam.encode(img, report);
  const { width, height } = img;
  const document = await DocumentFrame.open(img, turn);
  try {
    const print = new Print(document.map);
    let passes = 0;
    const planned = 1 + VOTE_PROMPTS;
    const pass = () => report({ phase: "decode", done: ++passes, total: planned });
    const decision = await decide(sam, embeddings, width, height, print, pass);
    if (passes < planned) report({ phase: "decode", done: planned, total: planned });

    const whole = [0, 0, 1, 0, 1, 1, 0, 1];
    let quad = whole;
    let kinds: SideKind[] = ["border", "border", "border", "border"];
    if (decision.mode === "object" && decision.shape && decision.chosen) {
      report({ phase: "refine", done: 0, total: 1 });
      const { mask, size } = decision.chosen;
      const fit = document.fit(outline(mask, size, decision.shape.box, width, height));
      const q = fit.quad.slice();
      // A side on the photo's border is the frame's own edge, not the last pixel's centre.
      if (fit.kinds[0] === "border") { q[1] = 0; q[3] = 0; }
      if (fit.kinds[1] === "border") { q[2] = width; q[4] = width; }
      if (fit.kinds[2] === "border") { q[5] = height; q[7] = height; }
      if (fit.kinds[3] === "border") { q[0] = 0; q[6] = 0; }
      quad = q.map((v, i) => Math.min(1, Math.max(0, v / (i % 2 === 0 ? width : height))));
      kinds = fit.kinds;
      report({ phase: "refine", done: 1, total: 1 });
    }
    const isWhole = kinds.every(k => k === "border");
    const chosen = isWhole ? null : decision.chosen;
    return {
      box: isWhole ? { x0: 0, y0: 0, x1: 1, y1: 1 } : {
        x0: Math.min(quad[0]!, quad[6]!), y0: Math.min(quad[1]!, quad[3]!),
        x1: Math.max(quad[2]!, quad[4]!), y1: Math.max(quad[5]!, quad[7]!),
      },
      quad: isWhole ? whole : quad,
      kinds,
      whole: isWhole,
      score: decision.chosen?.score ?? 0,
      method: isWhole ? "page" : decision.method,
      mask: chosen ? await cleanMask(chosen.mask, chosen.size) : new Float32Array(),
      maskSize: chosen ? chosen.size : 0,
    };
  } finally {
    document.free();
  }
}
