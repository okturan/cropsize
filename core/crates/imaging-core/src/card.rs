//! Cards photographed with a phone: find the four edges at full resolution, square the card
//! up, and round its corners the way the real card is rounded.
//!
//! The segmentation model only says roughly where the card is. Its 256 by 256 answer covers
//! a phone photo at twelve or more pixels per cell, and it cannot tell a card's edge from the
//! glare on it or the shadow under it. So each side is measured here instead, in a narrow
//! band around the model's box:
//!
//! 1. For every candidate straight line in the band, average the colour change across it,
//!    as a vector, along the whole side. The card's own edge changes colour the same way
//!    along its full length and scores high. Printed pattern crosses the edge at varying
//!    angles and cancels out. A shadow or a glare halo changes slowly and scores low at this
//!    scale.
//! 2. Of the strong candidates, take the outermost: that is the card's physical edge rather
//!    than a printed line parallel to it.
//! 3. Refine per column to a sub-pixel peak and fit one line through hundreds of points,
//!    discarding outliers.
//!
//! The four lines meet at the card's corners. A perspective warp maps them onto an exact
//! rectangle, and each corner's radius is measured on that rectangle, because lens
//! distortion near the edge of a phone photo can round a corner more than the standard
//! 3.18 mm.

use crate::RgbaFrame;

const SAMPLES: usize = 300;
/// How far either side of the model's box a card edge may lie, in millimetres.
const BAND_MM: f64 = 1.6;
/// The rounded corners are left out of the line fits, as a fraction of the side.
const CORNER_MARGIN: f64 = 0.14;
/// Pixels this close to the fill brought in by straightening do not count: its boundary is a
/// sharp straight edge that is not the card's. The photo's own border needs no such margin,
/// because nothing lies beyond it to make a false edge.
const FILL_MARGIN: f64 = 4.0;
const ID1_LONG_MM: f64 = 85.6;

#[derive(Clone, Copy, Debug)]
struct SideFit {
    /// the line: across = a + b * (along - tc)
    a: f64,
    b: f64,
    tc: f64,
    sd: f64,
    inlier_fraction: f64,
}

/// Separable Gaussian blur with sigma 1 over a small three-channel float patch.
fn blur3(data: &mut [f32], rows: usize, cols: usize) {
    const K: [f32; 7] = [0.004433, 0.054006, 0.242036, 0.399050, 0.242036, 0.054006, 0.004433];
    let mut tmp = vec![0f32; data.len()];
    for r in 0..rows {
        for c in 0..cols {
            for ch in 0..3 {
                let mut acc = 0f32;
                for (i, w) in K.iter().enumerate() {
                    let cc = (c as isize + i as isize - 3).clamp(0, cols as isize - 1) as usize;
                    acc += w * data[(r * cols + cc) * 3 + ch];
                }
                tmp[(r * cols + c) * 3 + ch] = acc;
            }
        }
    }
    for r in 0..rows {
        for c in 0..cols {
            for ch in 0..3 {
                let mut acc = 0f32;
                for (i, w) in K.iter().enumerate() {
                    let rr = (r as isize + i as isize - 3).clamp(0, rows as isize - 1) as usize;
                    acc += w * tmp[(rr * cols + c) * 3 + ch];
                }
                data[(r * cols + c) * 3 + ch] = acc;
            }
        }
    }
}

/// Whether a straightened pixel may be used: inside the frame, showing the original photo,
/// and not within FILL_MARGIN of the white fill that straightening by `turn` degrees brought
/// into the corners.
fn shows_photo(x: f64, y: f64, width: usize, height: usize, turn: f64) -> bool {
    let inside = |x: f64, y: f64| x >= 1.0 && y >= 1.0 && x <= width as f64 - 2.0 && y <= height as f64 - 2.0;
    if !inside(x, y) || !within_photo(x, y, width, height, turn, 0.0) {
        return false;
    }
    if turn.abs() < 1e-6 {
        return true;
    }
    let m = FILL_MARGIN;
    [(-m, 0.0), (m, 0.0), (0.0, -m), (0.0, m), (-m, -m), (m, -m), (-m, m), (m, m)]
        .iter()
        .all(|&(dx, dy)| {
            let (nx, ny) = (x + dx, y + dy);
            // a neighbour beyond the frame is not fill; one inside it must show the photo
            !inside(nx, ny) || within_photo(nx, ny, width, height, turn, 0.0)
        })
}

