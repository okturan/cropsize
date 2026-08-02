//! Browser imaging primitives shared through WebAssembly.

use wasm_bindgen::prelude::*;

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
}
