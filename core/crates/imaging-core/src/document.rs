//! Any document: find its four sides at full resolution around the model's rough outline.
//!
//! The segmentation model says roughly where the document is, from a 256 by 256 view of the
//! photo. It cannot say exactly where an edge runs, and it cannot tell a sheet's edge from the
//! glare on it, the shadow under it or the first line of text on it. So each side is measured
//! here instead, in the full-resolution photo:
//!
//! 1. Every straight line in a band around the model's side gets a score: the colour change
//!    across it, averaged as a vector along the side. A physical edge changes colour the same
//!    way all along; printed pattern cancels out; soft shadows and glare score low.
//! 2. Candidates are the peaks of that score over offset and slope together.
//! 3. A candidate is rejected when it lies inside the document: the same paper on both sides
//!    of a line of print, the edge of a block of text (print pressed against one side, the
//!    same plain paper on the other), a crease (a faint line on one plain surface), or an
//!    edge that runs along less than half of the side.
//! 4. Of the rest, edges a few pixels apart are one edge seen twice and the strongest wins;
//!    further apart they are different things (a page and the sleeve around it) and the group
//!    nearest the model's side wins.
//! 5. With nothing near, the search widens outward to the photo's border on a downscaled copy,
//!    taking the outermost clean edge; with nothing there either, the side is the border.
//!    When real but patchy edges were found near the model's side, its side is kept as is.
//!
//! Every rule here was tuned by eye on magnified overlays of 36 real documents: phone photos
//! of cards and sheets, flatbed scans of passports in sleeves, certificates with ornamental
//! borders, spreads and forms. The reference implementation that tuning ran on is recorded in
//! the tests below as expected results.

use crate::RgbaFrame;

const SAMPLES: usize = 300;
/// The rounded corners are left out of every side, as a fraction of its length.
const CORNER_MARGIN: f64 = 0.12;
/// Pixels this close to the fill that straightening brought in do not count.
const FILL_MARGIN: f64 = 4.0;
/// Long side of the downscaled copy used for the wide search.
const WORK_LONG: f64 = 1000.0;
/// Long side of the print map.
const DETAIL_LONG: f64 = 900.0;
/// A pixel is print when it differs from its 9 by 9 median by more than this.
const DETAIL_THRESHOLD: i32 = 28;
const CONTINUITY_MIN: f64 = 0.5;

pub const KIND_BORDER: u8 = 0;
pub const KIND_PRIOR: u8 = 1;
pub const KIND_NEAR: u8 = 2;
pub const KIND_WIDE: u8 = 3;

/* ---------------------------------------------------------------------------- photo */

/// The straightened photo, and which of its pixels show the original photo rather than the
/// white fill that straightening by `turn` degrees brought into the corners.
struct Photo<'a> {
    rgba: &'a [u8],
    w: usize,
    h: usize,
    sin: f64,
    cos: f64,
    turned: bool,
}

impl<'a> Photo<'a> {
    fn new(rgba: &'a [u8], w: usize, h: usize, turn: f64) -> Self {
        let (sin, cos) = turn.to_radians().sin_cos();
        Photo {
            rgba,
            w,
            h,
            sin,
            cos,
            turned: turn.abs() >= 1e-6,
        }
    }

    fn maps_inside(&self, x: f64, y: f64) -> bool {
        let (cx, cy) = (self.w as f64 / 2.0, self.h as f64 / 2.0);
        let (dx, dy) = (x - cx, y - cy);
        let qx = cx + dx * self.cos - dy * self.sin;
        let qy = cy + dx * self.sin + dy * self.cos;
        qx >= 0.0 && qy >= 0.0 && qx <= self.w as f64 - 1.0 && qy <= self.h as f64 - 1.0
    }

    /// In the image, and at least FILL_MARGIN pixels from the straightening fill: the same as
    /// eroding the photo's footprint with a 9 by 9 square. The footprint is a rotated
    /// rectangle, so convex, and a window lies inside it when its four corners do; the
    /// window is clipped to the frame first, as beyond the frame there is no fill.
    fn valid(&self, x: isize, y: isize) -> bool {
        if x < 0 || y < 0 || x >= self.w as isize || y >= self.h as isize {
            return false;
        }
        if !self.turned {
            return true;
        }
        let m = FILL_MARGIN;
        let (fx, fy) = (x as f64, y as f64);
        let (wmax, hmax) = (self.w as f64 - 1.0, self.h as f64 - 1.0);
        let (x0, x1) = ((fx - m).max(0.0), (fx + m).min(wmax));
        let (y0, y1) = ((fy - m).max(0.0), (fy + m).min(hmax));
        self.maps_inside(x0, y0)
            && self.maps_inside(x1, y0)
            && self.maps_inside(x0, y1)
            && self.maps_inside(x1, y1)
    }

    fn px(&self, x: usize, y: usize) -> [f64; 3] {
        let o = (y * self.w + x) * 4;
        [
            f64::from(self.rgba[o]),
            f64::from(self.rgba[o + 1]),
            f64::from(self.rgba[o + 2]),
        ]
    }
}

fn reflect101(i: isize, n: usize) -> usize {
    let n = n as isize;
    if n <= 1 {
        return 0;
    }
    let mut i = i;
    loop {
        if i < 0 {
            i = -i;
        } else if i >= n {
            i = 2 * (n - 1) - i;
        } else {
            return i as usize;
        }
    }
}

fn gaussian9() -> [f32; 9] {
    let mut k = [0f32; 9];
    let mut sum = 0f64;
    for (i, v) in k.iter_mut().enumerate() {
        let x = i as f64 - 4.0;
        let e = (-x * x / 2.0).exp();
        *v = e as f32;
        sum += e;
    }
    for v in &mut k {
        *v /= sum as f32;
    }
    k
}

/* ------------------------------------------------------------------------ fields */

/// A blurred colour image with a validity mask, sampled bilinearly like OpenCV's remap with
/// a constant zero border. `scale` maps photo coordinates to this field's pixels.
trait Field {
    fn scale(&self) -> f64;
    fn size(&self) -> (usize, usize);
    /// Blurred colour at an integer pixel of this field, which must lie in the image.
    fn blur(&self, x: usize, y: usize) -> [f64; 3];
    fn valid_px(&self, x: usize, y: usize) -> bool;
    /// Whether this field holds the pixel (a region may not).
    fn holds(&self, x: isize, y: isize) -> bool;

    /// Central-difference gradient at an integer pixel, zero on the image's first and last
    /// row (or column), as numpy slicing gives.
    fn grad_px(&self, x: usize, y: usize, horiz: bool) -> [f64; 3] {
        let (w, h) = self.size();
        if horiz {
            if y == 0
                || y + 1 >= h
                || !self.holds(x as isize, y as isize - 1)
                || !self.holds(x as isize, y as isize + 1)
            {
                return [0.0; 3];
            }
            let (a, b) = (self.blur(x, y + 1), self.blur(x, y - 1));
            [
                (a[0] - b[0]) / 2.0,
                (a[1] - b[1]) / 2.0,
                (a[2] - b[2]) / 2.0,
            ]
        } else {
            if x == 0
                || x + 1 >= w
                || !self.holds(x as isize - 1, y as isize)
                || !self.holds(x as isize + 1, y as isize)
            {
                return [0.0; 3];
            }
            let (a, b) = (self.blur(x + 1, y), self.blur(x - 1, y));
            [
                (a[0] - b[0]) / 2.0,
                (a[1] - b[1]) / 2.0,
                (a[2] - b[2]) / 2.0,
            ]
        }
    }

