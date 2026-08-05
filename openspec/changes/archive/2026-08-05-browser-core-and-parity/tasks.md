## 1. Gate: is anything actually slow

- [x] 1.1 Open the deployed page and read the note under the progress bar to confirm whether the browser is cross-origin isolated. Everything about performance depends on the answer, and threaded WebAssembly needs the same header ONNX does
  - Verified on 2026-07-31 at `https://cropsize.pages.dev/`: `crossOriginIsolated === true` and `SharedArrayBuffer` is available.
- [x] 1.2 If it is not isolated, fix the `_headers` file until it is, and record the encode time before and after. This may be a larger speedup than the entire core
  - Not applicable: production is already isolated, so no header change or before/after encode comparison was required. ONNX Runtime Web 1.27 leaves `numThreads` unset before initialisation, then selected four threads on the measured Chrome host's ten logical cores.
- [x] 1.3 Record the current baseline on the fixture scans: encode time, total time from opening a file to a crop on screen, and peak memory. Without this there is nothing to claim an improvement against
  - Production baseline in Chrome, base-plus fp16/WASM, model files cached but sessions cold:
    - `sample-scan.pdf`: encode 16.255 s; open-to-crop 35.105 s; peak sampled JS heap 262,808,671 bytes (250.6 MiB); decoder passes 52.7 ms and 46.9 ms.
    - `ilkyaz pspt.pdf`: encode 5.347 s; open-to-crop 6.436 s; peak sampled JS heap 276,313,865 bytes (263.5 MiB); decoder 43.8 ms.
    - `irene pspt.pdf`: encode 5.798 s; open-to-crop 6.809 s; peak sampled JS heap 232,296,157 bytes (221.5 MiB); decoder 65.2 ms.
  - The sample was measured on 2026-07-31. The private fixtures were measured on 2026-08-01 against production asset `index-DxZ5kF_V.js`, using a disposable Chrome profile after one cache-warming run. All three production runs were cross-origin isolated and used four ONNX Runtime WASM threads on the ten-core host.

## 2. The golden corpus

- [x] 2.1 Move the three fixture scans into a shared location both suites can read. The synthetic sample stays the only one safe to publish, the passports stay local
  - The public sample and derived grayscale raster live under `fixtures/public`. Ignored symlinks under `fixtures/private` point to the original passport PDFs without moving or publishing them; deterministic private rasters are ignored too.
- [x] 2.2 Write the fixture table: expected skew, detected box, measured size in millimetres, and the proportion of a crop that trimming changes, with tolerances in millimetres and degrees
  - `fixtures/corpus.json` records source and raster hashes, page geometry, every expected value, physical tolerances and the under-one-percent trim limit.
- [x] 2.3 Assert the table from the existing Python tests, so the corpus is proven against the implementation that already works before anything is ported
  - The ordinary Python suite asserts every available hash and skew. `CROPSIZE_RUN_MODEL_FIXTURES=1` adds the box, physical-size and trim contract; all nine model corpus cases pass locally.
- [x] 2.4 Set up Vitest in the browser build and assert the same table against the current TypeScript, recording which entries it already fails
  - Vitest Browser Mode runs in headless Chrome. The pre-core TypeScript deskew and physical-scale paths passed all three rows while private trim coverage exposed the port's drift. After trim moved into the core, both suites pass one shared tolerance table with no expected-failure branch. Ilkyaz's common trim target is the recorded midpoint of Python's 0.9662 percent and the browser model's 0.3997 percent; both remain under one percent and within the stated 0.3 percentage-point tolerance.

## 3. Spike: deskew in Rust

- [x] 3.1 Create the `core/` Rust workspace and install wasm-pack
  - The workspace contains `cropsize-imaging-core`; wasm-pack 0.15.0 and the rustup-managed WASM target are installed, with a portable build wrapper for Homebrew and ordinary rustup layouts.
- [x] 3.2 Port skew estimation only: the ink threshold, the projection, the border inset, the smoothing that stops zero degrees winning by default
- [x] 3.3 Assert the fixture angles in `cargo test`: -2.4 for the sample, 1.1 for ilkyaz, -1.4 for irene
- [x] 3.4 Wire wasm-pack into the Vite build and load the module from the browser
  - Both `npm test` and `npm run build` build the optimized module before Vite consumes it.
- [x] 3.5 Pass a full-resolution frame in as a view over WASM memory rather than a copy, and confirm no per-call copy of the frame happens
  - `RgbaFrame.pixels_view()` exposes the owned allocation. Vitest proves its pointer, length and backing buffer remain stable across repeated estimates.
