//! Squaring up a fitted card and rounding its corners the way the real card is rounded.
//!
//! The edges themselves are found by the general document fitter (document.rs). Here the four
//! corners are mapped onto an exact rectangle with a perspective warp, which also removes a
//! phone's tilt, and each corner's radius is measured on the result, because lens distortion
//! near the edge of a photo can round a corner more than the standard 3.18 mm.

use crate::RgbaFrame;

/// Separable Gaussian blur with sigma 1 over a small three-channel float patch.
fn blur3(data: &mut [f32], rows: usize, cols: usize) {
    const K: [f32; 7] = [
        0.004433, 0.054006, 0.242036, 0.399050, 0.242036, 0.054006, 0.004433,
    ];
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
pub fn warp_quad_rgba(
    rgba: &[u8],
    width: usize,
    height: usize,
    quad: &[f64; 8],
    out_w: usize,
    out_h: usize,
) -> Vec<u8> {
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
    let patch = ((2.3 * standard).ceil() as usize + 4)
        .min(width.min(height) / 2)
        .max(4);
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
            let (lx, ly) = (
                (x - px as f64 - 0.5).clamp(0.0, patch as f64 - 1.001),
                (y - py as f64 - 0.5).clamp(0.0, patch as f64 - 1.001),
            );
            let (x0, y0) = (lx.floor() as usize, ly.floor() as usize);
            let (fx, fy) = (lx - x0 as f64, ly - y0 as f64);
            let mut v = [0f64; 3];
            for ch in 0..3 {
                let p = |r: usize, c: usize| f64::from(data[(r * patch + c) * 3 + ch]);
                v[ch] = p(y0, x0) * (1.0 - fx) * (1.0 - fy)
                    + p(y0, x0 + 1) * fx * (1.0 - fy)
                    + p(y0 + 1, x0) * (1.0 - fx) * fy
                    + p(y0 + 1, x0 + 1) * fx * fy;
            }
            v
        };
        let (ox, oy) = (
            if sx > 0.0 { 0.0 } else { width as f64 },
            if sy > 0.0 { 0.0 } else { height as f64 },
        );
        let mut best = -1.0;
        let mut r = 0.7 * standard;
        while r <= 2.2 * standard && r <= patch as f64 - 3.0 {
            let (cx, cy) = (ox + sx * r, oy + sy * r);
            let mut sum = [0f64; 3];
            for i in 0..40 {
                let angle = (12.0 + 66.0 * i as f64 / 39.0).to_radians();
                let (ux, uy) = (-sx * angle.cos(), -sy * angle.sin());
                let (x, y) = (cx + r * ux, cy + r * uy);
                let (inner, outer) = (
                    at(x - 1.5 * ux, y - 1.5 * uy),
                    at(x + 1.5 * ux, y + 1.5 * uy),
                );
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
                let a = [
                    [h[0] - h[6] * xf, h[1] - h[7] * xf],
                    [h[3] - h[6] * yf, h[4] - h[7] * yf],
                ];
                let b = [xf * h[8] - h[2], yf * h[8] - h[5]];
                let det = a[0][0] * a[1][1] - a[0][1] * a[1][0];
                let u = (b[0] * a[1][1] - a[0][1] * b[1]) / det;
                let v = (a[0][0] * b[1] - b[0] * a[1][0]) / det;
                let noise = ((x * 7919 + y * 104729) % 23) as f64 - 11.0;
                let mut c = [150.0 + noise, 160.0 + noise, 150.0 + noise]; // desk
                let qx = (u - card_w / 2.0).abs() - (card_w / 2.0 - radius);
                let qy = (v - card_h / 2.0).abs() - (card_h / 2.0 - radius);
                let d = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0)
                    - radius;
                if d <= 0.0 {
                    c = [175.0, 190.0, 215.0]; // card face
                    if (u * 0.9).sin() > 0.95 {
                        c = [140.0, 150.0, 190.0]; // crossing pattern
                    }
                    if (30.0..33.0).contains(&v) {
                        c = [90.0, 100.0, 140.0]; // printed line
                    }
                } else if v < 0.0 && v > -14.0 && u > 0.0 && u < card_w {
                    let s = 1.0 + v / 14.0; // glare halo
                    c = c.map(|ch| ch + (250.0 - ch) * 0.8 * s);
                } else if v > card_h && v < card_h + 25.0 && u > 0.0 && u < card_w {
                    let s = 1.0 - (v - card_h) / 25.0; // soft shadow
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

    /// The general document fitter on the synthetic card, from a rough box: kinds and
    /// scatters as returned.
    fn fit(
        rgba: &[u8],
        width: usize,
        height: usize,
        [x0, y0, x1, y1]: [f64; 4],
        turn: f64,
    ) -> Vec<f64> {
        let detail = crate::document::detail_map_rgba(rgba, width, height, turn);
        let outline = [x0, y0, x1, y0, x1, y1, x0, y1];
        crate::document::fit_document_rgba(rgba, width, height, turn, outline, &detail)
    }

    #[test]
    fn edges_are_found_through_glare_shadow_and_printed_lines() {
        let (card_w, card_h) = (642.0, 405.0); // ID-1 at 7.5 px/mm
        let quad = [131.0, 150.0, 772.0, 142.0, 780.0, 553.0, 125.0, 548.0];
        let (rgba, width, height) = photo(&quad, card_w, card_h, 24.0);
        // a rough box, as the model would give: a few pixels off on every side
        let found = fit(&rgba, width, height, [120.0, 146.0, 786.0, 556.0], 0.0);
        for (i, want) in quad.iter().enumerate() {
            assert!(
                (found[i] - want).abs() < 1.5,
                "corner coordinate {i}: {} vs {want}",
                found[i]
            );
        }
        for side in 0..4 {
            assert_eq!(
                found[8 + side],
                f64::from(crate::document::KIND_NEAR),
                "side {side} measured"
            );
            assert!(
                found[12 + side] < 1.0,
                "side {side} scatter {}",
                found[12 + side]
            );
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
        assert_eq!(
            &card[0..3],
            &[255, 255, 255],
            "the corner outside the arc is white"
        );
        let middle = (200 * 642 + 321) * 4;
        assert_ne!(&card[middle..middle + 3], &[255, 255, 255]);
    }

    #[test]
    fn the_straightening_fill_is_never_taken_for_an_edge() {
        // Nothing but the fill boundary to find: no side may be measured onto it.
        let (width, height, turn) = (400usize, 300usize, 3.0f64);
        let (sin, cos) = turn.to_radians().sin_cos();
        let shows = |x: f64, y: f64| {
            let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
            let (dx, dy) = (x - cx, y - cy);
            let (qx, qy) = (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
            qx >= 0.0 && qy >= 0.0 && qx <= width as f64 - 1.0 && qy <= height as f64 - 1.0
        };
        let mut rgba = vec![80u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                if !shows(x as f64, y as f64) {
                    let o = (y * width + x) * 4;
                    rgba[o..o + 3].fill(255);
                }
            }
        }
        let found = fit(&rgba, width, height, [2.0, 2.0, 397.0, 297.0], turn);
        for side in 0..4 {
            let kind = found[8 + side] as u8;
            assert!(
                kind == crate::document::KIND_BORDER || kind == crate::document::KIND_PRIOR,
                "side {side} was measured onto the fill (kind {kind})"
            );
        }
    }
}