    /// Bilinear sample at field coordinates: (value, valid). Valid means the weights of the
    /// valid neighbours sum above 0.99.
    fn sample(&self, x: f64, y: f64, what: Sample) -> ([f64; 3], bool) {
        let (w, h) = self.size();
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let (x0, y0) = (x0 as isize, y0 as isize);
        let mut value = [0f64; 3];
        let mut weight_valid = 0f64;
        for (dy, wy) in [(0isize, 1.0 - fy), (1, fy)] {
            for (dx, wx) in [(0isize, 1.0 - fx), (1, fx)] {
                let (px, py) = (x0 + dx, y0 + dy);
                if px < 0 || py < 0 || px >= w as isize || py >= h as isize || !self.holds(px, py) {
                    continue;
                }
                let weight = wx * wy;
                let (ux, uy) = (px as usize, py as usize);
                let v = match what {
                    Sample::Colour => self.blur(ux, uy),
                    Sample::GradY => self.grad_px(ux, uy, true),
                    Sample::GradX => self.grad_px(ux, uy, false),
                };
                for c in 0..3 {
                    value[c] += weight * v[c];
                }
                if self.valid_px(ux, uy) {
                    weight_valid += weight;
                }
            }
        }
        (value, weight_valid > 0.99)
    }
}

#[derive(Clone, Copy)]
enum Sample {
    Colour,
    GradY,
    GradX,
}

/// A full-resolution rectangle of the photo, blurred with a 9-tap Gaussian (sigma 1).
struct Region {
    x0: isize,
    y0: isize,
    rw: usize,
    rh: usize,
    img_w: usize,
    img_h: usize,
    blur: Vec<f32>,
    valid: Vec<u8>,
}

impl Region {
    fn new(photo: &Photo, x0: f64, y0: f64, x1: f64, y1: f64) -> Region {
        let (w, h) = (photo.w as isize, photo.h as isize);
        let rx0 = ((x0.floor() as isize) - 4).clamp(0, w - 1);
        let ry0 = ((y0.floor() as isize) - 4).clamp(0, h - 1);
        let rx1 = ((x1.ceil() as isize) + 4).clamp(0, w - 1);
        let ry1 = ((y1.ceil() as isize) + 4).clamp(0, h - 1);
        let (rw, rh) = ((rx1 - rx0 + 1) as usize, (ry1 - ry0 + 1) as usize);
        let k = gaussian9();
        // horizontal pass over rows ry0-4 ..= ry1+4
        let th = rh + 8;
        let mut tmp = vec![0f32; th * rw * 3];
        for ty in 0..th {
            let sy = reflect101(ry0 - 4 + ty as isize, photo.h);
            for x in 0..rw {
                let mut acc = [0f32; 3];
                for (i, kv) in k.iter().enumerate() {
                    let sx = reflect101(rx0 + x as isize + i as isize - 4, photo.w);
                    let o = (sy * photo.w + sx) * 4;
                    for c in 0..3 {
                        acc[c] += kv * f32::from(photo.rgba[o + c]);
                    }
                }
                let o = (ty * rw + x) * 3;
                tmp[o..o + 3].copy_from_slice(&acc);
            }
        }
        let mut blur = vec![0f32; rh * rw * 3];
        for y in 0..rh {
            for x in 0..rw {
                let mut acc = [0f32; 3];
                for (i, kv) in k.iter().enumerate() {
                    // row y of the region is row y+4 of tmp; taps y..y+8, with the source
                    // rows beyond the image reflected, which tmp already holds
                    let o = ((y + i) * rw + x) * 3;
                    for c in 0..3 {
                        acc[c] += kv * tmp[o + c];
                    }
                }
                let o = (y * rw + x) * 3;
                blur[o..o + 3].copy_from_slice(&acc);
            }
        }
        let mut valid = vec![0u8; rh * rw];
        for y in 0..rh {
            for x in 0..rw {
                valid[y * rw + x] = u8::from(photo.valid(rx0 + x as isize, ry0 + y as isize));
            }
        }
        Region {
            x0: rx0,
            y0: ry0,
            rw,
            rh,
            img_w: photo.w,
            img_h: photo.h,
            blur,
            valid,
        }
    }
}

impl Field for Region {
    fn scale(&self) -> f64 {
        1.0
    }
    fn size(&self) -> (usize, usize) {
        (self.img_w, self.img_h)
    }
    fn holds(&self, x: isize, y: isize) -> bool {
        x >= self.x0
            && y >= self.y0
            && x < self.x0 + self.rw as isize
            && y < self.y0 + self.rh as isize
    }
    fn blur(&self, x: usize, y: usize) -> [f64; 3] {
        let (lx, ly) = (x - self.x0 as usize, y - self.y0 as usize);
        let o = (ly * self.rw + lx) * 3;
        [
            f64::from(self.blur[o]),
            f64::from(self.blur[o + 1]),
            f64::from(self.blur[o + 2]),
        ]
    }
    fn valid_px(&self, x: usize, y: usize) -> bool {
        let (lx, ly) = (x - self.x0 as usize, y - self.y0 as usize);
        self.valid[ly * self.rw + lx] != 0
    }
}

/// The whole photo downscaled with area averaging, then blurred: the wide search runs here.
struct Small {
    k: f64,
    w: usize,
    h: usize,
    blur: Vec<f32>,
    valid: Vec<u8>,
}

/// Source spans for area-average resizing: for each destination index, the source indices
/// it covers and the fraction of it each contributes.
fn area_spans(s: usize, d: usize) -> Vec<Vec<(usize, f32)>> {
    let f = s as f64 / d as f64;
    (0..d)
        .map(|i| {
            let (a, b) = (i as f64 * f, ((i + 1) as f64 * f).min(s as f64));
            let mut out = Vec::new();
            let mut p = a.floor() as usize;
            while (p as f64) < b && p < s {
                let lo = (p as f64).max(a);
                let hi = ((p + 1) as f64).min(b);
                if hi > lo {
                    out.push((p, ((hi - lo) / (b - a)) as f32));
                }
                p += 1;
            }
            out
        })
        .collect()
}

/// Area-average resize, as OpenCV's INTER_AREA does when shrinking. Source rows are read one
/// at a time through `row`, so a 12-megapixel photo is never copied whole into floats.
fn area_resize_rows(
    sw: usize,
    sh: usize,
    ch: usize,
    dw: usize,
    dh: usize,
    mut row: impl FnMut(usize, &mut [f32]),
) -> Vec<f32> {
    let (xs, ys) = (area_spans(sw, dw), area_spans(sh, dh));
    let mut contrib: Vec<Vec<(usize, f32)>> = vec![Vec::new(); sh];
    for (dy, parts) in ys.iter().enumerate() {
        for &(sy, wgt) in parts {
            contrib[sy].push((dy, wgt));
        }
    }
    let mut src = vec![0f32; sw * ch];
    let mut hrow = vec![0f32; dw * ch];
    let mut out = vec![0f32; dw * dh * ch];
    for (sy, targets) in contrib.iter().enumerate() {
        if targets.is_empty() {
            continue;
        }
        row(sy, &mut src);
        hrow.fill(0.0);
        for (dx, parts) in xs.iter().enumerate() {
            for &(sx, wgt) in parts {
                for c in 0..ch {
                    hrow[dx * ch + c] += wgt * src[sx * ch + c];
                }
            }
        }
        for &(dy, wgt) in targets {
            let base = dy * dw * ch;
            for i in 0..dw * ch {
                out[base + i] += wgt * hrow[i];
            }
        }
    }
    out
}

