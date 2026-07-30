/**
 * Turning a SAM mask into a crop box, plus the same edge refinement the Python build uses.
 */
import { Sam } from "./sam";
import type { LoadProgress } from "./model-loader";

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
  if (x1 < 0) return null;
  const frac = on / (size * size);
  if (frac < 0.02) return null;
  return { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size };
}

const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);

/**
 * Tidy a raw mask before anything trusts it as the document's outline.
 *
 * A SAM mask is not a solid shape. Over flat bright areas it leaves gaps: on a real passport
 * scan the mask came back with 2.6% of the document as interior holes, one of them a single
 * blob 350 px across at mask resolution. Trimming to that punches white patches out of the
 * middle of the page, which looks exactly like a magic wand that only caught the contrasty
 * pixels.
 *
 * Two passes. Keep only the largest connected region, which drops stray blobs picked up off
 * the platen, then fill anything enclosed by it, because a document has no holes in it.
 */
export function cleanMask(mask: Float32Array, size: number): Float32Array {
  const n = size * size;
  const on = new Uint8Array(n);
  for (let i = 0; i < n; i++) on[i] = (mask[i] ?? -1) > 0 ? 1 : 0;

  // largest connected region
  const label = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let best = -1, bestSize = 0, current = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!on[seed] || label[seed] !== -1) continue;
    let count = 0;
    stack.push(seed);
    label[seed] = current;
    while (stack.length) {
      const p = stack.pop()!;
      count++;
      const x = p % size, y = (p / size) | 0;
      if (x > 0 && on[p - 1] && label[p - 1] === -1) { label[p - 1] = current; stack.push(p - 1); }
      if (x < size - 1 && on[p + 1] && label[p + 1] === -1) { label[p + 1] = current; stack.push(p + 1); }
      if (y > 0 && on[p - size] && label[p - size] === -1) { label[p - size] = current; stack.push(p - size); }
      if (y < size - 1 && on[p + size] && label[p + size] === -1) { label[p + size] = current; stack.push(p + size); }
    }
    if (count > bestSize) { bestSize = count; best = current; }
    current++;
  }
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) keep[i] = label[i] === best ? 1 : 0;

  // fill enclosed gaps: flood the background inward from the border, whatever it cannot
  // reach is a hole
  const outside = new Uint8Array(n);
  for (let i = 0; i < size; i++) {
    for (const p of [i, n - size + i, i * size, i * size + size - 1]) {
      if (!keep[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
    }
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % size, y = (p / size) | 0;
    if (x > 0 && !keep[p - 1] && !outside[p - 1]) { outside[p - 1] = 1; stack.push(p - 1); }
    if (x < size - 1 && !keep[p + 1] && !outside[p + 1]) { outside[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !keep[p - size] && !outside[p - size]) { outside[p - size] = 1; stack.push(p - size); }
    if (y < size - 1 && !keep[p + size] && !outside[p + size]) { outside[p + size] = 1; stack.push(p + size); }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (keep[i] || !outside[i]) ? 1 : -1;
  return out;
}

/**
 * Pull each side onto the strongest straight edge near it.
 *
 * The mask is computed at 256 by 256 and upsampled, so its boundary is only good to a couple
 * of millimetres at 300 dpi. A document edge is a long straight step, so it dominates the
 * summed gradient across that side. Searching mostly outward matters: printing inside the
 * page often beats the paper edge, and a symmetric search walks inward and clips content.
 */
export function snapEdges(img: ImageData, box: Box, reach = 0.025, prominence = 6): Box {
  const { width: w, height: h, data } = img;
  const grey = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    grey[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
  }
  const px0 = Math.round(box.x0 * w), px1 = Math.round(box.x1 * w);
  const py0 = Math.round(box.y0 * h), py1 = Math.round(box.y1 * h);

  // Central band only, so rounded corners do not drag the profile around.
  const bandY0 = py0 + ((py1 - py0) >> 2), bandY1 = py1 - ((py1 - py0) >> 2);
  const bandX0 = px0 + ((px1 - px0) >> 2), bandX1 = px1 - ((px1 - px0) >> 2);

  const cols = new Float32Array(w);
  for (let y = bandY0; y < bandY1; y++) {
    for (let x = 1; x < w - 1; x++) {
      cols[x] = (cols[x] ?? 0) + Math.abs((grey[y * w + x + 1] ?? 0) - (grey[y * w + x - 1] ?? 0));
    }
  }
  const rows = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let acc = 0;
    for (let x = bandX0; x < bandX1; x++) {
      acc += Math.abs((grey[(y + 1) * w + x] ?? 0) - (grey[(y - 1) * w + x] ?? 0));
    }
    rows[y] = acc;
  }

  const median = (a: Float32Array) => {
    const s = Array.from(a).filter(v => v > 0).sort((p, q) => p - q);
    return s.length ? (s[s.length >> 1] ?? 1) : 1;
  };
  const pick = (prof: Float32Array, centre: number, span: number, sign: -1 | 1, med: number) => {
    const out = Math.round(span), inn = Math.round(span * 0.2);
    const lo = Math.max(0, centre - (sign < 0 ? out : inn));
    const hi = Math.min(prof.length, centre + (sign < 0 ? inn : out));
    let best = -1, bestV = 0;
    for (let i = lo; i < hi; i++) if ((prof[i] ?? 0) > bestV) { bestV = prof[i] ?? 0; best = i; }
    return best >= 0 && bestV > med * prominence ? best : centre;
  };

  const mc = median(cols), mr = median(rows);
  const nx0 = pick(cols, px0, w * reach, -1, mc);
  const nx1 = pick(cols, px1, w * reach, 1, mc);
  const ny0 = pick(rows, py0, h * reach, -1, mr);
  const ny1 = pick(rows, py1, h * reach, 1, mr);
  const snapped = { x0: nx0 / w, y0: ny0 / h, x1: nx1 / w, y1: ny1 / h };
  if (snapped.x1 - snapped.x0 < 0.2 || snapped.y1 - snapped.y0 < 0.2) return box;
  return snapped;
}

export async function detect(
  sam: Sam, img: ImageData, onProgress: (p: LoadProgress) => void,
): Promise<DetectResult> {
  await sam.ready(onProgress);
  const emb = await sam.encode(img);
  const { width: w, height: h } = img;

  const boxPrompt: [number, number, number, number] = [w * 0.04, h * 0.04, w * 0.96, h * 0.96];
  let r = await sam.decode(emb, { box: boxPrompt });
  let bounds = maskBounds(r.mask, r.size);
  let how = "box prompt";

  // A box spanning most of the frame means "the thing inside this box", which for a small
  // item on a large platen is the platen. When the answer covers nearly everything, ask
  // again with a single centre point.
  if (!bounds || area(bounds) > 0.85) {
    const alt = await sam.decode(emb, { points: [[w / 2, h / 2, 1]] });
    const altBounds = maskBounds(alt.mask, alt.size);
    if (altBounds && area(altBounds) < 0.85) {
      r = alt; bounds = altBounds; how = "centre point, the box prompt found the whole frame";
    }
  }
  if (!bounds) throw new Error("nothing found in this scan");

  return {
    box: snapEdges(img, bounds),
    score: r.score,
    note: `${how}, score ${r.score.toFixed(3)}`,
    mask: cleanMask(r.mask, r.size),
    maskSize: r.size,
  };
}
