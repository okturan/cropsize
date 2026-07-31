## Why

The browser build at cropsize.pages.dev is now the product, but it is the weaker half. It cannot do multi-object mode, it silently reads only page one of a multi-page PDF, and its imaging maths is a hand port of the Python original with zero tests, which has already produced three real defects: an inverted sign in the deskew projection, a zero-degree bias that reported no tilt on a scan tilted 1.4 degrees, and a mask cleanup that whited out 72.7 percent of a passport's second page.

Closing the feature gap forces the issue rather than sidestepping it. Objects mode needs `findContours`, `minAreaRect`, `connectedComponents`, `approxPolyDP`, `convexHull`, `warpAffine` and `morphologyEx`, none of which exist in the browser build today. So a computer vision core is being added whether or not the duplication is addressed. Writing it once, in one language, with one test suite, costs about the same as importing one and leaves a single source of truth instead of two implementations that provably drift.

## What Changes

- Add `cropsize-core`, a Rust crate compiled to WebAssembly, holding the imaging maths that is currently written twice: skew estimation, edge snapping, mask cleanup and hull, outline trimming, rotated-rect extraction, and the page layout arithmetic.
- Add the computer vision primitives the browser lacks: contour tracing, minimum-area rectangle, connected components, polygon simplification, convex hull, morphology, Sobel and Gaussian filters, and affine warp.
- Move the browser build's `deskew.ts`, the geometry half of `detect.ts`, and the trim in `sheet.ts` onto the core. JavaScript keeps the DOM, canvas, pdf.js, ONNX Runtime, pdf-lib and all UI.
- Bring the browser build to parity with the Python build: multi-object detection with one page per object, the overlapping-candidate alternatives cycle, merging selected objects, zoom and pan, an output resolution control, and multi-page PDF navigation.
- **BREAKING** for the browser build's internals only: `web/src/lib/deskew.ts` and `web/src/lib/tone.ts` are replaced by core bindings. No user-facing behaviour is removed, and the deployed URL and exported PDFs are unchanged.
- Add a golden corpus of fixture scans with known answers, asserted by both the Rust tests and the browser tests, so a sign flip cannot pass review again.
- Extract `web/src/main.ts`, currently 445 lines holding state, rendering, pointer handling, output composition and event wiring, into separate modules. Move the pure functions `turnBox` and `turnMask` out of the UI file.
- Delete the dead stylesheet inherited from the Python app: 15 ids and 36 classes with no match in the browser markup, which is also how a `.seg` collision stacked the size buttons vertically.

Not in scope: rewriting the Python build on the core. That is possible later through pyo3 and is explicitly a side effect rather than a goal, because Python is now a lab bench rather than the product.

## Capabilities

### New Capabilities
- `imaging-core`: the shared, tested implementation of skew estimation, edge snapping, mask cleanup, outline trimming and rotated-rect extraction, with the numeric guarantees each must meet.
- `object-detection`: finding several items on one scan, giving each its own rotation, offering the overlapping candidates a segmenter proposes rather than silently resolving them, and merging selections.
- `document-source`: reading a scan into the browser with its physical scale intact, including multi-page documents and page selection.
- `page-output`: composing a crop onto a sheet at a chosen physical size and writing the PDF, including the output resolution control.

### Modified Capabilities
None. No specs exist in `openspec/specs/` yet, so every capability above is new.

## Impact

**New**: a Rust workspace at `core/`, a wasm-pack build step, and a WebAssembly artifact loaded by the browser build. Rust and Cargo are already installed on the machine; wasm-pack is not.

**Changed**: `web/src/lib/deskew.ts`, `detect.ts`, `sheet.ts`, `tone.ts` become thin bindings. `web/src/main.ts` is split. `web/src/style.css` loses its dead half. `web/vite.config.ts` and CI gain the wasm build.

**Runtime**: threaded WebAssembly needs cross-origin isolation, the same requirement ONNX Runtime already has. The `_headers` file was malformed until recently and may still not be applying, which would cap both at a single thread. Confirming that is the first task, because it gates whether any of this is faster.

**Risk**: Rust becomes a second language in the project, and every future change to the maths happens there. The first task after the isolation check is a spike that ports only the deskew, measured against answers we already know to two decimals, so the approach is proven cheaply before the computer vision layer commits to it.