/// Whether a straightened pixel maps back inside the original photo, `margin` pixels in.
fn within_photo(x: f64, y: f64, width: usize, height: usize, turn: f64, margin: f64) -> bool {
    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let (sin, cos) = turn.to_radians().sin_cos();
    let (dx, dy) = (x - cx, y - cy);
    let (qx, qy) = (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
    qx >= margin && qy >= margin && qx <= width as f64 - 1.0 - margin && qy <= height as f64 - 1.0 - margin
}

#[allow(clippy::too_many_arguments)]
fn fit_side(
    rgba: &[u8],
    width: usize,
    height: usize,
    turn: f64,
    // position of the side across it, and the span along it to sample
    pos: f64,
    start: f64,
    end: f64,
    outward: f64,
    band: f64,
    // true: the side runs along x (top, bottom); false: along y (left, right)
    along_x: bool,
) -> Option<SideFit> {
    let (along_len, across_len) = if along_x { (width, height) } else { (height, width) };
    let mut ts: Vec<usize> = (0..SAMPLES)
        .map(|i| (start + (end - start) * i as f64 / (SAMPLES - 1) as f64).round())
        .filter(|t| *t >= 0.0 && *t <= along_len as f64 - 1.0)
        .map(|t| t as usize)
        .collect();
    ts.dedup();
    if ts.len() < 20 {
        return None;
    }
    let lo = (pos - band - 3.0).floor().max(0.0) as usize;
    let hi = ((pos + band + 3.0).ceil() as usize).min(across_len - 1);
    if hi <= lo + 8 {
        return None;
    }
    let rows = hi - lo + 1;
    // A region wide enough to blur without edge effects, then sampled at the ts.
    let t_min = ts[0].saturating_sub(3);
    let t_max = (ts[ts.len() - 1] + 3).min(along_len - 1);
    let cols = t_max - t_min + 1;
    let mut region = vec![0f32; rows * cols * 3];
    for r in 0..rows {
        for c in 0..cols {
            let (x, y) = if along_x { (t_min + c, lo + r) } else { (lo + r, t_min + c) };
            let offset = (y * width + x) * 4;
            for ch in 0..3 {
                region[(r * cols + c) * 3 + ch] = f32::from(rgba[offset + ch]);
            }
        }
    }
    blur3(&mut region, rows, cols);
    let k_len = ts.len();
    // Outward colour change at every row of every sampled column; zero where the photo's
    // border or the straightening fill is within reach.
    let mut grad = vec![[0f64; 3]; rows * k_len];
    for (k, &t) in ts.iter().enumerate() {
        let c = t - t_min;
        for r in 1..rows - 1 {
            let across = (lo + r) as f64;
            let (x, y) = if along_x { (t as f64, across) } else { (across, t as f64) };
            if !shows_photo(x, y, width, height, turn) {
                continue;
            }
            for ch in 0..3 {
                let up = region[((r + 1) * cols + c) * 3 + ch];
                let down = region[((r - 1) * cols + c) * 3 + ch];
                grad[r * k_len + k][ch] = f64::from(up - down) / 2.0 * outward;
            }
        }
    }
    let tc = (ts[0] + ts[k_len - 1]) as f64 / 2.0;
    let span = ((ts[k_len - 1] - ts[0]) as f64 / 2.0).max(1.0);
    let offsets: Vec<f64> = (0..=((2.0 * band / 0.5) as usize)).map(|i| -band + i as f64 * 0.5).collect();
    let slope_steps = (0.8 * band / 0.5) as isize;
    let slopes: Vec<f64> = (-slope_steps..=slope_steps).map(|i| i as f64 * 0.5 / span).collect();
    let sample = |row: f64, k: usize| -> [f64; 3] {
        if row < 1.0 || row >= (rows - 2) as f64 {
            return [0.0; 3];
        }
        let r0 = row.floor() as usize;
        let f = row - r0 as f64;
        let (a, b) = (grad[r0 * k_len + k], grad[(r0 + 1) * k_len + k]);
        [a[0] * (1.0 - f) + b[0] * f, a[1] * (1.0 - f) + b[1] * f, a[2] * (1.0 - f) + b[2] * f]
    };
    let base = pos - lo as f64;
    let mut per_offset = vec![(0f64, 0usize); offsets.len()];
    let mut best = 0f64;
    for (si, slope) in slopes.iter().enumerate() {
        for (ai, offset) in offsets.iter().enumerate() {
            let mut sum = [0f64; 3];
            for (k, &t) in ts.iter().enumerate() {
                let v = sample(base + offset + slope * (t as f64 - tc), k);
                sum[0] += v[0];
                sum[1] += v[1];
                sum[2] += v[2];
            }
            let score = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt() / k_len as f64;
            if score > per_offset[ai].0 {
                per_offset[ai] = (score, si);
            }
            best = best.max(score);
        }
    }
    if best <= 0.0 {
        return None;
    }
    let peaks: Vec<usize> = (1..offsets.len() - 1)
        .filter(|&i| {
            per_offset[i].0 >= per_offset[i - 1].0
                && per_offset[i].0 >= per_offset[i + 1].0
                && per_offset[i].0 >= 0.5 * best
        })
        .collect();
    let chosen = peaks
        .iter()
        .copied()
        .max_by(|&i, &j| (offsets[i] * outward).total_cmp(&(offsets[j] * outward)))
        .unwrap_or_else(|| {
            (0..offsets.len()).max_by(|&i, &j| per_offset[i].0.total_cmp(&per_offset[j].0)).unwrap()
        });
    let (a_rel, b) = (base + offsets[chosen], slopes[per_offset[chosen].1]);

    // The colour direction of this edge, so every column's change can be measured along it.
    let mut direction = [0f64; 3];
    for (k, &t) in ts.iter().enumerate() {
        let v = sample((a_rel + b * (t as f64 - tc)).round(), k);
        for ch in 0..3 {
            direction[ch] += v[ch];
        }
    }
    let norm = (direction.iter().map(|v| v * v).sum::<f64>()).sqrt().max(1e-9);
    let direction = direction.map(|v| v / norm);
    let along_edge = |r: usize, k: usize| -> f64 {
        let v = grad[r * k_len + k];
        (v[0] * direction[0] + v[1] * direction[1] + v[2] * direction[2]).max(0.0)
    };
    let mut points: Vec<(f64, f64)> = Vec::with_capacity(k_len);
    for (k, &t) in ts.iter().enumerate() {
        let c = a_rel + b * (t as f64 - tc);
        let from = ((c - 2.5).floor() as isize).max(1) as usize;
        let to = ((c + 2.5).ceil() as usize).min(rows - 2);
        if to < from + 2 {
            continue;
        }
        let j = (from..=to).max_by(|&i, &j| along_edge(i, k).total_cmp(&along_edge(j, k))).unwrap();
        if j < 1 || j > rows - 2 || along_edge(j, k) <= 0.0 {
            continue;
        }
        let (y0, y1, y2) = (along_edge(j - 1, k), along_edge(j, k), along_edge(j + 1, k));
        let den = y0 - 2.0 * y1 + y2;
        let off = if den < 0.0 { 0.5 * (y0 - y2) / den } else { 0.0 };
        points.push((t as f64, j as f64 + off + lo as f64));
    }
    // Too little of the side could be measured, for instance because it runs along the
    // photo's border: no line from it.
    if points.len() < 20 || points.len() * 5 < ts.len() * 2 {
        return None;
    }
    // Least squares with outliers trimmed at 2.5 robust standard deviations.
    let mut keep = vec![true; points.len()];
    let (mut a, mut slope, mut sd) = (0.0, 0.0, 0.0);
    for _ in 0..4 {
        let (mut n, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for (p, &kept) in points.iter().zip(&keep) {
            if kept {
                let x = p.0 - tc;
                n += 1.0;
                sx += x;
                sy += p.1;
                sxx += x * x;
                sxy += x * p.1;
            }
        }
        if n < 10.0 {
            return None;
        }
        let det = n * sxx - sx * sx;
        slope = if det.abs() > 1e-9 { (n * sxy - sx * sy) / det } else { 0.0 };
        a = (sy - slope * sx) / n;
        let mut residuals: Vec<f64> = points
            .iter()
            .zip(&keep)
            .filter(|(_, kept)| **kept)
            .map(|(p, _)| (p.1 - (a + slope * (p.0 - tc))).abs())
            .collect();
        residuals.sort_by(f64::total_cmp);
        sd = (1.4826 * residuals[residuals.len() / 2]).max(0.3);
        for (p, kept) in points.iter().zip(keep.iter_mut()) {
            *kept = (p.1 - (a + slope * (p.0 - tc))).abs() < 2.5 * sd;
        }
    }
    let inliers = keep.iter().filter(|k| **k).count();
    Some(SideFit { a, b: slope, tc, sd, inlier_fraction: inliers as f64 / points.len() as f64 })
}

/// Where a horizontal-ish side (y = a + b(x - tc)) meets a vertical-ish one (x = a + b(y - tc)).
fn meet(across_x: SideFit, across_y: SideFit) -> (f64, f64) {
    let (a1, b1, t1) = (across_x.a, across_x.b, across_x.tc);
    let (a2, b2, t2) = (across_y.a, across_y.b, across_y.tc);
    let x = (a2 + b2 * (a1 - b1 * t1 - t2)) / (1.0 - b1 * b2);
    (x, a1 + b1 * (x - t1))
}

/// Fit the four edges of a card inside `bbox` (pixels: x0, y0, x1, y1) in a straightened
/// frame. Returns the corners top-left, top-right, bottom-right, bottom-left as eight numbers,
/// then each side's scatter in pixels and the fraction of its measured points that agreed
/// with the line, in the order top, right, bottom, left; or nothing when an edge could not be
/// found. A side needs at least two fifths of its samples measurable.
pub fn fit_card_rgba(rgba: &[u8], width: usize, height: usize, bbox: [f64; 4], turn: f64) -> Vec<f64> {
    let [x0, y0, x1, y1] = bbox;
    let (bw, bh) = (x1 - x0, y1 - y0);
    if bw < 40.0 || bh < 40.0 {
        return Vec::new();
    }
    let px_mm = bw.max(bh) / ID1_LONG_MM;
    let band = (BAND_MM * px_mm).max(6.0);
    let side = |pos, start, end, outward, along_x| {
        fit_side(rgba, width, height, turn, pos, start, end, outward, band, along_x)
    };
    let (mx, my) = (CORNER_MARGIN * bw, CORNER_MARGIN * bh);
    let (Some(top), Some(right), Some(bottom), Some(left)) = (
        side(y0, x0 + mx, x1 - mx, -1.0, true),
        side(x1, y0 + my, y1 - my, 1.0, false),
        side(y1, x0 + mx, x1 - mx, 1.0, true),
        side(x0, y0 + my, y1 - my, -1.0, false),
    ) else {
        return Vec::new();
    };
    let corners = [meet(top, left), meet(top, right), meet(bottom, right), meet(bottom, left)];
    let mut out: Vec<f64> = corners.iter().flat_map(|&(x, y)| [x, y]).collect();
    if out.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    for fit in [top, right, bottom, left] {
        out.push(fit.sd);
    }
    for fit in [top, right, bottom, left] {
        out.push(fit.inlier_fraction);
    }
    out
}

/// The homography taking the output rectangle's corners onto `quad`, as a 3x3 row-major
/// matrix with the last entry 1. Solved from the four correspondences directly.
fn homography(quad: &[f64; 8], width: f64, height: f64) -> Option<[f64; 9]> {
    let dst = [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)];
    let mut m = [[0f64; 9]; 8];
    for i in 0..4 {
        let (u, v) = dst[i];
        let (x, y) = (quad[2 * i], quad[2 * i + 1]);
        m[2 * i] = [u, v, 1.0, 0.0, 0.0, 0.0, -u * x, -v * x, x];
        m[2 * i + 1] = [0.0, 0.0, 0.0, u, v, 1.0, -u * y, -v * y, y];
    }
    for col in 0..8 {
        let pivot = (col..8).max_by(|&a, &b| m[a][col].abs().total_cmp(&m[b][col].abs()))?;
        if m[pivot][col].abs() < 1e-12 {
            return None;
        }
        m.swap(col, pivot);
        for row in 0..8 {
            if row != col {
                let factor = m[row][col] / m[col][col];
                for k in col..9 {
                    m[row][k] -= factor * m[col][k];
                }
            }
        }
    }
    let h: Vec<f64> = (0..8).map(|i| m[i][8] / m[i][i]).collect();
    Some([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0])
}

fn catmull_rom(t: f64) -> [f64; 4] {
    let (t2, t3) = (t * t, t * t * t);
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

/// Map `quad` (top-left, top-right, bottom-right, bottom-left) onto a width by height
/// rectangle with bicubic sampling: straightens the card and removes the phone's tilt.
pub fn warp_quad_rgba(rgba: &[u8], width: usize, height: usize, quad: &[f64; 8], out_w: usize, out_h: usize) -> Vec<u8> {
    let mut out = vec![255u8; out_w * out_h * 4];
    let Some(h) = homography(quad, out_w as f64, out_h as f64) else {
        return out;
    };
    for v in 0..out_h {
        for u in 0..out_w {
            let (uf, vf) = (u as f64 + 0.5, v as f64 + 0.5);
            let w = h[6] * uf + h[7] * vf + h[8];
            let x = (h[0] * uf + h[1] * vf + h[2]) / w - 0.5;
            let y = (h[3] * uf + h[4] * vf + h[5]) / w - 0.5;
            let (xi, yi) = (x.floor(), y.floor());
            let (wx, wy) = (catmull_rom(x - xi), catmull_rom(y - yi));
            let mut acc = [0f64; 3];
            for (j, wyj) in wy.iter().enumerate() {
                let sy = (yi as isize + j as isize - 1).clamp(0, height as isize - 1) as usize;
                for (i, wxi) in wx.iter().enumerate() {
                    let sx = (xi as isize + i as isize - 1).clamp(0, width as isize - 1) as usize;
                    let offset = (sy * width + sx) * 4;
                    let weight = wxi * wyj;
                    for ch in 0..3 {
                        acc[ch] += weight * f64::from(rgba[offset + ch]);
                    }
                }
            }
            let offset = (v * out_w + u) * 4;
            for ch in 0..3 {
                out[offset + ch] = acc[ch].round().clamp(0.0, 255.0) as u8;
            }
            out[offset + 3] = 255;
        }
    }
    out
}

/// Measure each corner's radius on a squared-up card: the arc that best separates card from
/// background, searched from 0.7 to 2.2 times the standard radius. Order: top-left,
/// top-right, bottom-right, bottom-left.
pub fn corner_radii_rgba(rgba: &[u8], width: usize, height: usize, standard: f64) -> [f64; 4] {
    let patch = ((2.3 * standard).ceil() as usize + 4).min(width.min(height) / 2).max(4);
    let signs = [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)];
    let mut radii = [standard; 4];
    for (corner, &(sx, sy)) in signs.iter().enumerate() {
        // the corner's patch, blurred, in card coordinates starting at (px, py)
        let px = if sx > 0.0 { 0 } else { width - patch };
        let py = if sy > 0.0 { 0 } else { height - patch };
        let mut data = vec![0f32; patch * patch * 3];
        for r in 0..patch {
            for c in 0..patch {
                let offset = ((py + r) * width + px + c) * 4;
                for ch in 0..3 {
                    data[(r * patch + c) * 3 + ch] = f32::from(rgba[offset + ch]);
                }
            }
        }
        blur3(&mut data, patch, patch);
        let at = |x: f64, y: f64| -> [f64; 3] {
            let (lx, ly) = ((x - px as f64 - 0.5).clamp(0.0, patch as f64 - 1.001), (y - py as f64 - 0.5).clamp(0.0, patch as f64 - 1.001));
            let (x0, y0) = (lx.floor() as usize, ly.floor() as usize);
            let (fx, fy) = (lx - x0 as f64, ly - y0 as f64);
            let mut v = [0f64; 3];
            for ch in 0..3 {
                let p = |r: usize, c: usize| f64::from(data[(r * patch + c) * 3 + ch]);
                v[ch] = p(y0, x0) * (1.0 - fx) * (1.0 - fy) + p(y0, x0 + 1) * fx * (1.0 - fy)
                    + p(y0 + 1, x0) * (1.0 - fx) * fy + p(y0 + 1, x0 + 1) * fx * fy;
            }
            v
        };
        let (ox, oy) = (if sx > 0.0 { 0.0 } else { width as f64 }, if sy > 0.0 { 0.0 } else { height as f64 });
        let mut best = -1.0;
        let mut r = 0.7 * standard;
        while r <= 2.2 * standard && r <= patch as f64 - 3.0 {
            let (cx, cy) = (ox + sx * r, oy + sy * r);
            let mut sum = [0f64; 3];
            for i in 0..40 {
                let angle = (12.0 + 66.0 * i as f64 / 39.0).to_radians();
                let (ux, uy) = (-sx * angle.cos(), -sy * angle.sin());
                let (x, y) = (cx + r * ux, cy + r * uy);
                let (inner, outer) = (at(x - 1.5 * ux, y - 1.5 * uy), at(x + 1.5 * ux, y + 1.5 * uy));
                for ch in 0..3 {
                    sum[ch] += outer[ch] - inner[ch];
                }
            }
            let score = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
            if score > best {
                best = score;
                radii[corner] = r;
            }
            r += 0.5;
        }
    }
    radii
}

/// Whiten everything outside the rounded corners, with a one-pixel soft edge.
pub fn round_corners_rgba(rgba: &mut [u8], width: usize, height: usize, radii: &[f64; 4]) {
    let signs = [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)];
    for (corner, &(sx, sy)) in signs.iter().enumerate() {
        let r = radii[corner].max(0.0);
        let size = (r.ceil() as usize + 1).min(width).min(height);
        let (cx, cy) = (
            if sx > 0.0 { r } else { width as f64 - r },
            if sy > 0.0 { r } else { height as f64 - r },
        );
        for j in 0..size {
            let y = if sy > 0.0 { j } else { height - 1 - j };
            for i in 0..size {
                let x = if sx > 0.0 { i } else { width - 1 - i };
                let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
                // only the quarter beyond the arc's centre is ever trimmed
                if (fx - cx) * sx > 0.0 || (fy - cy) * sy > 0.0 {
                    continue;
                }
                let d = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt() - r;
                let alpha = (0.5 - d).clamp(0.0, 1.0);
                if alpha >= 1.0 {
                    continue;
                }
                let offset = (y * width + x) * 4;
                for ch in 0..3 {
                    let v = f64::from(rgba[offset + ch]);
                    rgba[offset + ch] = (v * alpha + 255.0 * (1.0 - alpha)).round() as u8;
                }
            }
        }
    }
}

