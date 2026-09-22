//! Browser imaging primitives shared through WebAssembly.

use wasm_bindgen::prelude::*;

mod card;

const LIMIT_TENTHS: i32 = 50;
const WORK_WIDTH: usize = 800;
const INSET: f64 = 0.08;
const THRESHOLD_RADIUS: usize = 15;
const THRESHOLD_OFFSET: f64 = 15.0;

/// A frame whose pixel storage lives in WebAssembly memory.
///
/// JavaScript copies an `ImageData` into `pixels_ptr()` once. Every operation after that
/// reads the same allocation, so repeated calls do not marshal or clone the full frame.
#[wasm_bindgen]
pub struct RgbaFrame {
    pixels: Vec<u8>,
    width: usize,
    height: usize,
}

#[wasm_bindgen]
impl RgbaFrame {
    #[wasm_bindgen(constructor)]
    pub fn new(width: usize, height: usize) -> Result<RgbaFrame, JsError> {
        let len = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| JsError::new("frame dimensions overflow"))?;
        if width == 0 || height == 0 {
            return Err(JsError::new("frame dimensions must be non-zero"));
        }
        Ok(Self {
            pixels: vec![0; len],
            width,
            height,
        })
    }

    pub fn pixels_ptr(&mut self) -> *mut u8 {
        self.pixels.as_mut_ptr()
    }

    pub fn pixels_len(&self) -> usize {
        self.pixels.len()
    }

    /// A live `Uint8Array` over this frame's WebAssembly allocation, not a copied array.
    pub fn pixels_view(&mut self) -> js_sys::Uint8Array {
        // The view must not outlive the frame or a future memory growth. JavaScript fills it
        // immediately and discards it; the owned frame keeps the allocation stable after that.
        unsafe { js_sys::Uint8Array::view(&self.pixels) }
    }

    pub fn estimate_skew(&self) -> f64 {
        estimate_skew_rgba(&self.pixels, self.width, self.height)
    }

    /// Pull a rough box onto strong straight edges, searching mostly outwards.
    pub fn snap_edges(
        &self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        reach: f64,
        prominence: f64,
    ) -> Vec<f64> {
        snap_edges_rgba(
            &self.pixels,
            self.width,
            self.height,
            [x0, y0, x1, y1],
            reach,
            prominence,
        )
        .to_vec()
    }

    /// Clear crop pixels that fall outside the cleaned document mask.
    pub fn trim_mask(
        &mut self,
        mask: &[f32],
        size: usize,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        mask_x0: f64,
        mask_y0: f64,
        mask_x1: f64,
        mask_y1: f64,
    ) {
        trim_mask_rgba(
            &mut self.pixels,
            self.width,
            self.height,
            mask,
            size,
            [x0, y0, x1, y1],
            [mask_x0, mask_y0, mask_x1, mask_y1],
        );
    }

    /// Apply luminance CLAHE and/or a shared RGB white-point stretch in place.
    pub fn apply_tone(&mut self, clip_limit: f64, stretch: bool) {
        apply_tone_rgba(
            &mut self.pixels,
            self.width,
            self.height,
            clip_limit,
            stretch,
        );
    }

    /// Extract and straighten a rotated rectangle in one bilinear resample.
    pub fn extract_rotated(
        &self,
        center_x: f64,
        center_y: f64,
        width: f64,
        height: f64,
        angle_degrees: f64,
    ) -> RgbaFrame {
        extract_rotated_rgba(
            &self.pixels,
            self.width,
            self.height,
            center_x,
            center_y,
            width,
            height,
            angle_degrees,
        )
    }

    /// Fit a card's four edges inside a rough box, in pixels, in a frame straightened by
    /// `turn` degrees. Returns eight corner coordinates, four edge scatters and four agreement
    /// fractions, or nothing. See card.rs.
    pub fn fit_card(&self, x0: f64, y0: f64, x1: f64, y1: f64, turn: f64) -> Vec<f64> {
        self.fit_card_impl([x0, y0, x1, y1], turn)
    }

    /// Square up the quadrilateral top-left, top-right, bottom-right, bottom-left into a
    /// new frame of the given size, with bicubic sampling.
    pub fn warp_quad(&self, quad: &[f64], width: usize, height: usize) -> Result<RgbaFrame, JsError> {
        if quad.len() < 8 || width == 0 || height == 0 {
            return Err(JsError::new("warp_quad needs eight coordinates and a non-empty size"));
        }
        Ok(self.warp_quad_impl(quad, width, height))
    }

    /// Measure each corner's rounding, starting from `standard` pixels, and whiten outside it.
    /// Returns the four radii used: top-left, top-right, bottom-right, bottom-left.
    pub fn round_card_corners(&mut self, standard: f64) -> Vec<f64> {
        self.round_card_corners_impl(standard)
    }

    /// Tighten a SAM rectangle against full-resolution edges in its straightened frame.
    pub fn refine_rotated_rect(
        &self,
        center_x: f64,
        center_y: f64,
        width: f64,
        height: f64,
        angle_degrees: f64,
    ) -> Vec<f64> {
        refine_rotated_rect_rgba(
            &self.pixels,
            self.width,
            self.height,
            center_x,
            center_y,
            width,
            height,
            angle_degrees,
        )
        .to_vec()
    }
}

fn grey_at(rgba: &[u8], width: usize, x: usize, y: usize) -> f64 {
    let offset = (y * width + x) * 4;
    0.299 * f64::from(rgba[offset])
        + 0.587 * f64::from(rgba[offset + 1])
        + 0.114 * f64::from(rgba[offset + 2])
}