impl Small {
    fn new(photo: &Photo, k: f64) -> Small {
        let (w, h) = (
            ((photo.w as f64) * k).round().max(1.0) as usize,
            ((photo.h as f64) * k).round().max(1.0) as usize,
        );
        let small = area_resize_rows(photo.w, photo.h, 3, w, h, |y, row| {
            for x in 0..photo.w {
                let o = (y * photo.w + x) * 4;
                for c in 0..3 {
                    row[x * 3 + c] = f32::from(photo.rgba[o + c]);
                }
            }
        });
        let kern = gaussian9();
        let mut tmp = vec![0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0f32; 3];
                for (i, kv) in kern.iter().enumerate() {
                    let sx = reflect101(x as isize + i as isize - 4, w);
                    for c in 0..3 {
                        acc[c] += kv * small[(y * w + sx) * 3 + c];
                    }
                }
                tmp[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&acc);
            }
        }
        let mut blur = vec![0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0f32; 3];
                for (i, kv) in kern.iter().enumerate() {
                    let sy = reflect101(y as isize + i as isize - 4, h);
                    for c in 0..3 {
                        acc[c] += kv * tmp[(sy * w + x) * 3 + c];
                    }
                }
                blur[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&acc);
            }
        }
        // validity: nearest source pixel, as OpenCV's INTER_NEAREST picks it
        let (fx, fy) = (photo.w as f64 / w as f64, photo.h as f64 / h as f64);
        let mut valid = vec![0u8; w * h];
        for y in 0..h {
            let sy = ((y as f64 * fy).floor() as isize).min(photo.h as isize - 1);
            for x in 0..w {
                let sx = ((x as f64 * fx).floor() as isize).min(photo.w as isize - 1);
                valid[y * w + x] = u8::from(photo.valid(sx, sy));
            }
        }
        Small {
            k,
            w,
            h,
            blur,
            valid,
        }
    }
}

impl Field for Small {
    fn scale(&self) -> f64 {
        self.k
    }
    fn size(&self) -> (usize, usize) {
        (self.w, self.h)
    }
    fn holds(&self, _x: isize, _y: isize) -> bool {
        true
    }
    fn blur(&self, x: usize, y: usize) -> [f64; 3] {
        let o = (y * self.w + x) * 3;
        [
            f64::from(self.blur[o]),
            f64::from(self.blur[o + 1]),
            f64::from(self.blur[o + 2]),
        ]
    }
    fn valid_px(&self, x: usize, y: usize) -> bool {
        self.valid[y * self.w + x] != 0
    }
}

/* -------------------------------------------------------------------- print map */

/// Where the photo has print: fine, high-contrast structure (text, lines, stamps), found as
/// pixels that differ from their 9 by 9 median. 0 plain, 1 print, 2 not photo.
pub struct Detail {
    pub w: usize,
    pub h: usize,
    pub k: f64,
    pub map: Vec<u8>,
}

impl Detail {
    fn is_print(&self, x: f64, y: f64) -> bool {
        let dx = ((x * self.k) as isize).clamp(0, self.w as isize - 1) as usize;
        let dy = ((y * self.k) as isize).clamp(0, self.h as isize - 1) as usize;
        self.map[dy * self.w + dx] == 1
    }
}

/// Median of each 9 by 9 window with replicated borders (Huang's running histogram).
fn median9(g: &[u8], w: usize, h: usize) -> Vec<u8> {
    const R: isize = 4;
    const TARGET: u32 = 41;
    let at = |x: isize, y: isize| {
        g[(y.clamp(0, h as isize - 1) as usize) * w + x.clamp(0, w as isize - 1) as usize]
    };
    let mut out = vec![0u8; w * h];
    for y in 0..h as isize {
        let mut hist = [0u32; 256];
        for dy in -R..=R {
            for dx in -R..=R {
                hist[at(dx, y + dy) as usize] += 1;
            }
        }
        let mut m = 0usize;
        let mut lt = 0u32;
        while lt + hist[m] < TARGET {
            lt += hist[m];
            m += 1;
        }
        out[y as usize * w] = m as u8;
        for x in 1..w as isize {
            for dy in -R..=R {
                let old = at(x - R - 1, y + dy) as usize;
                hist[old] -= 1;
                if old < m {
                    lt -= 1;
                }
                let new = at(x + R, y + dy) as usize;
                hist[new] += 1;
                if new < m {
                    lt += 1;
                }
            }
            while lt >= TARGET {
                m -= 1;
                lt -= hist[m];
            }
            while lt + hist[m] < TARGET {
                lt += hist[m];
                m += 1;
            }
            out[y as usize * w + x as usize] = m as u8;
        }
    }
    out
}

pub fn detail_map_rgba(rgba: &[u8], width: usize, height: usize, turn: f64) -> Detail {
    let photo = Photo::new(rgba, width, height, turn);
    let k = (DETAIL_LONG / width.max(height) as f64).min(1.0);
    let grey = |o: usize| {
        ((u32::from(rgba[o]) * 4899
            + u32::from(rgba[o + 1]) * 9617
            + u32::from(rgba[o + 2]) * 1868
            + 8192)
            >> 14) as u8
    };
    let (w, h) = if k < 1.0 {
        (
            ((width as f64) * k).round().max(1.0) as usize,
            ((height as f64) * k).round().max(1.0) as usize,
        )
    } else {
        (width, height)
    };
    let small: Vec<u8> = if k < 1.0 {
        area_resize_rows(width, height, 1, w, h, |y, row| {
            for x in 0..width {
                row[x] = f32::from(grey((y * width + x) * 4));
            }
        })
        .iter()
        .map(|v| v.round().clamp(0.0, 255.0) as u8)
        .collect()
    } else {
        (0..width * height).map(|i| grey(i * 4)).collect()
    };
    let med = median9(&small, w, h);
    let (fx, fy) = (width as f64 / w as f64, height as f64 / h as f64);
    let mut map = vec![0u8; w * h];
    for y in 0..h {
        let sy = ((y as f64 * fy).floor() as isize).min(height as isize - 1);
        for x in 0..w {
            let sx = ((x as f64 * fx).floor() as isize).min(width as isize - 1);
            let i = y * w + x;
            map[i] = if !photo.valid(sx, sy) {
                2
            } else {
                u8::from((i32::from(small[i]) - i32::from(med[i])).abs() > DETAIL_THRESHOLD)
            };
        }
    }
    Detail { w, h, k, map }
}

/* ---------------------------------------------------------------------------- sides */

#[derive(Clone, Copy)]
struct Side {
    /// 0 top, 1 right, 2 bottom, 3 left
    id: usize,
    /// across = a + b (along - tc)
    a: f64,
    b: f64,
    tc: f64,
    kind: u8,
    sd: f64,
}

impl Side {
    fn horiz(&self) -> bool {
        self.id == 0 || self.id == 2
    }
    fn out(&self) -> f64 {
        if self.id == 0 || self.id == 3 {
            -1.0
        } else {
            1.0
        }
    }
    fn at(&self, t: f64) -> f64 {
        self.a + self.b * (t - self.tc)
    }
    fn with(&self, a: f64, b: f64, kind: u8, sd: f64) -> Side {
        Side {
            a,
            b,
            kind,
            sd,
            ..*self
        }
    }
    /// (x, y) of the point `c` across, `t` along
    fn xy(&self, t: f64, c: f64) -> (f64, f64) {
        if self.horiz() { (t, c) } else { (c, t) }
    }
}

