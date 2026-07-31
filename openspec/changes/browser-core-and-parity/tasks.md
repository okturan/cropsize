## 1. Gate: is anything actually slow

- [x] 1.1 Open the deployed page and read the note under the progress bar to confirm whether the browser is cross-origin isolated. Everything about performance depends on the answer, and threaded WebAssembly needs the same header ONNX does
  - Verified on 2026-07-31 at `https://cropsize.pages.dev/`: `crossOriginIsolated === true` and `SharedArrayBuffer` is available.
- [x] 1.2 If it is not isolated, fix the `_headers` file until it is, and record the encode time before and after. This may be a larger speedup than the entire core
  - Not applicable: production is already isolated, so no header change or before/after encode comparison was required. ONNX Runtime Web 1.27 leaves `numThreads` unset before initialisation, then selected four threads on the measured Chrome host's ten logical cores.
- [ ] 1.3 Record the current baseline on the fixture scans: encode time, total time from opening a file to a crop on screen, and peak memory. Without this there is nothing to claim an improvement against
  - Partial production baseline on 2026-07-31, Chrome, base-plus fp16/WASM, model files cached but sessions cold:
    - `sample-scan.pdf`: encode 16.255 s; open-to-crop 35.105 s; peak sampled JS heap 262,808,671 bytes (250.6 MiB); decoder passes 52.7 ms and 46.9 ms.
  - Pending: repeat the same probe for the two private fixtures. Chrome refused local file selection until the ChatGPT extension is granted file-URL access.

## 2. The golden corpus

- [ ] 2.1 Move the three fixture scans into a shared location both suites can read. The synthetic sample stays the only one safe to publish, the passports stay local
- [ ] 2.2 Write the fixture table: expected skew, detected box, measured size in millimetres, and the proportion of a crop that trimming changes, with tolerances in millimetres and degrees
- [ ] 2.3 Assert the table from the existing Python tests, so the corpus is proven against the implementation that already works before anything is ported
- [ ] 2.4 Set up Vitest in the browser build and assert the same table against the current TypeScript, recording which entries it already fails

## 3. Spike: deskew in Rust

- [ ] 3.1 Create the `core/` Rust workspace and install wasm-pack
- [ ] 3.2 Port skew estimation only: the ink threshold, the projection, the border inset, the smoothing that stops zero degrees winning by default
- [ ] 3.3 Assert the fixture angles in `cargo test`: -2.4 for the sample, 1.1 for ilkyaz, -1.4 for irene
- [ ] 3.4 Wire wasm-pack into the Vite build and load the module from the browser
- [ ] 3.5 Pass a full-resolution frame in as a view over WASM memory rather than a copy, and confirm no per-call copy of the frame happens
- [ ] 3.6 Assert the same fixture angles from Vitest against the built WebAssembly
- [ ] 3.7 Measure against the TypeScript it replaces, and measure the compressed size the module adds
- [ ] 3.8 Decide: continue, or fall back to TypeScript in a Web Worker keeping the corpus. Write the decision and the numbers into design.md either way
- [ ] 3.9 Delete `web/src/lib/deskew.ts` once both suites pass

## 4. Grow the core

- [ ] 4.1 Port edge snapping, with its outward bias, and inherit its fixtures
- [ ] 4.2 Port mask cleanup and the convex hull, asserting that a mask split at a gutter keeps both pieces
- [ ] 4.3 Port outline trimming, and fix the open bug where a hand-adjusted crop has the outline stretched onto it
- [ ] 4.4 Port rotated-rect extraction
- [ ] 4.5 Port the page layout arithmetic, including a known size fitting inside a box rather than matching on width alone
- [ ] 4.6 Port the tone pass, CLAHE and the shared white point stretch
- [ ] 4.7 Delete each TypeScript counterpart as its replacement passes, so there is never a second implementation kept alongside

## 5. Computer vision primitives

- [ ] 5.1 Contour tracing and polygon simplification
- [ ] 5.2 Minimum-area rectangle and convex hull
- [ ] 5.3 Connected components with statistics
- [ ] 5.4 Morphology, Sobel and Gaussian filters
- [ ] 5.5 Affine warp for extracting a rotated rectangle
- [ ] 5.6 Test each in Rust alone, with no browser consumer yet
- [ ] 5.7 Check the compressed size against the 2 MB ceiling, and against what `opencv-js` would have cost

## 6. Objects mode, stage one

- [ ] 6.1 Prompt the segmenter on a point grid and collect every plausible candidate
- [ ] 6.2 Filter candidates by shape: area, rectangularity, aspect
- [ ] 6.3 Group overlapping candidates by both overlap and containment, since a page inside its sleeve scores only 0.44 on overlap alone and would otherwise never group
- [ ] 6.4 Give each item its own angle from the rectangle fitted to it
- [ ] 6.5 List the items with their measured sizes and angles, and let one be selected or removed
- [ ] 6.6 Export one page per item
- [ ] 6.7 Check against the synthetic flatbed: three items found, angles within a fraction of a degree, the ID card measuring 85.6 by 54 mm

## 7. Parity items that do not need the core

- [ ] 7.1 Read the page count and let a page be selected, so a multi-page document stops silently becoming page one
- [ ] 7.2 Keep each page's own crop, rotation and measurement when moving between pages
- [ ] 7.3 Zoom and pan, with the crop stated in normalised coordinates so it survives both
- [ ] 7.4 Output resolution control, defaulting to matching the source

## 8. Objects mode, stage two

- [ ] 8.1 Offer the overlapping candidates rather than resolving them, with each one's measurement shown
- [ ] 8.2 Cycle through candidates, updating crop, measurement and preview together
- [ ] 8.3 Merge selected items, keeping the parts reachable so it can be undone
- [ ] 8.4 Check against the passport in a sleeve, where the segmenter offers the sleeve and each page but never the spread

## 9. Tidy what is left

- [ ] 9.1 Split `web/src/main.ts` into state, view, controls and output
- [ ] 9.2 Move `turnBox` and `turnMask` out of the UI file, since they are pure maths and belong under test
- [ ] 9.3 Delete the dead stylesheet inherited from the Python app: 15 ids and 36 classes with no match in the browser markup
- [ ] 9.4 Remove `EXPECTED_MS`, which nothing references, and the unused `trim` field carried through `plan()`
- [ ] 9.5 Update the README so it describes what the browser build does, rather than the Python build's feature set
- [ ] 9.6 Decide whether the Python build adopts the core through pyo3 or is allowed to drift, and record the decision

## 10. Known bugs to close along the way

- [ ] 10.1 Trimming ignores the crop it is given, so a hand-adjusted crop has the outline stretched onto it. Closed by 4.3
- [ ] 10.2 Multi-page PDFs silently read page one. Closed by 7.1
- [ ] 10.3 The Python server shares one stateful predictor across concurrent requests, so two tabs read each other's images. Fix with a lock, independent of everything above