fn snap_edges_rgba(
    rgba: &[u8],
    width: usize,
    height: usize,
    original: [f64; 4],
    reach: f64,
    prominence: f64,
) -> [f64; 4] {
    let [x0, y0, x1, y1] = original;
    let px0 = (x0 * width as f64).round() as usize;
    let px1 = (x1 * width as f64).round() as usize;
    let py0 = (y0 * height as f64).round() as usize;
    let py1 = (y1 * height as f64).round() as usize;
    let band_y0 = py0 + (py1.saturating_sub(py0) / 4);
    let band_y1 = py1.saturating_sub(py1.saturating_sub(py0) / 4);
    let band_x0 = px0 + (px1.saturating_sub(px0) / 4);
    let band_x1 = px1.saturating_sub(px1.saturating_sub(px0) / 4);

    let mut columns = vec![0.0_f64; width];
    for y in band_y0.min(height)..band_y1.min(height) {
        for (x, column) in columns.iter_mut().enumerate().take(width - 1).skip(1) {
            *column += (grey_at(rgba, width, x + 1, y) - grey_at(rgba, width, x - 1, y)).abs();
        }
    }
    let mut rows = vec![0.0_f64; height];
    for (y, row) in rows.iter_mut().enumerate().take(height - 1).skip(1) {
        for x in band_x0.min(width)..band_x1.min(width) {
            *row += (grey_at(rgba, width, x, y + 1) - grey_at(rgba, width, x, y - 1)).abs();
        }
    }

    let median = |profile: &[f64]| {
        let mut nonzero: Vec<f64> = profile
            .iter()
            .copied()
            .filter(|value| *value > 0.0)
            .collect();
        nonzero.sort_by(f64::total_cmp);
        nonzero.get(nonzero.len() / 2).copied().unwrap_or(1.0)
    };
    let pick = |profile: &[f64], centre: usize, span: f64, sign: i8, med: f64| {
        let outward = span.round() as usize;
        let inward = (span * 0.2).round() as usize;
        let low = centre.saturating_sub(if sign < 0 { outward } else { inward });
        let high = (centre + if sign < 0 { inward } else { outward }).min(profile.len());
        let mut best = centre;
        let mut best_value = 0.0;
        for (index, &value) in profile.iter().enumerate().take(high).skip(low) {
            if value > best_value {
                best = index;
                best_value = value;
            }
        }
        if best_value > med * prominence {
            best
        } else {
            centre
        }
    };

    let next_x0 = pick(&columns, px0, width as f64 * reach, -1, median(&columns));
    let next_x1 = pick(&columns, px1, width as f64 * reach, 1, median(&columns));
    let next_y0 = pick(&rows, py0, height as f64 * reach, -1, median(&rows));
    let next_y1 = pick(&rows, py1, height as f64 * reach, 1, median(&rows));
    if next_x1.saturating_sub(next_x0) < (width as f64 * 0.2) as usize
        || next_y1.saturating_sub(next_y0) < (height as f64 * 0.2) as usize
    {
        return original;
    }
    [
        next_x0 as f64 / width as f64,
        next_y0 as f64 / height as f64,
        next_x1 as f64 / width as f64,
        next_y1 as f64 / height as f64,
    ]
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

fn cross(origin: Point, a: Point, b: Point) -> f64 {
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

fn convex_hull(mut points: Vec<Point>) -> Vec<Point> {
    points.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    points.dedup();
    if points.len() <= 2 {
        return points;
    }
    let mut lower = Vec::new();
    for &point in &points {
        while lower.len() >= 2
            && cross(lower[lower.len() - 2], lower[lower.len() - 1], point) <= 0.0
        {
            lower.pop();
        }
        lower.push(point);
    }
    let mut upper = Vec::new();
    for &point in points.iter().rev() {
        while upper.len() >= 2
            && cross(upper[upper.len() - 2], upper[upper.len() - 1], point) <= 0.0
        {
            upper.pop();
        }
        upper.push(point);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Fill one convex silhouette around every positive component in a square mask.
#[wasm_bindgen]
pub fn clean_mask(mask: &[f32], size: usize) -> Vec<f32> {
    assert_eq!(mask.len(), size * size);
    let mut points = Vec::new();
    for y in 0..size {
        let mut first = None;
        let mut last = None;
        for x in 0..size {
            if mask[y * size + x] > 0.0 {
                first.get_or_insert(x);
                last = Some(x);
            }
        }
        if let (Some(first), Some(last)) = (first, last) {
            points.push(Point {
                x: first as f64,
                y: y as f64,
            });
            points.push(Point {
                x: last as f64,
                y: y as f64,
            });
        }
    }
    let hull = convex_hull(points);
    if hull.len() < 3 {
        return mask.to_vec();
    }
    let mut output = vec![-1.0_f32; size * size];
    for y in 0..size {
        let mut low = f64::INFINITY;
        let mut high = f64::NEG_INFINITY;
        for i in 0..hull.len() {
            let a = hull[i];
            let b = hull[(i + 1) % hull.len()];
            if (a.y <= y as f64 && b.y > y as f64) || (b.y <= y as f64 && a.y > y as f64) {
                let t = (y as f64 - a.y) / (b.y - a.y);
                let x = a.x + t * (b.x - a.x);
                low = low.min(x);
                high = high.max(x);
            }
            if a.y == y as f64 {
                low = low.min(a.x);
                high = high.max(a.x);
            }
        }
        if low > high {
            continue;
        }
        let x0 = low.round().max(0.0) as usize;
        let x1 = high.round().min((size - 1) as f64) as usize;
        for x in x0..=x1 {
            output[y * size + x] = 1.0;
        }
    }
    output
}

fn mask_value(mask: &[f32], size: usize, x: isize, y: isize) -> f64 {
    let x = x.clamp(0, size as isize - 1) as usize;
    let y = y.clamp(0, size as isize - 1) as usize;
    f64::from(mask[y * size + x])
}

/// Where a scanline at `y` enters and leaves a convex polygon, or None when it misses.
fn polygon_span(polygon: &[Point], y: f64) -> Option<(f64, f64)> {
    let mut low = f64::INFINITY;
    let mut high = f64::NEG_INFINITY;
    for i in 0..polygon.len() {
        let a = polygon[i];
        let b = polygon[(i + 1) % polygon.len()];
        if (a.y <= y && b.y > y) || (b.y <= y && a.y > y) {
            let t = (y - a.y) / (b.y - a.y);
            let x = a.x + t * (b.x - a.x);
            low = low.min(x);
            high = high.max(x);
        } else if a.y == y {
            low = low.min(a.x);
            high = high.max(a.x);
        }
    }
    (low <= high).then_some((low, high))
}

fn segment_distance(a: Point, b: Point, x: f64, y: f64) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared > 0.0 {
        (((x - a.x) * dx + (y - a.y) * dy) / length_squared).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let px = a.x + t * dx;
    let py = a.y + t * dy;
    ((x - px) * (x - px) + (y - py) * (y - py)).sqrt()
}

fn polygon_distance(polygon: &[Point], x: f64, y: f64) -> f64 {
    (0..polygon.len())
        .map(|i| segment_distance(polygon[i], polygon[(i + 1) % polygon.len()], x, y))
        .fold(f64::INFINITY, f64::min)
}

/// Half-width of the soft edge, in mask pixels; the edge itself sits half a pixel outside
/// the outermost mask pixel centres, where the bilinear zero crossing used to be.
const TRIM_EDGE_OFFSET: f64 = 0.5;
const TRIM_EDGE_RAMP: f64 = 0.35;

fn trim_mask_rgba(
    rgba: &mut [u8],
    width: usize,
    height: usize,
    mask: &[f32],
    size: usize,
    crop: [f64; 4],
    mask_box: [f64; 4],
) {
    assert_eq!(rgba.len(), width * height * 4);
    assert_eq!(mask.len(), size * size);
    let mut hull_x0 = size;
    let mut hull_y0 = size;
    let mut hull_x1 = None;
    let mut hull_y1 = None;
    let mut extremes = Vec::new();
    for y in 0..size {
        let mut first = None;
        let mut last = None;
        for x in 0..size {
            if mask[y * size + x] > 0.0 {
                hull_x0 = hull_x0.min(x);
                hull_y0 = hull_y0.min(y);
                hull_x1 = Some(hull_x1.map_or(x, |value: usize| value.max(x)));
                hull_y1 = Some(hull_y1.map_or(y, |value: usize| value.max(y)));
                first.get_or_insert(x);
                last = Some(x);
            }
        }
        if let (Some(first), Some(last)) = (first, last) {
            extremes.push(Point { x: first as f64, y: y as f64 });
            extremes.push(Point { x: last as f64, y: y as f64 });
        }
    }
    let (Some(hull_x1), Some(hull_y1)) = (hull_x1, hull_y1) else {
        return;
    };
    let span_x = hull_x1 - hull_x0 + 1;
    let span_y = hull_y1 - hull_y0 + 1;
    let automatic = crop
        .iter()
        .zip(mask_box)
        .all(|(a, b)| (*a - b).abs() < 1e-9);

    // The mask is a quarter the resolution of a scan or less, so its rows upsample to
    // stair steps eight or ten pixels tall. The outline is drawn as the convex polygon
    // through the mask's edge pixels instead, at full resolution with a soft edge. A
    // mask that is not one convex blob keeps the plain bilinear sampling.
    let polygon = convex_hull(extremes);
    let polygon = (polygon.len() >= 3).then_some(polygon);
    // Pixels whose 5 by 5 neighbourhood holds nothing are beyond the soft edge for sure.
    let mut near = vec![false; size * size];
    if polygon.is_some() {
        for y in 0..size {
            for x in 0..size {
                if mask[y * size + x] > 0.0 {
                    for ny in y.saturating_sub(2)..(y + 3).min(size) {
                        for nx in x.saturating_sub(2)..(x + 3).min(size) {
                            near[ny * size + nx] = true;
                        }
                    }
                }
            }
        }
    }

    let mut candidates = Vec::new();
    for y in 0..height {
        let normal_y = (y as f64 + 0.5) / height as f64;
        let mask_y = if automatic {
            hull_y0 as f64 + normal_y * span_y as f64 - 0.5
        } else {
            (crop[1] + normal_y * (crop[3] - crop[1])) * size as f64 - 0.5
        };
        let floor_y = mask_y.floor() as isize;
        let weight_y = mask_y - floor_y as f64;
        let span = polygon.as_deref().map(|p| polygon_span(p, mask_y));
        for x in 0..width {
            let normal_x = (x as f64 + 0.5) / width as f64;
            let mask_x = if automatic {
                hull_x0 as f64 + normal_x * span_x as f64 - 0.5
            } else {
                (crop[0] + normal_x * (crop[2] - crop[0])) * size as f64 - 0.5
            };
            let alpha = match (&polygon, span) {
                (Some(polygon), Some(span)) => {
                    if let Some((low, high)) = span {
                        if mask_x >= low && mask_x <= high {
                            continue;
                        }
                    }
                    let nx = (mask_x.round() as isize).clamp(0, size as isize - 1) as usize;
                    let ny = (mask_y.round() as isize).clamp(0, size as isize - 1) as usize;
                    if !near[ny * size + nx] {
                        0.0
                    } else {
                        let outside = polygon_distance(polygon, mask_x, mask_y);
                        ((TRIM_EDGE_OFFSET - outside) / TRIM_EDGE_RAMP + 0.5).clamp(0.0, 1.0)
                    }
                }
                _ => {
                    let floor_x = mask_x.floor() as isize;
                    let weight_x = mask_x - floor_x as f64;
                    let top = mask_value(mask, size, floor_x, floor_y) * (1.0 - weight_x)
                        + mask_value(mask, size, floor_x + 1, floor_y) * weight_x;
                    let bottom = mask_value(mask, size, floor_x, floor_y + 1) * (1.0 - weight_x)
                        + mask_value(mask, size, floor_x + 1, floor_y + 1) * weight_x;
                    let value = top * (1.0 - weight_y) + bottom * weight_y;
                    ((value + TRIM_EDGE_RAMP) / (2.0 * TRIM_EDGE_RAMP)).clamp(0.0, 1.0)
                }
            };
            if alpha < 1.0 {
                candidates.push((alpha, (y * width + x) * 4));
            }
        }
    }
    // A noisy or over-tight model mask must never erase a material part of the document.
    // On the detector's own crop, retain only the 0.9% most confidently outside pixels when
    // the raw mask would exceed the contract's strict under-one-percent ceiling.
    if automatic {
        let maximum = ((width * height) as f64 * 0.009).floor() as usize;
        if candidates.len() > maximum {
            candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
            candidates.truncate(maximum);
        }
    }
    for (alpha, offset) in candidates {
        if alpha <= 0.0 {
            rgba[offset..offset + 3].fill(255);
        } else {
            for channel in &mut rgba[offset..offset + 3] {
                *channel = (f64::from(*channel) * alpha + 255.0 * (1.0 - alpha)).round() as u8;
            }
        }
    }
}

#[wasm_bindgen]
pub fn minimum_area_rect(mask: &[f32], width: usize, height: usize) -> Vec<f64> {
    minimum_area_rect_scaled(mask, width, height, 1.0, 1.0)
}

#[wasm_bindgen]
pub fn minimum_area_rect_scaled(
    mask: &[f32],
    width: usize,
    height: usize,
    scale_x: f64,
    scale_y: f64,
) -> Vec<f64> {
    assert_eq!(mask.len(), width * height);
    let mut points = Vec::new();
    for y in 0..height {
        let mut first = None;
        let mut last = None;
        for x in 0..width {
            if mask[y * width + x] > 0.0 {
                first.get_or_insert(x);
                last = Some(x);
            }
        }
        if let (Some(first), Some(last)) = (first, last) {
            points.push(Point {
                x: first as f64 * scale_x,
                y: y as f64 * scale_y,
            });
            points.push(Point {
                x: last as f64 * scale_x,
                y: y as f64 * scale_y,
            });
        }
    }
    minimum_area_rect_points(points)
}

fn minimum_area_rect_points(points: Vec<Point>) -> Vec<f64> {
    let hull = convex_hull(points);
    if hull.len() < 3 {
        return Vec::new();
    }
    let mut best = (f64::INFINITY, 0.0, 0.0, 0.0, 0.0, 0.0);
    for i in 0..hull.len() {
        let a = hull[i];
        let b = hull[(i + 1) % hull.len()];
        let angle = (b.y - a.y).atan2(b.x - a.x);
        let (cos, sin) = (angle.cos(), angle.sin());
        let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
        for point in &hull {
            let x = point.x * cos + point.y * sin;
            let y = -point.x * sin + point.y * cos;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
        let rect_width = max_x - min_x;
        let rect_height = max_y - min_y;
        let area = rect_width * rect_height;
        if area < best.0 {
            let rotated_x = (min_x + max_x) / 2.0;
            let rotated_y = (min_y + max_y) / 2.0;
            let center_x = rotated_x * cos - rotated_y * sin;
            let center_y = rotated_x * sin + rotated_y * cos;
            best = (
                area,
                center_x,
                center_y,
                rect_width,
                rect_height,
                angle.to_degrees(),
            );
        }
    }
    let (_, center_x, center_y, mut rect_width, mut rect_height, mut angle) = best;
    while angle < -45.0 {
        angle += 90.0;
        std::mem::swap(&mut rect_width, &mut rect_height);
    }
    while angle > 45.0 {
        angle -= 90.0;
        std::mem::swap(&mut rect_width, &mut rect_height);
    }
    vec![center_x, center_y, rect_width, rect_height, angle]
}

#[wasm_bindgen]
pub fn merge_rotated_rectangles(rectangles: &[f64]) -> Vec<f64> {
    assert_eq!(rectangles.len() % 5, 0);
    let mut points = Vec::with_capacity(rectangles.len() / 5 * 4);
    for rect in rectangles.chunks_exact(5) {
        let [center_x, center_y, width, height, angle] =
            [rect[0], rect[1], rect[2], rect[3], rect[4]];
        let radians = angle.to_radians();
        let (cos, sin) = (radians.cos(), radians.sin());
        for (dx, dy) in [
            (-width / 2.0, -height / 2.0),
            (width / 2.0, -height / 2.0),
            (width / 2.0, height / 2.0),
            (-width / 2.0, height / 2.0),
        ] {
            points.push(Point {
                x: center_x + cos * dx - sin * dy,
                y: center_y + sin * dx + cos * dy,
            });
        }
    }
    minimum_area_rect_points(points)
}

fn extract_rotated_rgba(
    source: &[u8],
    source_width: usize,
    source_height: usize,
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    angle_degrees: f64,
) -> RgbaFrame {
    let width = width.round().max(1.0) as usize;
    let height = height.round().max(1.0) as usize;
    let mut pixels = vec![255_u8; width * height * 4];
    for alpha in pixels.iter_mut().skip(3).step_by(4) {
        *alpha = 255;
    }
    let radians = angle_degrees.to_radians();
    let (cos, sin) = (radians.cos(), radians.sin());
    for y in 0..height {
        for x in 0..width {
            let dx = x as f64 + 0.5 - width as f64 / 2.0;
            let dy = y as f64 + 0.5 - height as f64 / 2.0;
            let source_x = center_x + cos * dx - sin * dy - 0.5;
            let source_y = center_y + sin * dx + cos * dy - 0.5;
            if source_x < 0.0
                || source_y < 0.0
                || source_x > (source_width - 1) as f64
                || source_y > (source_height - 1) as f64
            {
                continue;
            }
            let x0 = source_x.floor() as usize;
            let y0 = source_y.floor() as usize;
            let x1 = (x0 + 1).min(source_width - 1);
            let y1 = (y0 + 1).min(source_height - 1);
            let wx = source_x - x0 as f64;
            let wy = source_y - y0 as f64;
            for channel in 0..4 {
                let top = f64::from(source[(y0 * source_width + x0) * 4 + channel]) * (1.0 - wx)
                    + f64::from(source[(y0 * source_width + x1) * 4 + channel]) * wx;
                let bottom = f64::from(source[(y1 * source_width + x0) * 4 + channel]) * (1.0 - wx)
                    + f64::from(source[(y1 * source_width + x1) * 4 + channel]) * wx;
                pixels[(y * width + x) * 4 + channel] =
                    (top * (1.0 - wy) + bottom * wy).round() as u8;
            }
        }
    }
    RgbaFrame {
        pixels,
        width,
        height,
    }
}

fn refine_rotated_rect_rgba(
    source: &[u8],
    source_width: usize,
    source_height: usize,
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    angle_degrees: f64,
) -> [f64; 5] {
    let original = [center_x, center_y, width, height, angle_degrees];
    if width < 20.0 || height < 20.0 {
        return original;
    }
    let pad = 8.0_f64.max(width.max(height) * 0.06);
    let crop = extract_rotated_rgba(
        source,
        source_width,
        source_height,
        center_x,
        center_y,
        width + 2.0 * pad,
        height + 2.0 * pad,
        angle_degrees,
    );
    let crop_width = crop.width as f64;
    let crop_height = crop.height as f64;
    // Start slightly inside SAM's low-resolution rectangle. The outward-biased search can
    // then reach the true boundary whether the 256px mask landed just inside or just outside
    // it, without giving interior print the same search budget as the document edge.
    let inset_x = width * 0.05;
    let inset_y = height * 0.05;
    let snapped = snap_edges_rgba(
        &crop.pixels,
        crop.width,
        crop.height,
        [
            (pad + inset_x) / crop_width,
            (pad + inset_y) / crop_height,
            (pad + width - inset_x) / crop_width,
            (pad + height - inset_y) / crop_height,
        ],
        0.08,
        5.0,
    );
    let x0 = snapped[0] * crop_width;
    let y0 = snapped[1] * crop_height;
    let x1 = snapped[2] * crop_width;
    let y1 = snapped[3] * crop_height;
    let new_width = x1 - x0;
    let new_height = y1 - y0;
    if new_width < width * 0.5 || new_height < height * 0.5 {
        return original;
    }

    let dx = (x0 + x1) / 2.0 - crop_width / 2.0;
    let dy = (y0 + y1) / 2.0 - crop_height / 2.0;
    let radians = angle_degrees.to_radians();
    let (cos, sin) = (radians.cos(), radians.sin());
    [
        center_x + cos * dx - sin * dy,
        center_y + sin * dx + cos * dy,
        new_width,
        new_height,
        angle_degrees,
    ]
}

#[wasm_bindgen]
pub fn measure_box(
    image_width: usize,
    image_height: usize,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    millimeters_per_pixel: f64,
) -> Vec<f64> {
    if !millimeters_per_pixel.is_finite() || millimeters_per_pixel <= 0.0 {
        return Vec::new();
    }
    vec![
        ((x1 - x0) * image_width as f64 * millimeters_per_pixel * 10.0).round() / 10.0,
        ((y1 - y0) * image_height as f64 * millimeters_per_pixel * 10.0).round() / 10.0,
    ]
}

/// Return sheet width/height, content width/height and a note code.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn plan_layout(
    image_width: usize,
    image_height: usize,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    millimeters_per_pixel: f64,
    sheet_width: f64,
    sheet_height: f64,
    fit: u8,
    preset_width: f64,
    preset_height: f64,
    margin: f64,
) -> Vec<f64> {
    let crop_width = (x1 - x0) * image_width as f64;
    let crop_height = (y1 - y0) * image_height as f64;
    let aspect = crop_height / crop_width;
    let has_sheet = sheet_width.is_finite() && sheet_height.is_finite();
    let measured = measure_box(
        image_width,
        image_height,
        x0,
        y0,
        x1,
        y1,
        millimeters_per_pixel,
    );
    let (mut content_width, mut content_height, note) = if fit == 0 && measured.len() == 2 {
        (measured[0], measured[1], 0.0)
    } else if fit == 1 {
        let mut width = preset_width;
        let mut height = preset_width * aspect;
        if height > preset_height {
            height = preset_height;
            width = preset_height / aspect;
        }
        (
            (width * 10.0).round() / 10.0,
            (height * 10.0).round() / 10.0,
            1.0,
        )
    } else if has_sheet {
        let available_width = sheet_width - 2.0 * margin;
        let available_height = sheet_height - 2.0 * margin;
        let scale = (available_width / crop_width).min(available_height / crop_height);
        (
            (crop_width * scale * 10.0).round() / 10.0,
            (crop_height * scale * 10.0).round() / 10.0,
            2.0,
        )
    } else if measured.len() == 2 {
        (measured[0], measured[1], 0.0)
    } else {
        (crop_width, crop_height, 3.0)
    };
    if has_sheet {
        let scale = (sheet_width / content_width)
            .min(sheet_height / content_height)
            .min(1.0);
        if scale < 1.0 {
            content_width = (content_width * scale * 10.0).round() / 10.0;
            content_height = (content_height * scale * 10.0).round() / 10.0;
        }
    }
    vec![
        sheet_width,
        sheet_height,
        content_width,
        content_height,
        note,
    ]
}

fn apply_tone_rgba(rgba: &mut [u8], width: usize, height: usize, clip_limit: f64, stretch: bool) {
    if clip_limit > 0.0 {
        const TILES: usize = 8;
        let tile_width = width.div_ceil(TILES);
        let tile_height = height.div_ceil(TILES);
        let luminance: Vec<f64> = (0..width * height)
            .map(|index| grey_at(rgba, width, index % width, index / width))
            .collect();
        let mut lookups = vec![[0_u8; 256]; TILES * TILES];
        for tile_y in 0..TILES {
            for tile_x in 0..TILES {
                let x0 = tile_x * tile_width;
                let y0 = tile_y * tile_height;
                let x1 = width.min(x0 + tile_width);
                let y1 = height.min(y0 + tile_height);
                let mut histogram = [0.0_f64; 256];
                let mut count = 0;
                for y in y0..y1 {
                    for x in x0..x1 {
                        histogram[luminance[y * width + x].round().clamp(0.0, 255.0) as usize] +=
                            1.0;
                        count += 1;
                    }
                }
                let limit = (clip_limit * count as f64 / 256.0).max(1.0);
                let mut excess = 0.0;
                for bin in &mut histogram {
                    if *bin > limit {
                        excess += *bin - limit;
                        *bin = limit;
                    }
                }
                let share = excess / 256.0;
                let scale = if count > 0 { 255.0 / count as f64 } else { 0.0 };
                let mut cumulative = 0.0;
                for (value, bin) in histogram.iter().enumerate() {
                    cumulative += bin + share;
                    lookups[tile_y * TILES + tile_x][value] =
                        (cumulative * scale).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        for y in 0..height {
            let fy = (y as f64 / tile_height as f64 - 0.5).clamp(0.0, (TILES - 1) as f64);
            let tile_y0 = fy.floor() as usize;
            let tile_y1 = (tile_y0 + 1).min(TILES - 1);
            let weight_y = fy - tile_y0 as f64;
            for x in 0..width {
                let fx = (x as f64 / tile_width as f64 - 0.5).clamp(0.0, (TILES - 1) as f64);
                let tile_x0 = fx.floor() as usize;
                let tile_x1 = (tile_x0 + 1).min(TILES - 1);
                let weight_x = fx - tile_x0 as f64;
                let value = luminance[y * width + x].round().clamp(0.0, 255.0) as usize;
                let a = f64::from(lookups[tile_y0 * TILES + tile_x0][value]);
                let b = f64::from(lookups[tile_y0 * TILES + tile_x1][value]);
                let c = f64::from(lookups[tile_y1 * TILES + tile_x0][value]);
                let d = f64::from(lookups[tile_y1 * TILES + tile_x1][value]);
                let equalized = (a * (1.0 - weight_x) + b * weight_x) * (1.0 - weight_y)
                    + (c * (1.0 - weight_x) + d * weight_x) * weight_y;
                let before = luminance[y * width + x];
                if before < 1.0 {
                    continue;
                }
                let ratio = equalized / before;
                let offset = (y * width + x) * 4;
                for channel in &mut rgba[offset..offset + 3] {
                    *channel = (f64::from(*channel) * ratio).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
    if stretch {
        let mut histogram = [0_usize; 256];
        for pixel in rgba.chunks_exact(4) {
            histogram[pixel[0] as usize] += 1;
            histogram[pixel[1] as usize] += 1;
            histogram[pixel[2] as usize] += 1;
        }
        let count = width * height * 3;
        let mut cumulative = 0;
        let mut low = 0;
        for (value, &frequency) in histogram.iter().enumerate() {
            cumulative += frequency;
            if cumulative as f64 >= count as f64 * 0.01 {
                low = value;
                break;
            }
        }
        cumulative = 0;
        let mut high = 255;
        for (value, &frequency) in histogram.iter().enumerate().rev() {
            cumulative += frequency;
            if cumulative as f64 >= count as f64 * 0.005 {
                high = value.max(low + 1);
                break;
            }
        }
        let scale = 255.0 / (high - low) as f64;
        for pixel in rgba.chunks_exact_mut(4) {
            for channel in &mut pixel[..3] {
                *channel = ((f64::from(*channel) - low as f64) * scale)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Estimate the corrective clockwise angle for an RGBA frame.
pub fn estimate_skew_rgba(rgba: &[u8], width: usize, height: usize) -> f64 {
    assert_eq!(rgba.len(), width * height * 4);
    let (grey, width, height) = rgba_to_work(rgba, width, height);
    estimate_skew_work(&grey, width, height)
}

/// Estimate skew from a grayscale frame. This is also the native test entry point.
pub fn estimate_skew_gray(grey: &[f64], width: usize, height: usize) -> f64 {
    assert_eq!(grey.len(), width * height);
    if width == 0 || height == 0 {
        return 0.0;
    }
    let (small, width, height) = resize_for_work(grey, width, height);
    estimate_skew_work(&small, width, height)
}

fn estimate_skew_work(grey: &[f64], width: usize, height: usize) -> f64 {
    let (xs, ys) = ink_pixels(grey, width, height);
    if xs.len() < 200 {
        return 0.0;
    }

    let diagonal = (f64::hypot(width as f64, height as f64).ceil() as usize) + 2;
    let mut histogram = vec![0.0_f64; diagonal];
    let mut best_tenth = 0;
    let mut best_score = -1.0_f64;

    for tenth in -LIMIT_TENTHS..=LIMIT_TENTHS {
        let angle = f64::from(tenth) / 10.0;
        let radians = angle.to_radians();
        let cos = radians.cos();
        let sin = radians.sin();
        histogram.fill(0.0);
        let offset = diagonal as f64 / 2.0 - (width as f64 * sin.abs() + height as f64 * cos) / 2.0;

        for (&x, &y) in xs.iter().zip(&ys) {
            let row = -f64::from(x) * sin + f64::from(y) * cos + offset;
            let lower = row.floor() as isize;
            let fraction = row - lower as f64;
            if lower >= 0 && (lower as usize) < diagonal {
                histogram[lower as usize] += 1.0 - fraction;
            }
            let upper = lower + 1;
            if upper >= 0 && (upper as usize) < diagonal {
                histogram[upper as usize] += fraction;
            }
        }

        let mut score = 0.0;
        let mut previous = 0.0;
        for i in 1..diagonal - 1 {
            let current = 0.25 * histogram[i - 1] + 0.5 * histogram[i] + 0.25 * histogram[i + 1];
            if i > 1 {
                let delta = current - previous;
                score += delta * delta;
            }
            previous = current;
        }
        if score > best_score {
            best_score = score;
            best_tenth = tenth;
        }
    }
    f64::from(best_tenth) / 10.0
}

fn rgba_to_work(rgba: &[u8], width: usize, height: usize) -> (Vec<f64>, usize, usize) {
    if width <= WORK_WIDTH {
        let grey = rgba
            .chunks_exact(4)
            .map(|pixel| {
                0.299 * f64::from(pixel[0])
                    + 0.587 * f64::from(pixel[1])
                    + 0.114 * f64::from(pixel[2])
            })
            .collect();
        return (grey, width, height);
    }

    let scale = WORK_WIDTH as f64 / width as f64;
    let work_height = (height as f64 * scale).round().max(1.0) as usize;
    let mut output = vec![0.0; WORK_WIDTH * work_height];
    let grey_at = |x: usize, y: usize| {
        let offset = (y * width + x) * 4;
        0.299 * f64::from(rgba[offset])
            + 0.587 * f64::from(rgba[offset + 1])
            + 0.114 * f64::from(rgba[offset + 2])
    };
    for y in 0..work_height {
        let sy = ((y as f64 + 0.5) / scale - 0.5).clamp(0.0, (height - 1) as f64);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(height - 1);
        let wy = sy - y0 as f64;
        for x in 0..WORK_WIDTH {
            let sx = ((x as f64 + 0.5) / scale - 0.5).clamp(0.0, (width - 1) as f64);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(width - 1);
            let wx = sx - x0 as f64;
            let top = grey_at(x0, y0) * (1.0 - wx) + grey_at(x1, y0) * wx;
            let bottom = grey_at(x0, y1) * (1.0 - wx) + grey_at(x1, y1) * wx;
            output[y * WORK_WIDTH + x] = top * (1.0 - wy) + bottom * wy;
        }
    }
    (output, WORK_WIDTH, work_height)
}

fn resize_for_work(
    source: &[f64],
    source_width: usize,
    source_height: usize,
) -> (Vec<f64>, usize, usize) {
    if source_width <= WORK_WIDTH {
        return (source.to_vec(), source_width, source_height);
    }
    let scale = WORK_WIDTH as f64 / source_width as f64;
    let height = (source_height as f64 * scale).round().max(1.0) as usize;
    let mut output = vec![0.0; WORK_WIDTH * height];

    // Bilinear sampling at pixel centres matches the browser canvas closely enough that
    // the winning tenth of a degree is stable across native and WebAssembly builds.
    for y in 0..height {
        let sy = ((y as f64 + 0.5) / scale - 0.5).clamp(0.0, (source_height - 1) as f64);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(source_height - 1);
        let wy = sy - y0 as f64;
        for x in 0..WORK_WIDTH {
            let sx = ((x as f64 + 0.5) / scale - 0.5).clamp(0.0, (source_width - 1) as f64);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(source_width - 1);
            let wx = sx - x0 as f64;
            let top =
                source[y0 * source_width + x0] * (1.0 - wx) + source[y0 * source_width + x1] * wx;
            let bottom =
                source[y1 * source_width + x0] * (1.0 - wx) + source[y1 * source_width + x1] * wx;
            output[y * WORK_WIDTH + x] = top * (1.0 - wy) + bottom * wy;
        }
    }
    (output, WORK_WIDTH, height)
}

fn ink_pixels(grey: &[f64], width: usize, height: usize) -> (Vec<i16>, Vec<i16>) {
    let stride = width + 1;
    let mut integral = vec![0.0_f64; stride * (height + 1)];
    for y in 0..height {
        let mut run = 0.0;
        for x in 0..width {
            run += grey[y * width + x];
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + run;
        }
    }

    let inset_x = (width as f64 * INSET).round() as usize;
    let inset_y = (height as f64 * INSET).round() as usize;
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for y in inset_y..height.saturating_sub(inset_y) {
        for x in inset_x..width.saturating_sub(inset_x) {
            let x0 = x.saturating_sub(THRESHOLD_RADIUS);
            let y0 = y.saturating_sub(THRESHOLD_RADIUS);
            let x1 = (x + THRESHOLD_RADIUS + 1).min(width);
            let y1 = (y + THRESHOLD_RADIUS + 1).min(height);
            let total = integral[y1 * stride + x1]
                - integral[y0 * stride + x1]
                - integral[y1 * stride + x0]
                + integral[y0 * stride + x0];
            let mean = total / ((x1 - x0) * (y1 - y0)) as f64;
            if grey[y * width + x] < mean - THRESHOLD_OFFSET {
                xs.push(x as i16);
                ys.push(y as i16);
            }
        }
    }
    (xs, ys)
}

/// Trace foreground pixel boundaries as closed edge loops. Each loop is encoded as its
/// point count followed by x/y pairs, so several contours fit in one flat WASM array.
#[wasm_bindgen]
pub fn trace_contours(mask: &[u8], width: usize, height: usize) -> Vec<f64> {
    use std::collections::HashMap;
    assert_eq!(mask.len(), width * height);
    type Vertex = (i32, i32);
    let mut edges: HashMap<Vertex, Vec<Vertex>> = HashMap::new();
    let on = |x: isize, y: isize| {
        x >= 0
            && y >= 0
            && (x as usize) < width
            && (y as usize) < height
            && mask[y as usize * width + x as usize] != 0
    };
    let mut add = |start: Vertex, end: Vertex| edges.entry(start).or_default().push(end);
    for y in 0..height as isize {
        for x in 0..width as isize {
            if !on(x, y) {
                continue;
            }
            let (x, y) = (x as i32, y as i32);
            if !on(x as isize, y as isize - 1) {
                add((x, y), (x + 1, y));
            }
            if !on(x as isize + 1, y as isize) {
                add((x + 1, y), (x + 1, y + 1));
            }
            if !on(x as isize, y as isize + 1) {
                add((x + 1, y + 1), (x, y + 1));
            }
            if !on(x as isize - 1, y as isize) {
                add((x, y + 1), (x, y));
            }
        }
    }

    let mut contours = Vec::new();
    while let Some((&start, _)) = edges.iter().find(|(_, next)| !next.is_empty()) {
        let mut contour = vec![start];
        let mut current = start;
        let maximum = edges.values().map(Vec::len).sum::<usize>() + 1;
        for _ in 0..maximum {
            let Some(next) = edges.get_mut(&current).and_then(Vec::pop) else {
                break;
            };
            contour.push(next);
            current = next;
            if current == start {
                break;
            }
        }
        if contour.len() >= 4 && contour.last() == Some(&start) {
            contours.push(contour);
        }
    }
    let mut flat = Vec::new();
    for contour in contours {
        flat.push(contour.len() as f64);
        for (x, y) in contour {
            flat.extend([f64::from(x), f64::from(y)]);
        }
    }
    flat
}

fn point_segment_distance(point: Point, start: Point, end: Point) -> f64 {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if dx == 0.0 && dy == 0.0 {
        return f64::hypot(point.x - start.x, point.y - start.y);
    }
    let t = (((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy))
        .clamp(0.0, 1.0);
    f64::hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

fn simplify_rdp(points: &[Point], epsilon: f64, output: &mut Vec<Point>) {
    if points.len() <= 2 {
        output.push(points[0]);
        return;
    }
    let mut furthest = (0.0, 0);
    for (index, &point) in points.iter().enumerate().take(points.len() - 1).skip(1) {
        let distance = point_segment_distance(point, points[0], points[points.len() - 1]);
        if distance > furthest.0 {
            furthest = (distance, index);
        }
    }
    if furthest.0 > epsilon {
        simplify_rdp(&points[..=furthest.1], epsilon, output);
        simplify_rdp(&points[furthest.1..], epsilon, output);
    } else {
        output.push(points[0]);
    }
}

#[wasm_bindgen]
pub fn simplify_polygon(points: &[f64], epsilon: f64) -> Vec<f64> {
    assert_eq!(points.len() % 2, 0);
    let input: Vec<Point> = points
        .chunks_exact(2)
        .map(|pair| Point {
            x: pair[0],
            y: pair[1],
        })
        .collect();
    if input.len() < 3 {
        return points.to_vec();
    }
    let mut simplified = Vec::new();
    simplify_rdp(&input, epsilon, &mut simplified);
    simplified.push(*input.last().unwrap());
    simplified
        .into_iter()
        .flat_map(|point| [point.x, point.y])
        .collect()
}

/// Connected-component statistics encoded as label, x, y, width, height, area, cx, cy.
#[wasm_bindgen]
pub fn connected_components(mask: &[u8], width: usize, height: usize) -> Vec<f64> {
    use std::collections::VecDeque;
    assert_eq!(mask.len(), width * height);
    let mut labels = vec![0_u32; width * height];
    let mut output = Vec::new();
    let mut label = 0_u32;
    for start in 0..mask.len() {
        if mask[start] == 0 || labels[start] != 0 {
            continue;
        }
        label += 1;
        labels[start] = label;
        let mut queue = VecDeque::from([start]);
        let (mut x0, mut y0, mut x1, mut y1) = (width, height, 0, 0);
        let (mut area, mut sum_x, mut sum_y) = (0_usize, 0_usize, 0_usize);
        while let Some(index) = queue.pop_front() {
            let x = index % width;
            let y = index / width;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            area += 1;
            sum_x += x;
            sum_y += y;
            for dy in -1_isize..=1 {
                for dx in -1_isize..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = x as isize + dx;
                    let ny = y as isize + dy;
                    if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                        continue;
                    }
                    let next = ny as usize * width + nx as usize;
                    if mask[next] != 0 && labels[next] == 0 {
                        labels[next] = label;
                        queue.push_back(next);
                    }
                }
            }
        }
        output.extend([
            f64::from(label),
            x0 as f64,
            y0 as f64,
            (x1 - x0 + 1) as f64,
            (y1 - y0 + 1) as f64,
            area as f64,
            sum_x as f64 / area as f64,
            sum_y as f64 / area as f64,
        ]);
    }
    output
}

/// Rectangular morphology: operation 0 dilate, 1 erode, 2 close and 3 open.
#[wasm_bindgen]
pub fn morphology(
    mask: &[u8],
    width: usize,
    height: usize,
    radius: usize,
    operation: u8,
) -> Vec<u8> {
    assert_eq!(mask.len(), width * height);
    let pass = |input: &[u8], dilate: bool| {
        let mut output = vec![0_u8; input.len()];
        for y in 0..height {
            for x in 0..width {
                let mut value = if dilate { 0 } else { 255 };
                for ny in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
                    for nx in x.saturating_sub(radius)..=(x + radius).min(width - 1) {
                        if dilate {
                            value = value.max(input[ny * width + nx]);
                        } else {
                            value = value.min(input[ny * width + nx]);
                        }
                    }
                }
                output[y * width + x] = value;
            }
        }
        output
    };
    match operation {
        0 => pass(mask, true),
        1 => pass(mask, false),
        2 => pass(&pass(mask, true), false),
        3 => pass(&pass(mask, false), true),
        _ => mask.to_vec(),
    }
}

#[wasm_bindgen]
pub fn sobel_magnitude(grey: &[f32], width: usize, height: usize) -> Vec<f32> {
    assert_eq!(grey.len(), width * height);
    let mut output = vec![0.0_f32; grey.len()];
    if width < 3 || height < 3 {
        return output;
    }
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let at = |dx: isize, dy: isize| {
                grey[(y as isize + dy) as usize * width + (x as isize + dx) as usize]
            };
            let gx =
                -at(-1, -1) + at(1, -1) - 2.0 * at(-1, 0) + 2.0 * at(1, 0) - at(-1, 1) + at(1, 1);
            let gy =
                -at(-1, -1) - 2.0 * at(0, -1) - at(1, -1) + at(-1, 1) + 2.0 * at(0, 1) + at(1, 1);
            output[y * width + x] = f32::hypot(gx, gy);
        }
    }
    output
}

#[wasm_bindgen]
pub fn gaussian_blur(
    grey: &[f32],
    width: usize,
    height: usize,
    sigma: f64,
    radius: usize,
) -> Vec<f32> {
    assert_eq!(grey.len(), width * height);
    if radius == 0 || sigma <= 0.0 {
        return grey.to_vec();
    }
    let mut kernel: Vec<f64> = (0..=radius * 2)
        .map(|index| {
            let x = index as f64 - radius as f64;
            (-x * x / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let total: f64 = kernel.iter().sum();
    for value in &mut kernel {
        *value /= total;
    }
    let mut temporary = vec![0.0_f32; grey.len()];
    let mut output = vec![0.0_f32; grey.len()];
    for y in 0..height {
        for x in 0..width {
            temporary[y * width + x] = kernel
                .iter()
                .enumerate()
                .map(|(index, weight)| {
                    let nx = (x as isize + index as isize - radius as isize)
                        .clamp(0, width as isize - 1) as usize;
                    grey[y * width + nx] * *weight as f32
                })
                .sum();
        }
    }
    for y in 0..height {
        for x in 0..width {
            output[y * width + x] = kernel
                .iter()
                .enumerate()
                .map(|(index, weight)| {
                    let ny = (y as isize + index as isize - radius as isize)
                        .clamp(0, height as isize - 1) as usize;
                    temporary[ny * width + x] * *weight as f32
                })
                .sum();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::{fs, path::PathBuf};

    fn repository_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    #[test]
    fn fixture_angles_match_the_contract() {
        let root = repository_root();
        let manifest: Value =
            serde_json::from_slice(&fs::read(root.join("fixtures/corpus.json")).unwrap()).unwrap();
        let mut checked = 0;
        for row in manifest["fixtures"].as_array().unwrap() {
            let path = root
                .join("fixtures")
                .join(row["raster_file"].as_str().unwrap());
            if !path.exists() {
                assert_eq!(row["visibility"], "private", "public raster is required");
                continue;
            }
            let image = image::open(path).unwrap().to_luma8();
            let grey: Vec<f64> = image.as_raw().iter().map(|&v| f64::from(v)).collect();
            let actual = estimate_skew_gray(&grey, image.width() as usize, image.height() as usize);
            let expected = row["expected"]["skew_degrees"].as_f64().unwrap();
            let tolerance = row["tolerance"]["skew_degrees"].as_f64().unwrap();
            assert!(
                (actual - expected).abs() <= tolerance,
                "{}: got {actual}, expected {expected} +/- {tolerance}",
                row["id"].as_str().unwrap(),
            );
            checked += 1;
        }
        assert!(checked >= 1);
    }

    #[test]
    fn blank_frame_has_no_skew() {
        assert_eq!(estimate_skew_gray(&vec![255.0; 320 * 200], 320, 200), 0.0);
    }

    #[test]
    fn edge_snap_searches_outward_before_interior_print() {
        let (width, height) = (200, 160);
        let mut pixels = vec![255_u8; width * height * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        for y in 32..128 {
            for x in 40..160 {
                let offset = (y * width + x) * 4;
                pixels[offset..offset + 3].fill(180);
            }
        }
        // A stronger printed rule sits further inward than the deliberately tight inward
        // window and must not steal the document boundary.
        for y in 32..128 {
            pixels[(y * width + 55) * 4..(y * width + 55) * 4 + 3].fill(0);
        }
        let snapped = snap_edges_rgba(&pixels, width, height, [0.22, 0.22, 0.78, 0.78], 0.08, 0.5);
        assert!((snapped[0] - 0.2).abs() <= 0.01, "{snapped:?}");
        assert!((snapped[2] - 0.8).abs() <= 0.01, "{snapped:?}");
    }

    #[test]
    fn convex_mask_keeps_and_bridges_every_component() {
        let size = 16;
        let mut mask = vec![-1.0_f32; size * size];
        for y in 3..13 {
            for x in 2..6 {
                mask[y * size + x] = 1.0;
            }
            for x in 10..14 {
                mask[y * size + x] = 1.0;
            }
        }
        let cleaned = clean_mask(&mask, size);
        assert!(cleaned[8 * size + 3] > 0.0);
        assert!(cleaned[8 * size + 12] > 0.0);
        assert!(cleaned[8 * size + 8] > 0.0, "the gutter must be bridged");
    }

    #[test]
    fn trim_draws_the_outline_as_a_smooth_polygon_rather_than_mask_rows() {
        // A diamond in a 16 by 16 mask, upsampled 25 times: the old row-by-row sampling
        // produced 25 pixel stair steps along its slanted sides.
        let size = 16;
        let mut mask = vec![-1.0_f32; size * size];
        for y in 0..size {
            for x in 0..size {
                if (x as i32 - 8).abs() + (y as i32 - 8).abs() <= 5 {
                    mask[y * size + x] = 1.0;
                }
            }
        }
        let (width, height) = (400, 400);
        let mut rgba = vec![0_u8; width * height * 4];
        for alpha in rgba.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        trim_mask_rgba(
            &mut rgba,
            width,
            height,
            &mask,
            size,
            [0.0, 0.0, 1.0, 1.0],
            [0.5, 0.5, 0.5, 0.5],
        );
        // Along the upper-left side, the first surviving (dark) pixel of each row should
        // move by a steady one pixel per row, never by a whole mask cell at once.
        let first_dark = |y: usize| (0..width).find(|&x| rgba[(y * width + x) * 4] < 128);
        let mut previous = first_dark(120).unwrap();
        for y in 121..190 {
            let current = first_dark(y).unwrap();
            assert!(
                previous >= current && previous - current <= 2,
                "row {y}: edge jumped from {previous} to {current}"
            );
            previous = current;
        }
        // and the edge is soft: some pixels are neither kept nor cleared
        assert!(rgba.iter().step_by(4).any(|&value| value > 20 && value < 235));
    }

    #[test]
    fn trim_uses_a_hand_adjusted_crop_in_full_frame_coordinates() {
        let size = 10;
        let mut mask = vec![-1.0_f32; size * size];
        for y in 1..9 {
            for x in 1..9 {
                let dx = x as f64 - 4.5;
                let dy = y as f64 - 4.5;
                if dx * dx + dy * dy <= 13.0 {
                    mask[y * size + x] = 1.0;
                }
            }
        }
        let mut automatic = vec![120_u8; 40 * 40 * 4];
        for alpha in automatic.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        let mut hand_adjusted = automatic.clone();
        trim_mask_rgba(
            &mut automatic,
            40,
            40,
            &mask,
            size,
            [0.1, 0.1, 0.9, 0.9],
            [0.1, 0.1, 0.9, 0.9],
        );
        trim_mask_rgba(
            &mut hand_adjusted,
            40,
            40,
            &mask,
            size,
            [0.4, 0.4, 0.6, 0.6],
            [0.1, 0.1, 0.9, 0.9],
        );
        assert!(automatic.iter().step_by(4).any(|&value| value == 255));
        assert!(
            hand_adjusted
                .chunks_exact(4)
                .all(|pixel| pixel[..3] == [120; 3])
        );
    }

    #[test]
    fn minimum_rectangle_and_extraction_preserve_geometry() {
        let (width, height) = (50, 60);
        let mut mask = vec![-1.0_f32; width * height];
        for y in 20..40 {
            for x in 10..30 {
                mask[y * width + x] = 1.0;
            }
        }
        let rect = minimum_area_rect(&mask, width, height);
        assert_eq!(rect.len(), 5);
        assert!((rect[0] - 19.5).abs() <= 0.5, "{rect:?}");
        assert!((rect[1] - 29.5).abs() <= 0.5, "{rect:?}");
        assert!((rect[2] * rect[3] - 19.0 * 19.0).abs() <= 1.0, "{rect:?}");

        let mut pixels = vec![255_u8; width * height * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        let extracted = extract_rotated_rgba(&pixels, width, height, 20.0, 30.0, 20.0, 10.0, 0.0);
        assert_eq!((extracted.width, extracted.height), (20, 10));
    }

    #[test]
    fn merging_rectangles_keeps_both_parts_in_one_fitted_shape() {
        let merged =
            merge_rotated_rectangles(&[30.0, 50.0, 40.0, 60.0, 0.0, 70.0, 50.0, 40.0, 60.0, 0.0]);
        assert_eq!(merged.len(), 5);
        assert!((merged[0] - 50.0).abs() <= 0.1, "{merged:?}");
        assert!((merged[2] - 80.0).abs() <= 0.1, "{merged:?}");
        assert!((merged[3] - 60.0).abs() <= 0.1, "{merged:?}");
    }

    #[test]
    fn rotated_rectangle_refinement_uses_the_real_edge() {
        let (width, height) = (200, 160);
        let mut pixels = vec![0_u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let value = 225 + ((x + y) % 5) as u8;
                let offset = (y * width + x) * 4;
                pixels[offset..offset + 3].fill(value);
                pixels[offset + 3] = 255;
            }
        }
        for y in 32..128 {
            for x in 40..160 {
                let offset = (y * width + x) * 4;
                pixels[offset..offset + 3].fill(120);
            }
        }
        let refined =
            refine_rotated_rect_rgba(&pixels, width, height, 100.0, 80.0, 128.0, 104.0, 0.0);
        assert!((refined[2] - 120.0).abs() <= 2.0, "{refined:?}");
        assert!((refined[3] - 96.0).abs() <= 2.0, "{refined:?}");
    }

    #[test]
    fn known_size_fits_inside_both_preset_dimensions() {
        let plan = plan_layout(
            100,
            200,
            0.0,
            0.0,
            1.0,
            1.0,
            f64::NAN,
            210.0,
            297.0,
            1,
            125.0,
            88.0,
            8.0,
        );
        assert_eq!(&plan[2..4], &[44.0, 88.0]);
    }

    #[test]
    fn white_point_stretch_is_shared_across_rgb_channels() {
        let mut pixels = Vec::new();
        for value in 10_u8..=210 {
            pixels.extend_from_slice(&[
                value,
                value.saturating_add(10),
                value.saturating_add(20),
                255,
            ]);
        }
        apply_tone_rgba(&mut pixels, 201, 1, 0.0, true);
        assert_eq!(pixels[3], 255);
        for pixel in pixels.chunks_exact(4) {
            assert!(pixel[0] <= pixel[1] && pixel[1] <= pixel[2]);
            assert_eq!(pixel[3], 255);
        }
    }

    #[test]
    fn contours_and_polygon_simplification_preserve_the_outer_shape() {
        let (width, height) = (10, 10);
        let mut mask = vec![0_u8; width * height];
        for y in 3..8 {
            for x in 2..7 {
                mask[y * width + x] = 255;
            }
        }
        let contours = trace_contours(&mask, width, height);
        assert!(!contours.is_empty());
        let count = contours[0] as usize;
        assert!(count >= 5);
        assert_eq!(contours[1], contours[1 + (count - 1) * 2]);
        assert_eq!(contours[2], contours[2 + (count - 1) * 2]);

        let simplified = simplify_polygon(&[0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 2.0, 2.0], 0.1);
        assert_eq!(simplified, vec![0.0, 0.0, 2.0, 0.0, 2.0, 2.0]);
    }

    #[test]
    fn connected_components_report_bounds_area_and_centroid() {
        let (width, height) = (12, 8);
        let mut mask = vec![0_u8; width * height];
        for y in 1..3 {
            for x in 1..4 {
                mask[y * width + x] = 1;
            }
        }
        for y in 4..7 {
            for x in 8..10 {
                mask[y * width + x] = 1;
            }
        }
        let stats = connected_components(&mask, width, height);
        assert_eq!(stats.len(), 16);
        assert_eq!(stats[5], 6.0);
        assert_eq!(stats[13], 6.0);
        assert_eq!(&stats[1..5], &[1.0, 1.0, 3.0, 2.0]);
    }

    #[test]
    fn morphology_sobel_and_gaussian_cover_the_filter_primitives() {
        let mut mask = vec![0_u8; 7 * 7];
        mask[3 * 7 + 3] = 255;
        let dilated = morphology(&mask, 7, 7, 1, 0);
        assert_eq!(dilated.iter().filter(|&&value| value > 0).count(), 9);
        let opened = morphology(&dilated, 7, 7, 1, 3);
        assert_eq!(opened.iter().filter(|&&value| value > 0).count(), 9);

        let mut step = vec![0.0_f32; 7 * 7];
        for y in 0..7 {
            for x in 4..7 {
                step[y * 7 + x] = 1.0;
            }
        }
        let sobel = sobel_magnitude(&step, 7, 7);
        assert!(sobel[3 * 7 + 3] > 0.0);
        let blurred = gaussian_blur(&step, 7, 7, 1.0, 2);
        assert!(blurred[3 * 7 + 3] > 0.0 && blurred[3 * 7 + 3] < 1.0);
    }
}
