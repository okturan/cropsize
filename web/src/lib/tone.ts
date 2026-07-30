/**
 * Contrast, ported from the Python build.
 *
 * Two steps, both deliberately luminance only. CLAHE lifts local contrast so faint print
 * becomes readable, then one shared stretch pulls the white point up. The stretch is applied
 * identically to all three channels rather than per channel, because a per channel stretch
 * shifts hue, and on a document colour is evidence: stamp inks, security print, paper tint.
 *
 * Off by default. What you export should be what you scanned unless you asked otherwise.
 */

const TILES = 8;
const BINS = 256;

function luminance(data: Uint8ClampedArray): Float32Array {
  const y = new Float32Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    y[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
  }
  return y;
}

/** Contrast limited adaptive histogram equalisation over a grid of tiles. */
function clahe(y: Float32Array, w: number, h: number, clip: number): Float32Array {
  const tw = Math.ceil(w / TILES), th = Math.ceil(h / TILES);
  const luts: Uint8Array[] = [];

  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const x0 = tx * tw, y0 = ty * th;
      const x1 = Math.min(w, x0 + tw), y1 = Math.min(h, y0 + th);
      const hist = new Float64Array(BINS);
      let count = 0;
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const v = Math.min(255, Math.max(0, Math.round(y[py * w + px] ?? 0)));
          hist[v] = (hist[v] ?? 0) + 1;
          count++;
        }
      }
      // Clip the tall bins and hand the excess back out evenly. Without the clip, a flat
      // region of paper gets its noise amplified into visible mottling.
      const limit = Math.max(1, (clip * count) / BINS);
      let excess = 0;
      for (let b = 0; b < BINS; b++) {
        const over = (hist[b] ?? 0) - limit;
        if (over > 0) { excess += over; hist[b] = limit; }
      }
      const share = excess / BINS;
      const lut = new Uint8Array(BINS);
      let cum = 0;
      const scale = count > 0 ? 255 / count : 0;
      for (let b = 0; b < BINS; b++) {
        cum += (hist[b] ?? 0) + share;
        lut[b] = Math.min(255, Math.max(0, Math.round(cum * scale)));
      }
      luts.push(lut);
    }
  }

  // Bilinear blend between the four surrounding tile mappings, so tile edges do not show.
  const out = new Float32Array(y.length);
  for (let py = 0; py < h; py++) {
    const fy = Math.min(TILES - 1, Math.max(0, py / th - 0.5));
    const ty0 = Math.floor(fy), ty1 = Math.min(TILES - 1, ty0 + 1), wy = fy - ty0;
    for (let px = 0; px < w; px++) {
      const fx = Math.min(TILES - 1, Math.max(0, px / tw - 0.5));
      const tx0 = Math.floor(fx), tx1 = Math.min(TILES - 1, tx0 + 1), wx = fx - tx0;
      const v = Math.min(255, Math.max(0, Math.round(y[py * w + px] ?? 0)));
      const a = luts[ty0 * TILES + tx0]?.[v] ?? v;
      const b = luts[ty0 * TILES + tx1]?.[v] ?? v;
      const c = luts[ty1 * TILES + tx0]?.[v] ?? v;
      const d = luts[ty1 * TILES + tx1]?.[v] ?? v;
      out[py * w + px] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

function percentile(data: Uint8ClampedArray, lowP: number, highP: number): [number, number] {
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (const c of [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]) {
      hist[c] = (hist[c] ?? 0) + 1;
    }
    n += 3;
  }
  let cum = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) {
    cum += hist[v] ?? 0;
    if (cum >= n * lowP) { lo = v; break; }
  }
  cum = 0;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v] ?? 0;
    if (cum >= n * (1 - highP)) { hi = v; break; }
  }
  return [lo, Math.max(lo + 1, hi)];
}

export function applyTone(img: ImageData, clipLimit: number, stretch: boolean): ImageData {
  if (clipLimit <= 0 && !stretch) return img;

  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const d = out.data;

  if (clipLimit > 0) {
    const y = luminance(d);
    const eq = clahe(y, img.width, img.height, clipLimit);
    // Rescale each pixel's colour by how much its luminance moved, which keeps hue and
    // saturation where they were.
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const before = y[p] ?? 0;
      if (before < 1) continue;
      const ratio = (eq[p] ?? 0) / before;
      d[i] = Math.min(255, (d[i] ?? 0) * ratio);
      d[i + 1] = Math.min(255, (d[i + 1] ?? 0) * ratio);
      d[i + 2] = Math.min(255, (d[i + 2] ?? 0) * ratio);
    }
  }

  if (stretch) {
    const [lo, hi] = percentile(d, 0.01, 0.995);
    const span = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, Math.max(0, ((d[i] ?? 0) - lo) * span));
      d[i + 1] = Math.min(255, Math.max(0, ((d[i + 1] ?? 0) - lo) * span));
      d[i + 2] = Math.min(255, Math.max(0, ((d[i + 2] ?? 0) - lo) * span));
    }
  }
  return out;
}