fn meet(h: &Side, v: &Side) -> (f64, f64) {
    let x = (v.a + v.b * (h.a - h.b * h.tc - v.tc)) / (1.0 - h.b * v.b);
    (x, h.a + h.b * (x - h.tc))
}

fn quad_of(s: &[Side; 4]) -> [(f64, f64); 4] {
    let (top, right, bottom, left) = (&s[0], &s[1], &s[2], &s[3]);
    [
        meet(top, left),
        meet(top, right),
        meet(bottom, right),
        meet(bottom, left),
    ]
}

#[derive(Clone, Debug)]
struct Candidate {
    off: f64,
    slope: f64,
    score: f64,
    step: Option<f64>,
    internal: bool,
    broken: bool,
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    let pos = p * (v.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(v.len() - 1);
    v[lo] + (v[hi] - v[lo]) * (pos - lo as f64)
}

fn arange(start: f64, stop: f64, step: f64) -> Vec<f64> {
    let n = ((stop - start) / step).ceil().max(0.0) as usize;
    (0..n).map(|i| start + i as f64 * step).collect()
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![a];
    }
    (0..n)
        .map(|i| a + (b - a) * i as f64 / (n - 1) as f64)
        .collect()
}

struct Fitter<'a> {
    photo: Photo<'a>,
    detail: &'a Detail,
    small: Option<Small>,
    k: f64,
    step: f64,
}

impl<'a> Fitter<'a> {
    fn grad_kind(side: &Side) -> Sample {
        if side.horiz() {
            Sample::GradY
        } else {
            Sample::GradX
        }
    }

    /// Score every line side + off + slope (t - tc): |mean outward colour change|, and how
    /// many samples were valid.
    fn scan(
        &self,
        field: &dyn Field,
        side: &Side,
        ts: &[f64],
        offsets: &[f64],
        slopes: &[f64],
    ) -> (Vec<f64>, Vec<f64>) {
        let k = field.scale();
        let g = Self::grad_kind(side);
        let out = side.out();
        let mut scores = vec![0f64; slopes.len() * offsets.len()];
        let mut counts = vec![0f64; slopes.len() * offsets.len()];
        for (si, slope) in slopes.iter().enumerate() {
            for (oi, off) in offsets.iter().enumerate() {
                let mut sum = [0f64; 3];
                let mut n = 0usize;
                for &t in ts {
                    let c = (side.at(t) + off + slope * (t - side.tc)) * k;
                    let (x, y) = side.xy(t * k, c);
                    let (v, ok) = field.sample(x, y, g);
                    if ok {
                        for ch in 0..3 {
                            sum[ch] += v[ch] * out;
                        }
                        n += 1;
                    }
                }
                let d = n.max(1) as f64;
                let i = si * offsets.len() + oi;
                scores[i] =
                    ((sum[0] / d).powi(2) + (sum[1] / d).powi(2) + (sum[2] / d).powi(2)).sqrt();
                counts[i] = n as f64;
            }
        }
        (scores, counts)
    }

    fn noise(&self, field: &dyn Field, side: &Side, ts: &[f64], lo: f64, hi: f64) -> f64 {
        let k = field.scale();
        let g = Self::grad_kind(side);
        let mut vals: Vec<[f64; 3]> = Vec::new();
        for off in linspace(lo, hi, 24) {
            for &t in ts {
                let c = (side.at(t) + off) * k;
                let (x, y) = side.xy(t * k, c);
                let (v, ok) = field.sample(x, y, g);
                if ok {
                    vals.push(v);
                }
            }
        }
        if vals.len() < 50 {
            return 1e9;
        }
        let n = vals.len() as f64;
        let mut total = 0.0;
        for ch in 0..3 {
            let mean = vals.iter().map(|v| v[ch]).sum::<f64>() / n;
            total += vals.iter().map(|v| (v[ch] - mean).powi(2)).sum::<f64>() / n;
        }
        total.sqrt() / (ts.len() as f64).sqrt()
    }