impl RgbaFrame {
    pub(crate) fn fit_card_impl(&self, bbox: [f64; 4], turn: f64) -> Vec<f64> {
        fit_card_rgba(&self.pixels, self.width, self.height, bbox, turn)
    }

    pub(crate) fn warp_quad_impl(&self, quad: &[f64], out_w: usize, out_h: usize) -> RgbaFrame {
        let mut q = [0f64; 8];
        q.copy_from_slice(&quad[..8]);
        RgbaFrame {
            pixels: warp_quad_rgba(&self.pixels, self.width, self.height, &q, out_w, out_h),
            width: out_w,
            height: out_h,
        }
    }

    pub(crate) fn round_card_corners_impl(&mut self, standard: f64) -> Vec<f64> {
        let radii = corner_radii_rgba(&self.pixels, self.width, self.height, standard);
        round_corners_rgba(&mut self.pixels, self.width, self.height, &radii);
        radii.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic phone photo: a pale-blue card, slightly tilted in perspective, with rounded
    /// corners, a parallel printed line just inside its top, a glare halo fading out above its
    /// top and a soft shadow under its bottom, as in the real photos, on a textured grey desk.
    fn photo(quad: &[f64; 8], card_w: f64, card_h: f64, radius: f64) -> (Vec<u8>, usize, usize) {
        let (width, height) = (900usize, 700usize);
        let inverse = {
            // homography maps card coordinates to the photo; invert by solving per pixel
            homography(quad, card_w, card_h).unwrap()
        };
        let mut rgba = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                // invert the 3x3 numerically: solve H [u v 1] ~ [x y 1]
                let h = &inverse;
                let (xf, yf) = (x as f64 + 0.5, y as f64 + 0.5);
                let a = [[h[0] - h[6] * xf, h[1] - h[7] * xf], [h[3] - h[6] * yf, h[4] - h[7] * yf]];
                let b = [xf * h[8] - h[2], yf * h[8] - h[5]];
                let det = a[0][0] * a[1][1] - a[0][1] * a[1][0];
                let u = (b[0] * a[1][1] - a[0][1] * b[1]) / det;
                let v = (a[0][0] * b[1] - b[0] * a[1][0]) / det;
                let noise = ((x * 7919 + y * 104729) % 23) as f64 - 11.0;
                let mut c = [150.0 + noise, 160.0 + noise, 150.0 + noise];   // desk
                let qx = (u - card_w / 2.0).abs() - (card_w / 2.0 - radius);
                let qy = (v - card_h / 2.0).abs() - (card_h / 2.0 - radius);
                let d = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - radius;
                if d <= 0.0 {
                    c = [175.0, 190.0, 215.0];                                   // card face
                    if (u * 0.9).sin() > 0.95 {
                        c = [140.0, 150.0, 190.0];                              // crossing pattern
                    }
                    if (30.0..33.0).contains(&v) {
                        c = [90.0, 100.0, 140.0];                               // printed line
                    }
                } else if v < 0.0 && v > -14.0 && u > 0.0 && u < card_w {
                    let s = 1.0 + v / 14.0;                                     // glare halo
                    c = c.map(|ch| ch + (250.0 - ch) * 0.8 * s);
                } else if v > card_h && v < card_h + 25.0 && u > 0.0 && u < card_w {
                    let s = 1.0 - (v - card_h) / 25.0;                          // soft shadow
                    c = c.map(|ch| ch * (1.0 - 0.35 * s));
                }
                let o = (y * width + x) * 4;
                for ch in 0..3 {
                    rgba[o + ch] = c[ch].round() as u8;
                }
                rgba[o + 3] = 255;
            }
        }
        (rgba, width, height)
    }

    #[test]
    fn edges_are_found_through_glare_shadow_and_printed_lines() {
        let (card_w, card_h) = (642.0, 405.0);                       // ID-1 at 7.5 px/mm
        let quad = [131.0, 150.0, 772.0, 142.0, 780.0, 553.0, 125.0, 548.0];
        let (rgba, width, height) = photo(&quad, card_w, card_h, 24.0);
        // a rough box, as the model would give: a few pixels off on every side
        let found = fit_card_rgba(&rgba, width, height, [120.0, 146.0, 786.0, 556.0], 0.0);
        assert_eq!(found.len(), 16, "all four edges should be found");
        for i in 0..8 {
            assert!((found[i] - quad[i]).abs() < 1.5, "corner coordinate {i}: {} vs {}", found[i], quad[i]);
        }
        for sd in &found[8..12] {
            assert!(*sd < 1.0, "edge scatter {sd}");
        }
    }

    #[test]
    fn warping_the_found_quad_squares_the_card_and_rounds_its_corners() {
        let (card_w, card_h) = (642.0, 405.0);
        let quad = [131.0, 150.0, 772.0, 142.0, 780.0, 553.0, 125.0, 548.0];
        let (rgba, width, height) = photo(&quad, card_w, card_h, 24.0);
        let mut card = warp_quad_rgba(&rgba, width, height, &quad, 642, 405);
        // squared up: the printed line is level, at the same row at both ends
        let row_of_line = |x: usize| (0..60).find(|&y| card[(y * 642 + x) * 4] < 110).unwrap();
        assert!(row_of_line(100).abs_diff(row_of_line(540)) <= 1);
        let radii = corner_radii_rgba(&card, 642, 405, 24.0);
        for r in radii {
            assert!((r - 24.0).abs() <= 2.0, "radius {r}");
        }
        round_corners_rgba(&mut card, 642, 405, &radii);
        assert_eq!(&card[0..3], &[255, 255, 255], "the corner outside the arc is white");
        let middle = (200 * 642 + 321) * 4;
        assert_ne!(&card[middle..middle + 3], &[255, 255, 255]);
    }

    #[test]
    fn the_straightening_fill_is_never_taken_for_an_edge() {
        // Nothing but the fill boundary to find: the fit must fail rather than return it.
        let (width, height) = (400usize, 300usize);
        let mut rgba = vec![80u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                if !within_photo(x as f64, y as f64, width, height, 3.0, 0.0) {
                    let o = (y * width + x) * 4;
                    rgba[o..o + 3].fill(255);
                }
            }
        }
        let found = fit_card_rgba(&rgba, width, height, [2.0, 2.0, 397.0, 297.0], 3.0);
        assert!(found.is_empty() || found[8..12].iter().any(|sd| *sd > 3.0));
    }
}
