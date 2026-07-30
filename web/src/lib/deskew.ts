/**
 * Straightening, ported from the Python build.
 *
 * The angle comes from a projection profile: rotate the ink, sum each row, and keep the
 * angle whose row totals change most sharply from one row to the next. Text lines stack into
 * hard peaks when they are level and smear when they are not.
 *
 * The Python version rotates the whole bitmap once per candidate angle. Doing that a hundred
 * times in a canvas would be slow, so this collects the ink pixels once and rotates only
 * those coordinates while filling a histogram. Same answer, a fraction of the work.
 */

const LIMIT = 5;      // degrees either side
const STEP = 0.1;
const WORK = 800;     // width the estimate runs at
// Ignore the outer eighth. A scanner frame, the platen edge and the shadow along it are all
// axis aligned no matter how the document sits, and they were strong enough to pin the answer
// at zero on a scan the Python build measures at 1.4 degrees.
const INSET = 0.08;

function inkPixels(img: ImageData): { xs: Int16Array; ys: Int16Array; w: number; h: number } {
  const scale = Math.min(WORK / img.width, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  const small = new OffscreenCanvas(w, h);
  const sctx = small.getContext("2d")!;
  sctx.drawImage(src, 0, 0, w, h);
  const { data } = sctx.getImageData(0, 0, w, h);

  const grey = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    grey[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
  }

  // Integral image, so the local mean behind the adaptive threshold is one lookup per pixel.
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += grey[y * w + x] ?? 0;
      sum[(y + 1) * (w + 1) + x + 1] = (sum[y * (w + 1) + x + 1] ?? 0) + run;
    }
  }
  const R = 15;                                  // half window, matches the 31 px kernel
  const xs: number[] = [], ys: number[] = [];
  const insetX = Math.round(w * INSET), insetY = Math.round(h * INSET);
  for (let y = insetY; y < h - insetY; y++) {
    for (let x = insetX; x < w - insetX; x++) {
      const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R);
      const x1 = Math.min(w, x + R + 1), y1 = Math.min(h, y + R + 1);
      const areaSum = (sum[y1 * (w + 1) + x1] ?? 0) - (sum[y0 * (w + 1) + x1] ?? 0)
        - (sum[y1 * (w + 1) + x0] ?? 0) + (sum[y0 * (w + 1) + x0] ?? 0);
      const mean = areaSum / ((x1 - x0) * (y1 - y0));
      if ((grey[y * w + x] ?? 0) < mean - 15) { xs.push(x); ys.push(y); }
    }
  }
  return { xs: Int16Array.from(xs), ys: Int16Array.from(ys), w, h };
}

export function estimateSkew(img: ImageData): number {
  const { xs, ys, w, h } = inkPixels(img);
  if (xs.length < 200) return 0;                 // nothing text-like to measure

  const diag = Math.ceil(Math.hypot(w, h)) + 2;
  const hist = new Float64Array(diag);
  let bestAngle = 0, bestScore = -1;

  for (let a = -LIMIT; a <= LIMIT + 1e-9; a += STEP) {
    const rad = (a * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    hist.fill(0);
    const off = diag / 2 - (w * Math.abs(sin) + h * cos) / 2;
    for (let i = 0; i < xs.length; i++) {
      // -x*sin, matching OpenCV's rotation matrix. With +x*sin the angle came back with the
      // sign flipped, which straightened the sample twice as far the wrong way.
      const y = -(xs[i] ?? 0) * sin + (ys[i] ?? 0) * cos + off;
      // Split each pixel across the two nearest rows. Rounding instead would make zero
      // degrees the sharpest angle for free, since there every pixel lands dead on a row
      // while every other angle gets smeared by the rounding. That bias alone was enough to
      // report no tilt on a scan the Python build measures at 1.4 degrees.
      const lo = Math.floor(y);
      const frac = y - lo;
      if (lo >= 0 && lo < diag) hist[lo] = (hist[lo] ?? 0) + (1 - frac);
      if (lo + 1 >= 0 && lo + 1 < diag) hist[lo + 1] = (hist[lo + 1] ?? 0) + frac;
    }
    // Smooth every histogram the same way before scoring. At exactly zero degrees the row
    // coordinates land on whole numbers, so that one angle would otherwise get a sharper
    // profile for free and win by default.
    let score = 0;
    let prev = 0;
    for (let i = 1; i < diag - 1; i++) {
      const cur = 0.25 * (hist[i - 1] ?? 0) + 0.5 * (hist[i] ?? 0) + 0.25 * (hist[i + 1] ?? 0);
      if (i > 1) { const d = cur - prev; score += d * d; }
      prev = cur;
    }
    if (score > bestScore) { bestScore = score; bestAngle = a; }
  }
  return Math.round(bestAngle * 100) / 100;
}

/** Rotate about the centre, same canvas size, white where the corners come in. */
export function rotate(img: ImageData, degrees: number): ImageData {
  if (Math.abs(degrees) < 0.01) return img;
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);

  const out = new OffscreenCanvas(img.width, img.height);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((-degrees * Math.PI) / 180);
  ctx.drawImage(src, -img.width / 2, -img.height / 2);
  return ctx.getImageData(0, 0, out.width, out.height);
}

/** Quarter turns, lossless: no resampling, just a reorientation of the same pixels. */
export function quarterTurns(img: ImageData, quarters: number): ImageData {
  const k = ((quarters % 4) + 4) % 4;
  if (k === 0) return img;
  const swap = k % 2 === 1;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;

  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((k * Math.PI) / 2);
  ctx.drawImage(src, -img.width / 2, -img.height / 2);
  return ctx.getImageData(0, 0, w, h);
}