    fn step_size(
        &self,
        field: &dyn Field,
        side: &Side,
        ts: &[f64],
        off: f64,
        slope: f64,
        gap: f64,
        width: f64,
    ) -> Option<f64> {
        let k = field.scale();
        let ds = arange(
            gap,
            gap + width + 0.01,
            if k < 1.0 { 1.0 / k.max(1e-6) } else { 1.0 },
        );
        let out = side.out();
        let mut diffs = Vec::new();
        for &t in ts {
            let base = side.at(t) + off + slope * (t - side.tc);
            let mut sides = [[f64::NAN; 3]; 2];
            for (si, sign) in [-1.0, 1.0].iter().enumerate() {
                let mut cols: [Vec<f64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
                for &d in &ds {
                    let c = (base + sign * out * d) * k;
                    let (x, y) = side.xy(t * k, c);
                    let (v, ok) = field.sample(x, y, Sample::Colour);
                    if ok {
                        for ch in 0..3 {
                            cols[ch].push(v[ch]);
                        }
                    }
                }
                if !cols[0].is_empty() {
                    for ch in 0..3 {
                        sides[si][ch] = median(&mut cols[ch]);
                    }
                }
            }
            let d = ((sides[0][0] - sides[1][0]).powi(2)
                + (sides[0][1] - sides[1][1]).powi(2)
                + (sides[0][2] - sides[1][2]).powi(2))
            .sqrt();
            if d.is_finite() {
                diffs.push(d);
            }
        }
        if diffs.len() as f64 > 0.3 * ts.len() as f64 {
            Some(median(&mut diffs))
        } else {
            None
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn candidates(
        &self,
        field: &dyn Field,
        side: &Side,
        ts: &[f64],
        offsets: &[f64],
        slopes: &[f64],
        gap: f64,
        width: f64,
        noise: f64,
        rel: f64,
    ) -> Vec<Candidate> {
        let (mut scores, counts) = self.scan(field, side, ts, offsets, slopes);
        let (ns, no) = (slopes.len(), offsets.len());
        for i in 0..scores.len() {
            if counts[i] < 0.4 * ts.len() as f64 {
                scores[i] = 0.0;
            }
        }
        let best = scores.iter().cloned().fold(0.0, f64::max);
        let mut per: Vec<f64> = (0..no)
            .map(|oi| {
                (0..ns)
                    .map(|si| scores[si * no + oi])
                    .fold(f64::MIN, f64::max)
            })
            .collect();
        let typical = if per.is_empty() {
            0.0
        } else {
            median(&mut per)
        };
        let noise = noise.min(typical.max(1e-6) / 3.0);
        let step_o = if no > 1 { offsets[1] - offsets[0] } else { 1.0 };
        let ro = ((1.5 / step_o).round() as isize).max(1);
        let rs = 2isize;
        let mut out = Vec::new();
        for si in 0..ns as isize {
            for oi in 0..no as isize {
                let v = scores[(si as usize) * no + oi as usize];
                let mut local = true;
                'n: for di in -rs..=rs {
                    for dj in -ro..=ro {
                        if di == 0 && dj == 0 {
                            continue;
                        }
                        let (a, b) = (si + di, oi + dj);
                        let nb = if a < 0 || b < 0 || a >= ns as isize || b >= no as isize {
                            -1.0
                        } else {
                            scores[a as usize * no + b as usize]
                        };
                        if v < nb {
                            local = false;
                            break 'n;
                        }
                    }
                }
                if !local || v <= 0.0 || v < rel * best || v < 6.0 * noise || v < 1.0 {
                    continue;
                }
                let (off, slope) = (offsets[oi as usize], slopes[si as usize]);
                let step = self.step_size(field, side, ts, off, slope, gap, width);
                out.push(Candidate {
                    off,
                    slope,
                    score: v,
                    step,
                    internal: false,
                    broken: false,
                });
            }
        }
        out.sort_by(|a, b| a.off.total_cmp(&b.off));
        out
    }

    /// Sub-pixel edge per sample around a line, then a trimmed least-squares line.
    fn refine(
        &self,
        field: &dyn Field,
        side: &Side,
        ts: &[f64],
        off: f64,
        slope: f64,
    ) -> Option<(f64, f64, f64)> {
        let g = Self::grad_kind(side);
        let out = side.out();
        let ds = arange(-3.0, 3.01, 0.25);
        let mut grads: Vec<([f64; 3], bool)> = Vec::with_capacity(ds.len() * ts.len());
        let mut dir = [0f64; 3];
        for &d in &ds {
            for &t in ts {
                let c = side.at(t) + off + slope * (t - side.tc) + d;
                let (x, y) = side.xy(t, c);
                let (mut v, ok) = field.sample(x, y, g);
                for ch in 0..3 {
                    v[ch] *= out;
                    if ok {
                        dir[ch] += v[ch];
                    }
                }
                grads.push((v, ok));
            }
        }
        let norm = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2])
            .sqrt()
            .max(1e-9);
        let dir = dir.map(|v| v / norm);
        let nt = ts.len();
        let along = |di: usize, ti: usize| {
            let (v, ok) = grads[di * nt + ti];
            if ok {
                (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]).max(0.0)
            } else {
                0.0
            }
        };
        let mut pts: Vec<(f64, f64)> = Vec::new();
        for (ti, &t) in ts.iter().enumerate() {
            let mut j = 0;
            for di in 1..ds.len() {
                if along(di, ti) > along(j, ti) {
                    j = di;
                }
            }
            if along(j, ti) <= 0.0 || j == 0 || j == ds.len() - 1 {
                continue;
            }
            let (y0, y1, y2) = (along(j - 1, ti), along(j, ti), along(j + 1, ti));
            let den = y0 - 2.0 * y1 + y2;
            let o = if den < 0.0 {
                0.5 * (y0 - y2) / den
            } else {
                0.0
            };
            let c0 = side.at(t) + off + slope * (t - side.tc);
            pts.push((t, c0 + ds[j] + o * 0.25));
        }
        if (pts.len() as f64) < 0.4 * nt as f64 || pts.len() < 20 {
            return None;
        }
        let mut keep = vec![true; pts.len()];
        let (mut a, mut b, mut sd) = (0.0, 0.0, 0.0);
        for _ in 0..4 {
            let (mut n, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for (p, &kp) in pts.iter().zip(&keep) {
                if kp {
                    let x = p.0 - side.tc;
                    n += 1.0;
                    sx += x;
                    sy += p.1;
                    sxx += x * x;
                    sxy += x * p.1;
                }
            }
            if n < 2.0 {
                return None;
            }
            let det = n * sxx - sx * sx;
            b = if det.abs() > 1e-12 {
                (n * sxy - sx * sy) / det
            } else {
                0.0
            };
            a = (sy - b * sx) / n;
            let mut res: Vec<f64> = pts
                .iter()
                .zip(&keep)
                .filter(|(_, k)| **k)
                .map(|(p, _)| (p.1 - (a + b * (p.0 - side.tc))).abs())
                .collect();
            sd = (1.4826 * median(&mut res)).max(0.3);
            for (p, kp) in pts.iter().zip(keep.iter_mut()) {
                *kp = (p.1 - (a + b * (p.0 - side.tc))).abs() < 2.5 * sd;
            }
        }
        Some((a, b, sd))
    }