- [x] 3.6 Assert the same fixture angles from Vitest against the built WebAssembly
- [x] 3.7 Measure against the TypeScript it replaces, and measure the compressed size the module adds
  - Sample median: 50.2 ms TypeScript, 27.2 ms WASM. Core plus glue is about 18 KB gzipped; detailed raw, gzip and Brotli figures are in `design.md`.
- [x] 3.8 Decide: continue, or fall back to TypeScript in a Web Worker keeping the corpus. Write the decision and the numbers into design.md either way
  - Continue with Rust: both accuracy and performance gates passed with negligible payload cost.
- [x] 3.9 Delete `web/src/lib/deskew.ts` once both suites pass

## 4. Grow the core

- [x] 4.1 Port edge snapping, with its outward bias, and inherit its fixtures
  - Native and browser tests put a stronger printed rule inside a rough crop and prove the tighter inward search still selects the outward document edge.
- [x] 4.2 Port mask cleanup and the convex hull, asserting that a mask split at a gutter keeps both pieces
  - Both suites assert that two separated mask components and the gutter between them survive as one growing silhouette.
- [x] 4.3 Port outline trimming, and fix the open bug where a hand-adjusted crop has the outline stretched onto it
  - Full-frame mapping preserves a hand crop in the document interior. Automatic trim has a conservative 0.9 percent cap on the most confidently outside pixels; the browser-model corpus now trims irene by 0.876 percent instead of 1.278 percent.
- [x] 4.4 Port rotated-rect extraction
  - Minimum-area rectangle fitting and single-resample rotated extraction are exposed through WASM and tested in Rust and Chrome.
- [x] 4.5 Port the page layout arithmetic, including a known size fitting inside a box rather than matching on width alone
  - A 1:2 crop forced into the 125 by 88 mm passport-page preset is asserted at 44 by 88 mm, not 125 by 250 mm.
- [x] 4.6 Port the tone pass, CLAHE and the shared white point stretch
  - The core owns the 8 by 8 CLAHE grid, shared percentile stretch and hue-preserving luminance ratio; alpha and channel ordering are tested.
- [x] 4.7 Delete each TypeScript counterpart as its replacement passes, so there is never a second implementation kept alongside
  - `deskew.ts` and `tone.ts` are deleted; `detect.ts` and `sheet.ts` retain browser orchestration but no edge, hull, trim or layout arithmetic.

## 5. Computer vision primitives

- [x] 5.1 Contour tracing and polygon simplification
- [x] 5.2 Minimum-area rectangle and convex hull
- [x] 5.3 Connected components with statistics
- [x] 5.4 Morphology, Sobel and Gaussian filters
- [x] 5.5 Affine warp for extracting a rotated rectangle
- [x] 5.6 Test each in Rust alone, with no browser consumer yet
  - Eleven native tests cover the corpus plus every geometry and filter family. The primitives are exported by the WASM package but have no objects-mode consumer yet.
- [x] 5.7 Check the compressed size against the 2 MB ceiling, and against what `opencv-js` would have cost
  - Core after primitives: 94,650 bytes raw, 39,914 gzip, 33,509 Brotli. The exact removed OpenCV package is 4,031,133 bytes as an npm tarball and 14,731,296 bytes unpacked.

## 6. Objects mode, stage one

- [x] 6.1 Prompt the segmenter on a point grid and collect every plausible candidate
  - The browser encodes once, probes an 8 by 8 grid, and retains all three SAM proposals above the recorded score floor.
- [x] 6.2 Filter candidates by shape: area, rectangularity, aspect
  - The WASM morphology and minimum-area rectangle primitives reject platen masks, slivers and non-document shapes before grouping.
- [x] 6.3 Group overlapping candidates by both overlap and containment, since a page inside its sleeve scores only 0.44 on overlap alone and would otherwise never group
  - Browser tests pin both the overlap and containment paths and keep every grouped proposal as an alternative.
- [x] 6.4 Give each item its own angle from the rectangle fitted to it
  - Each candidate stores the angle fitted to its own mask; full-resolution edge refinement runs in that candidate's straightened frame.
- [x] 6.5 List the items with their measured sizes and angles, and let one be selected or removed
  - Objects mode draws each rotated rectangle, lists its physical size and angle, and updates selection, preview and removal together.
- [x] 6.6 Export one page per item
  - The objects path composes each selected crop through the same page renderer as its preview, then merges those single-page PDFs in list order.
- [x] 6.7 Check against the synthetic flatbed: three items found, angles within a fraction of a degree, the ID card measuring 85.6 by 54 mm
  - The public 220 by 180 mm fixture is found as exactly three objects. Measured sizes are within 1 mm per side; angles are within 0.2 degrees, including the ID at 85.9 by 53.3 mm and -6.97 degrees.