    fn continuity(&self, field: &dyn Field, side: &Side, ts: &[f64], off: f64, slope: f64) -> f64 {
        let g = Self::grad_kind(side);
        let out = side.out();
        let ds = arange(-1.5, 1.51, 0.5);
        let nt = ts.len();
        let mut grads: Vec<([f64; 3], bool)> = Vec::with_capacity(ds.len() * nt);
        let mut dir = [0f64; 3];
        for &d in &ds {
            for &t in ts {
                let c = side.at(t) + off + slope * (t - side.tc) + d;
                let (x, y) = side.xy(t, c);
                let (mut v, ok) = field.sample(x, y, g);
                for ch in 0..3 {
                    v[ch] *= out;
                    if ok {
                        dir[ch] += v[ch];
                    }
                }
                grads.push((v, ok));
            }
        }
        let norm = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2])
            .sqrt()
            .max(1e-9);
        let dir = dir.map(|v| v / norm);
        let mut along = Vec::new();
        for ti in 0..nt {
            let mut best = 0f64;
            let mut any = false;
            for di in 0..ds.len() {
                let (v, ok) = grads[di * nt + ti];
                if ok {
                    any = true;
                    best = best.max((v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]).max(0.0));
                }
            }
            if any {
                along.push(best);
            }
        }
        if along.len() < 20 {
            return 1.0;
        }
        let mut sorted = along.clone();
        let strong = percentile(&mut sorted, 0.9);
        if strong <= 0.0 {
            return 0.0;
        }
        along.iter().filter(|&&v| v >= strong / 3.0).count() as f64 / along.len() as f64
    }

    /// Median colour, median per-row print density and median plain-pixel colour of the band
    /// d0..d1 pixels outward of the line `off` from the side, its rows following the side, so
    /// a side seen at an angle is sampled along itself.
    fn band(
        &self,
        side: &Side,
        ts: &[f64],
        off: f64,
        d0: f64,
        d1: f64,
    ) -> Option<([f64; 3], f64, [f64; 3])> {
        let (lo, hi) = if d0 <= d1 { (d0, d1) } else { (d1, d0) };
        let rows = arange(lo, hi + 0.01, ((hi - lo) / 24.0).max(1.0));
        let (w, h) = (self.photo.w as f64, self.photo.h as f64);
        let mut cols: [Vec<f64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
        let mut bgs: [Vec<f64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
        let mut dens = Vec::new();
        for r in rows {
            let mut pts = Vec::new();
            for &t in ts.iter().step_by(4) {
                let c = side.at(t) + off + side.out() * r;
                let (x, y) = side.xy(t, c);
                if x >= 0.0 && x <= w - 1.0 && y >= 0.0 && y <= h - 1.0 {
                    pts.push((x, y));
                }
            }
            if pts.len() < 5 {
                continue;
            }
            let real: Vec<(f64, f64)> = pts
                .into_iter()
                .filter(|&(x, y)| self.photo.valid(x as isize, y as isize))
                .collect();
            if real.len() < 5 {
                continue;
            }
            let mut n_print = 0usize;
            for &(x, y) in &real {
                let p = self.photo.px(x as usize, y as usize);
                let print = self.detail.is_print(x, y);
                for ch in 0..3 {
                    cols[ch].push(p[ch]);
                    if !print {
                        bgs[ch].push(p[ch]);
                    }
                }
                n_print += usize::from(print);
            }
            dens.push(n_print as f64 / real.len() as f64);
        }
        if dens.is_empty() {
            return None;
        }
        let colour = [
            median(&mut cols[0]),
            median(&mut cols[1]),
            median(&mut cols[2]),
        ];
        let bg = if bgs[0].len() >= 10 {
            [
                median(&mut bgs[0]),
                median(&mut bgs[1]),
                median(&mut bgs[2]),
            ]
        } else {
            colour
        };
        Some((colour, median(&mut dens), bg))
    }

    /// Whether an edge candidate lies inside the document rather than at its boundary.
    fn internal(&self, side: &Side, ts: &[f64], line: f64, span: f64, step: f64) -> bool {
        let across = if side.horiz() {
            self.photo.h
        } else {
            self.photo.w
        } as f64;
        // how far the frame's edge lies beyond the line `line` from the side, at its middle
        let mid = ts.iter().sum::<f64>() / ts.len() as f64;
        let at_mid = side.at(mid) + line;
        let to_border = if side.out() < 0.0 {
            at_mid
        } else {
            across - 1.0 - at_mid
        };
        let wn = (0.02 * span).max(8.0);
        let gap = 3.0;
        let near = (0.008 * span).max(6.0);
        // 4. the model runs the document off the frame here, and print carries on past the line
        //    to the frame's edge: the frame cuts through a printed border or a table, and the
        //    sheet's own edge lies outside the photo. Judged first: it also covers lines a few
        //    pixels from the frame, which the rules below leave alone.
        let model_gap = ts
            .iter()
            .map(|&t| {
                let c = side.at(t);
                if side.out() < 0.0 {
                    c
                } else {
                    across - 1.0 - c
                }
            })
            .fold(f64::MAX, f64::min);
        if model_gap <= (1.5 * across / 256.0).max(4.0)
            && to_border >= gap + 1.0
            && let Some(past) = self.band(side, ts, line, gap, (gap + near).min(to_border))
            && past.1 >= 0.1
        {
            return true;
        }
        if to_border < gap + 4.0 {
            return false;
        }
        let (Some(beyond), Some(inside)) = (
            self.band(side, ts, line, gap, (gap + wn).min(to_border)),
            self.band(side, ts, line, -gap - wn, -gap),
        ) else {
            return false;
        };
        let dist = |a: [f64; 3], b: [f64; 3]| {
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };
        let cdist = dist(beyond.0, inside.0);
        // 1. the same paper on both sides of a line of print, a crease with print about
        if cdist < 18.0
            && beyond.1.min(inside.1) >= 0.02
            && (beyond.1 - inside.1).abs() < 0.66 * beyond.1.max(inside.1)
        {
            return true;
        }
        // 2. print pressed against one side, the same plain paper on the other: the edge of a
        //    block of text, not of the sheet, which leaves a margin before any print
        if let (Some(ci), Some(co)) = (
            self.band(side, ts, line, -gap - near, -gap),
            self.band(side, ts, line, gap, gap + near),
        ) {
            let (dense, plain) = (ci.1.max(co.1), ci.1.min(co.1));
            if dense >= 0.1 && plain < 0.03 && dist(ci.2, co.2) < 25.0 {
                return true;
            }
        }
        // 3. one plain surface on both sides and only a faint line between: a crease or shadow
        if cdist < 12.0 && beyond.1.max(inside.1) < 0.02 && step < 12.0 {
            return true;
        }
        false
    }

    fn judge(&self, full: &dyn Field, side: &Side, ts: &[f64], span: f64, list: &mut [Candidate]) {
        for c in list.iter_mut() {
            c.internal = self.internal(side, ts, c.off, span, c.step.unwrap_or(99.0));
            let cont = self.continuity(full, side, ts, c.off, c.slope);
            if cont < CONTINUITY_MIN && !c.internal {
                c.internal = true;
                c.broken = true;
            }
        }
    }

    fn side_samples(&self, side: &Side, q: &[(f64, f64); 4]) -> (Vec<f64>, f64) {
        let (a, b) = match side.id {
            0 => (q[0].0, q[1].0),
            2 => (q[3].0, q[2].0),
            3 => (q[0].1, q[3].1),
            _ => (q[1].1, q[2].1),
        };
        let (lo, hi) = (a.min(b), a.max(b));
        let span = hi - lo;
        let limit = if side.horiz() {
            self.photo.w
        } else {
            self.photo.h
        } as f64
            - 1.0;
        let ts: Vec<f64> = linspace(
            lo + CORNER_MARGIN * span,
            hi - CORNER_MARGIN * span,
            SAMPLES,
        )
        .into_iter()
        .filter(|&t| t >= 0.0 && t <= limit)
        .collect();
        (ts, span)
    }

    /// A full-resolution region covering every line side + off + slope (t - tc) for offsets
    /// lo..hi and |slope| <= smax, padded by `pad`.
    fn region_for(&self, side: &Side, ts: &[f64], lo: f64, hi: f64, smax: f64, pad: f64) -> Region {
        let (t0, t1) = (ts[0], ts[ts.len() - 1]);
        let mut c_lo = f64::MAX;
        let mut c_hi = f64::MIN;
        for &t in &[t0, t1] {
            let base = side.at(t);
            let drift = smax * (t - side.tc).abs();
            c_lo = c_lo.min(base + lo - drift);
            c_hi = c_hi.max(base + hi + drift);
        }
        let (c_lo, c_hi) = (c_lo - pad, c_hi + pad);
        if side.horiz() {
            Region::new(&self.photo, t0 - 2.0, c_lo, t1 + 2.0, c_hi)
        } else {
            Region::new(&self.photo, c_lo, t0 - 2.0, c_hi, t1 + 2.0)
        }
    }

    fn border(&self, side: &Side) -> Side {
        let a = match side.id {
            0 | 3 => 0.0,
            2 => self.photo.h as f64 - 1.0,
            _ => self.photo.w as f64 - 1.0,
        };
        side.with(a, 0.0, KIND_BORDER, 0.0)
    }

    /// `prior` is the model's outline as a quadrilateral, corners top-left, top-right,
    /// bottom-right, bottom-left, in pixels. Each side's search starts from its line, tilt
    /// included, so a document photographed at an angle is searched along its own edges.
    fn fit(&mut self, prior: [f64; 8]) -> [Side; 4] {
        let (w, h) = (self.photo.w as f64, self.photo.h as f64);
        let (cx, cy) = (w / 256.0, h / 256.0);
        let corner = |i: usize| (prior[2 * i], prior[2 * i + 1]);
        let (tl, tr, br, bl) = (corner(0), corner(1), corner(2), corner(3));
        let (x0, x1) = (tl.0.min(bl.0), tr.0.max(br.0));
        let (y0, y1) = (tl.1.min(tr.1), bl.1.max(br.1));
        let (tx, ty) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        // the side through two points given as (along, across)
        let through = |id: usize, (t0, c0): (f64, f64), (t1, c1): (f64, f64), tc: f64| {
            let b = if (t1 - t0).abs() > 1e-9 {
                (c1 - c0) / (t1 - t0)
            } else {
                0.0
            };
            Side {
                id,
                a: c0 + b * (tc - t0),
                b,
                tc,
                kind: KIND_PRIOR,
                sd: 0.0,
            }
        };
        let flip = |(x, y): (f64, f64)| (y, x);
        let mut sides = [
            through(0, tl, tr, tx),
            through(1, flip(tr), flip(br), ty),
            through(2, bl, br, tx),
            through(3, flip(tl), flip(bl), ty),
        ];
        let slopes = linspace(-0.035, 0.035, 29);
        for pass in 0..2 {
            let q = quad_of(&sides);
            let mut next = sides;
            for (i, side) in sides.iter().enumerate() {
                let (ts, span) = self.side_samples(side, &q);
                if ts.len() < 20 {
                    next[i] = if pass == 0 { self.border(side) } else { *side };
                    continue;
                }
                let across = if side.horiz() { h } else { w };
                let cell = if side.horiz() { cy } else { cx };
                let size_across = if side.horiz() { y1 - y0 } else { x1 - x0 };
                let (gap, width) = ((0.3 * cell).max(3.0), (1.5 * cell).max(8.0));
                if pass == 1 {
                    // re-measure the edge chosen in the first pass, never choose again
                    if side.kind == KIND_BORDER || side.kind == KIND_PRIOR {
                        continue;
                    }
                    let band2 = (0.5 * cell).max(2.0);
                    let offsets = arange(-band2, band2 + 0.01, 0.25);
                    let slopes9 = linspace(-0.004, 0.004, 9);
                    let region = self.region_for(
                        side,
                        &ts,
                        -band2 - 4.0,
                        band2 + 4.0,
                        0.004,
                        gap + width + 4.0,
                    );
                    let cands = self.candidates(
                        &region, side, &ts, &offsets, &slopes9, gap, width, 1e-9, 0.0,
                    );
                    let (off, slope) = cands
                        .iter()
                        .fold(None::<&Candidate>, |best, c| match best {
                            Some(b) if b.score >= c.score => Some(b),
                            _ => Some(c),
                        })
                        .map_or((0.0, 0.0), |c| (c.off, c.slope));
                    next[i] = match self.refine(&region, side, &ts, off, slope) {
                        Some((a, b, sd)) => side.with(a, b, side.kind, sd),
                        None => side.with(side.a + off, side.b + slope, side.kind, 9.9),
                    };
                    continue;
                }
                let band = (2.5 * cell).max(0.012 * span.max(size_across)).max(8.0);
                let offsets = arange(-band, band + 0.01, 0.5);
                let region =
                    self.region_for(side, &ts, -band - 4.0, band + 4.0, 0.035, gap + width + 4.0);
                let noise = self.noise(&region, side, &ts, -band, band);
                let mut good: Vec<Candidate> = self
                    .candidates(
                        &region, side, &ts, &offsets, &slopes, gap, width, noise, 0.5,
                    )
                    .into_iter()
                    .filter(|c| c.step.is_none_or(|s| s >= 5.0))
                    .collect();
                self.judge(&region, side, &ts, span, &mut good);
                let rejected_patchy = good.iter().any(|c| c.broken);
                let good: Vec<Candidate> = good.into_iter().filter(|c| !c.internal).collect();
                let mut chosen: Option<(Candidate, u8)> = None;
                if good.is_empty() && rejected_patchy {
                    next[i] = side.with(side.a, side.b, KIND_PRIOR, 0.0);
                    continue;
                }
                if !good.is_empty() {
                    chosen = Some((pick_cluster(&good, cell.max(6.0)), KIND_NEAR));
                } else {
                    let reach = if side.out() < 0.0 {
                        ts.iter().map(|&t| side.at(t)).fold(f64::MAX, f64::min)
                    } else {
                        across - 1.0 - ts.iter().map(|&t| side.at(t)).fold(f64::MIN, f64::max)
                    };
                    if reach > band {
                        if self.small.is_none() {
                            self.small = Some(Small::new(&self.photo, self.k));
                        }
                        let small = self.small.as_ref().unwrap();
                        let mut offs: Vec<f64> = arange(-band, reach, self.step)
                            .into_iter()
                            .map(|o| o * side.out())
                            .collect();
                        offs.sort_by(f64::total_cmp);
                        let (lo, hi) = (offs[0], offs[offs.len() - 1]);
                        let noise = self.noise(small, side, &ts, lo, hi);
                        let mut wide: Vec<Candidate> = self
                            .candidates(small, side, &ts, &offs, &slopes, gap, width, noise, 0.3)
                            .into_iter()
                            .filter(|c| c.step.is_some_and(|s| s >= 5.0))
                            .collect();
                        // judge each at full resolution, around its own line
                        for c in wide.iter_mut() {
                            let region = self.region_for(
                                side,
                                &ts,
                                c.off - 4.0,
                                c.off + 4.0,
                                c.slope.abs(),
                                4.0,
                            );
                            let mut one = [c.clone()];
                            self.judge(&region, side, &ts, span, &mut one);
                            *c = one[0].clone();
                        }
                        if let Some(best) = wide.into_iter().filter(|c| !c.internal).fold(
                            None::<Candidate>,
                            |best, c| match best {
                                Some(b) if b.off * side.out() >= c.off * side.out() => Some(b),
                                _ => Some(c),
                            },
                        ) {
                            chosen = Some((best, KIND_WIDE));
                        }
                    }
                }
                let Some((c, kind)) = chosen else {
                    next[i] = self.border(side);
                    continue;
                };
                let region =
                    self.region_for(side, &ts, c.off - 4.0, c.off + 4.0, c.slope.abs(), 4.0);
                next[i] = match self.refine(&region, side, &ts, c.off, c.slope) {
                    Some((a, b, sd)) => side.with(a, b, kind, sd),
                    None => side.with(side.a + c.off, side.b + c.slope, kind, 9.9),
                };
            }
            sides = next;
        }
        sides
    }
}

/// Edges a few pixels apart are one edge seen twice: the strongest wins. Further apart they
/// are different things: the group nearest the model's side wins.
fn pick_cluster(good: &[Candidate], gap: f64) -> Candidate {
    let mut sorted: Vec<&Candidate> = good.iter().collect();
    sorted.sort_by(|a, b| a.off.total_cmp(&b.off));
    let mut groups: Vec<Vec<&Candidate>> = vec![vec![sorted[0]]];
    for c in &sorted[1..] {
        if c.off - groups.last().unwrap().last().unwrap().off <= gap {
            groups.last_mut().unwrap().push(c);
        } else {
            groups.push(vec![c]);
        }
    }
    let nearest = |g: &Vec<&Candidate>| g.iter().map(|c| c.off.abs()).fold(f64::MAX, f64::min);
    let mut group = &groups[0];
    for g in &groups[1..] {
        if nearest(g) < nearest(group) {
            group = g;
        }
    }
    let mut best = group[0];
    for c in &group[1..] {
        if c.score > best.score {
            best = c;
        }
    }
    best.clone()
}

/// Fit a document's four sides around the model's rough outline (a quadrilateral, corners
/// top-left, top-right, bottom-right, bottom-left, in pixels) in a photo straightened by
/// `turn` degrees. Returns the corners in the same order (eight numbers), then for each side,
/// top, right, bottom, left, how it was found (KIND_*), then each side's scatter in pixels.
pub fn fit_document_rgba(
    rgba: &[u8],
    width: usize,
    height: usize,
    turn: f64,
    prior: [f64; 8],
    detail: &Detail,
) -> Vec<f64> {
    let k = (WORK_LONG / width.max(height) as f64).min(1.0);
    let mut fitter = Fitter {
        photo: Photo::new(rgba, width, height, turn),
        detail,
        small: None,
        k,
        step: (0.5f64).max(0.5 / k),
    };
    if k >= 1.0 {
        // small images search wide at full resolution, as the reference does
        fitter.step = 0.5;
    }
    let sides = fitter.fit(prior);
    let q = quad_of(&sides);
    let mut out: Vec<f64> = q.iter().flat_map(|&(x, y)| [x, y]).collect();
    out.extend(sides.iter().map(|s| f64::from(s.kind)));
    out.extend(sides.iter().map(|s| s.sd));
    out
}

impl RgbaFrame {
    pub(crate) fn detail_map_impl(&self, turn: f64) -> Detail {
        detail_map_rgba(&self.pixels, self.width, self.height, turn)
    }

    pub(crate) fn fit_document_impl(
        &self,
        turn: f64,
        prior: [f64; 8],
        detail: &Detail,
    ) -> Vec<f64> {
        fit_document_rgba(&self.pixels, self.width, self.height, turn, prior, detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey sheet with lines of "words" on a brown, grainy desk. `sheet` is x0, y0, x1, y1
    /// and may run past the frame; `lines` are the text lines' top rows.
    fn sheet_photo(w: usize, h: usize, sheet: [f64; 4], lines: &[usize]) -> Vec<u8> {
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let grain = ((x * 7919 + y * 104_729) % 29) as f64 - 14.0;
                let (fx, fy) = (x as f64, y as f64);
                let on = fx >= sheet[0] && fx < sheet[2] && fy >= sheet[1] && fy < sheet[3];
                let mut c = if on {
                    [205.0, 204.0, 198.0]
                } else {
                    [120.0 + grain, 82.0 + grain, 50.0 + grain]
                };
                if on {
                    for &top in lines {
                        // words 30 to 70 px long with 12 px gaps, 8 px tall, inside 40 px margins
                        if y >= top
                            && y < top + 8
                            && fx > sheet[0].max(0.0) + 40.0
                            && fx < sheet[2].min(w as f64) - 40.0
                        {
                            let phase = (x + top * 3) % 64;
                            if phase < 52 && (x + y) % 3 != 0 {
                                c = [45.0, 45.0, 50.0];
                            }
                        }
                    }
                }
                let o = (y * w + x) * 4;
                for ch in 0..3 {
                    rgba[o + ch] = c[ch].clamp(0.0, 255.0) as u8;
                }
            }
        }
        rgba
    }

    /// A plain sheet seen in perspective: inside the quadrilateral `q` (top-left, top-right,
    /// bottom-right, bottom-left), on the same grainy desk.
    fn tilted_sheet_photo(w: usize, h: usize, q: [(f64, f64); 4]) -> Vec<u8> {
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
                let inside = (0..4).all(|i| {
                    let ((ax, ay), (bx, by)) = (q[i], q[(i + 1) % 4]);
                    (bx - ax) * (fy - ay) - (by - ay) * (fx - ax) >= 0.0
                });
                let grain = ((x * 7919 + y * 104_729) % 29) as f64 - 14.0;
                let c = if inside {
                    [205.0, 204.0, 198.0]
                } else {
                    [120.0 + grain, 82.0 + grain, 50.0 + grain]
                };
                let o = (y * w + x) * 4;
                for ch in 0..3 {
                    rgba[o + ch] = c[ch] as u8;
                }
            }
        }
        rgba
    }

    fn fit(rgba: &[u8], w: usize, h: usize, [x0, y0, x1, y1]: [f64; 4]) -> Vec<f64> {
        let detail = detail_map_rgba(rgba, w, h, 0.0);
        fit_document_rgba(rgba, w, h, 0.0, [x0, y0, x1, y0, x1, y1, x0, y1], &detail)
    }

    #[test]
    fn a_sheet_on_a_desk_is_cut_at_its_edges_and_kept_whole_where_it_leaves_the_frame() {
        let (w, h) = (800usize, 600usize);
        // the sheet runs off the bottom; text starts 30 px below its top edge
        let rgba = sheet_photo(
            w,
            h,
            [100.0, 80.0, 700.0, 900.0],
            &[110, 140, 170, 200, 230, 260],
        );
        let found = fit(&rgba, w, h, [106.0, 86.0, 694.0, 600.0]);
        let (top, right, bottom, left) = (found[1], found[2], found[5], found[0]);
        assert!((top - 80.0).abs() < 1.5, "top edge at {top}");
        assert!((left - 100.0).abs() < 1.5, "left edge at {left}");
        assert!((right - 700.0).abs() < 1.5, "right edge at {right}");
        assert_eq!(
            found[8 + 2] as u8,
            KIND_BORDER,
            "the sheet leaves the frame at the bottom"
        );
        assert!(bottom >= h as f64 - 1.0);
    }

    #[test]
    fn a_sheet_photographed_at_an_angle_is_measured_along_its_tilted_edges() {
        let (w, h) = (800usize, 600usize);
        // edges tilted 2 to 9 degrees; the outline is the model's, a few pixels off each corner
        let truth = [(150.0, 80.0), (650.0, 100.0), (720.0, 540.0), (90.0, 520.0)];
        let rgba = tilted_sheet_photo(w, h, truth);
        let detail = detail_map_rgba(&rgba, w, h, 0.0);
        let outline = [154.0, 77.0, 646.0, 104.0, 723.0, 536.0, 94.0, 523.0];
        let found = fit_document_rgba(&rgba, w, h, 0.0, outline, &detail);
        for (i, &(x, y)) in truth.iter().enumerate() {
            let off = (found[2 * i] - x).hypot(found[2 * i + 1] - y);
            assert!(off < 1.5, "corner {i} is {off:.1} px off");
        }
        for side in 0..4 {
            assert_eq!(found[8 + side] as u8, KIND_NEAR, "side {side} measured");
        }
    }

    #[test]
    fn a_printed_border_cut_by_the_frame_is_kept_up_to_the_frame() {
        let (w, h) = (1800usize, 1350usize);
        // the sheet runs off the bottom, and so does the ornamental band printed along it:
        // bars on a tinted ground, cut by the frame 14 px below the band's inner edge
        let mut rgba = sheet_photo(w, h, [200.0, 150.0, 1600.0, 2000.0], &[300, 360, 420]);
        for y in h - 14..h {
            for x in 240..1560 {
                let ink = if (y / 3) % 2 == 0 {
                    [45, 45, 50]
                } else {
                    [150, 150, 160]
                };
                let o = (y * w + x) * 4;
                rgba[o..o + 3].copy_from_slice(&ink);
            }
        }
        // the model's outline runs to the frame at the bottom; the crop may not cut into the band
        let found = fit(&rgba, w, h, [208.0, 158.0, 1592.0, 1350.0]);
        for corner in [2, 3] {
            let y = found[2 * corner + 1];
            assert!(
                y >= h as f64 - 4.0,
                "bottom kept at the frame, not cut along the band (at {y})"
            );
        }
        assert!((found[1] - 150.0).abs() < 1.5, "top edge at {}", found[1]);
    }

    #[test]
    fn the_first_line_of_text_is_not_the_top_of_a_sheet_that_runs_off_the_frame() {
        let (w, h) = (800usize, 600usize);
        // the sheet starts above the frame; the model stopped at the first line of text
        let rgba = sheet_photo(w, h, [100.0, -60.0, 700.0, 520.0], &[26, 56, 86, 116]);
        let found = fit(&rgba, w, h, [106.0, 24.0, 694.0, 514.0]);
        assert_eq!(
            found[8] as u8, KIND_BORDER,
            "top kept at the frame, not cut at the text (top at {})",
            found[1]
        );
        assert!(
            (found[5] - 520.0).abs() < 1.5,
            "bottom edge at {}",
            found[5]
        );
    }
}