## 7. Parity items that do not need the core

- [x] 7.1 Read the page count and let a page be selected, so a multi-page document stops silently becoming page one
  - Verified in Chrome with a two-page PDF: the selector showed both pages and loaded their distinct 50.8 by 25.4 mm and 25.4 by 50.8 mm geometry.
- [x] 7.2 Keep each page's own crop, rotation and measurement when moving between pages
  - Verified in Chrome: page one's quarter-turned 22.9 by 45.7 mm crop and 1.2 degree skew survived a round trip through page two, whose own -0.7 degree skew was also restored.
- [x] 7.3 Zoom and pan, with the crop stated in normalised coordinates so it survives both
  - The scan pane now zooms from half-fit to four-times-fit, supports modifier-wheel zoom and an explicit drag-to-pan mode. Crop coordinates remain normalised against the source image and are never rewritten by view changes.
- [x] 7.4 Output resolution control, defaulting to matching the source
  - Export defaults to the crop's original pixel dimensions, with explicit 150, 300 and 600 dpi choices that resample pixels without changing the PDF's physical placement. Browser tests pin both paths.

## 8. Objects mode, stage two

- [x] 8.1 Offer the overlapping candidates rather than resolving them, with each one's measurement shown
  - Each object row exposes the complete grouped choice set in a measured selector instead of discarding lower-scoring boundaries.
- [x] 8.2 Cycle through candidates, updating crop, measurement and preview together
  - Selecting a choice refines that boundary at full resolution, preserves the object's stable UI identity, and refreshes its rectangle, measurement and output preview together.
- [x] 8.3 Merge selected items, keeping the parts reachable so it can be undone
  - The core fits one rectangle around all selected rotated corners. The merged row stores the original objects and exposes an explicit undo action; native and browser tests pin the geometry and retained parts.
- [x] 8.4 Check against the passport in a sleeve, where the segmenter offers the sleeve and each page but never the spread
  - The opt-in real-model Chrome test finds both page-sized choices and the 125.9 by 186 mm sleeve on irene, while asserting that no 120–130 by 168–182 mm false spread is offered.

## 9. Tidy what is left

- [x] 9.1 Split `web/src/main.ts` into state, view, controls and output
  - State ownership, canvas/crop/zoom interaction, control geometry and preview/PDF composition now live in `app-state.ts`, `app-view.ts`, `app-controls.ts` and `app-output.ts`; `main.ts` retains application orchestration and bindings.
- [x] 9.2 Move `turnBox` and `turnMask` out of the UI file, since they are pure maths and belong under test
  - Both transforms live in `app-controls.ts`; Chrome tests assert a four-turn crop round trip and every mask rotation direction.
- [x] 9.3 Delete the dead stylesheet inherited from the Python app: 15 ids and 36 classes with no match in the browser markup
  - A selector-to-markup/source audit removed every unmatched non-colour selector and the duplicate Python layout blocks. The browser stylesheet fell from 471 to 274 lines.
- [x] 9.4 Remove `EXPECTED_MS`, which nothing references, and the unused `trim` field carried through `plan()`
  - The stale timing constant is gone. Trim is now an explicit export/preview input rather than part of numeric `Layout`/`plan`, and preview/PDF placement share the same planned origin.
- [x] 9.5 Update the README so it describes what the browser build does, rather than the Python build's feature set
  - The README and `web/PORT.md` now describe browser objects, measured alternatives, merge/undo, zoom/pan, multi-page state, output resolution, the Rust core, real Chrome tests and the measured model-latency limitation.
- [x] 9.6 Decide whether the Python build adopts the core through pyo3 or is allowed to drift, and record the decision
  - The Python app remains an independent lab/reference build and keeps asserting the shared corpus. It does not take on pyo3 packaging unless it becomes a supported product again; new browser product maths belongs in the core.

## 10. Known bugs to close along the way

- [x] 10.1 Trimming ignored the crop it was given, so a hand-adjusted crop had the outline stretched onto it. Fixed ahead of the core port; 4.3 must preserve the corrected behaviour
  - Verified in Chrome with a synthetic rounded mask: the automatic crop cleared 60 corner pixels, while a hand-adjusted crop entirely inside the document cleared none.
- [x] 10.2 Multi-page PDFs silently read page one. Closed by 7.1
- [x] 10.3 The Python server shared one stateful predictor across concurrent requests, so two tabs could read each other's images. Fixed with a lock, independent of everything above
  - A concurrency regression test proves two predictor transactions never overlap.
