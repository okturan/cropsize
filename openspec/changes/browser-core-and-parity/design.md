## Context

cropsize exists twice. The Python build is complete and has 16 tests. The browser build is what the public URL serves, and it is a hand port with no fixture suite. The port has already produced three defects that the original never had:

| defect | cause | how it was caught |
| --- | --- | --- |
| tilt reported as 0.0 on a scan tilted 1.4 degrees | projected onto `x·sin + y·cos` where OpenCV uses `-x·sin + y·cos`, and zero degrees won by default because its row coordinates land on whole numbers | replicating the TypeScript back into Python and comparing |
| 72.7 percent of a passport's second page whited out | kept only the largest connected mask region, but a spread splits at the gutter | measuring pixels the trim changed, after a first measurement counted the naturally white page as damage |
| corners square on some sides, clipped on others | outline mapped through a box that gets snapped afterwards, and the two disagree by up to 0.4 mm per side | printing both boxes and differencing them |

None of these were visible by looking at the screen. All were found by comparing numbers against an implementation that already worked.

Meanwhile the browser cannot do objects mode, which is the largest remaining feature gap, and objects mode needs a computer vision layer that the browser build does not have at all. `@techstark/opencv-js` was added and then removed during the public release cleanup.

Relevant measured facts carried in from earlier work and the production gate:

- Native CPU reference, not a browser result: SAM 2.1 base-plus fp16 ONNX encoded in 1.9 s and decoded in about 70 ms.
- Production browser baseline on 2026-07-31, Chrome, base-plus fp16/WASM, model files cached and sessions cold: encoder 16.255 s; decoder passes 52.7 ms and 46.9 ms; 35.105 s from opening the sample to seeing the crop; peak sampled JavaScript heap 250.6 MiB.
- Production is cross-origin isolated. ONNX Runtime Web 1.27 leaves `ort.env.wasm.numThreads` unset until its first WASM session, then resolved it to four threads on the measured host's ten logical cores. The browser/native gap is not a one-thread header failure.
- The browser holds three full-resolution frames, roughly 110 MB for a 300 dpi A4.
- `snapEdges` allocates a 36 MB float array per call. `refreshOutput` re-crops and re-trims about 3M pixels on every settings change.
- Known-good answers: deskew of -2.4 on the sample, 1.1 on ilkyaz, -1.4 on irene. Measured sizes of 104.9 by 147.9 mm on the sample against a true 105 by 148, and 127.2 by 174.9 mm on ilkyaz against a true 125 by 176.

## Goals / Non-Goals

**Goals:**

- One implementation of the imaging maths, in one language, with one test suite.
- The computer vision primitives objects mode needs, without importing a 10 MB general-purpose library.
- Feature parity for the browser build: objects, alternatives, merge, zoom and pan, output resolution, multi-page.
- Numeric behaviour pinned by fixtures so drift is caught by a test rather than by a user screenshot.

**Non-Goals:**

- Rewriting the Python build on the core. Possible later through pyo3, deliberately not now.
- Changing what the tool produces. Same exports, same measurements, same URL.
- A general image processing library. Only the primitives this pipeline actually calls.
- Perspective correction. Still out of scope, as it has been throughout.

## Decisions

### Rust compiled to WebAssembly, rather than TypeScript in a Web Worker

A Worker would move the maths off the main thread and could carry the same golden tests, at no new language cost. It was rejected because it leaves two implementations, and two implementations is the thing that has actually been failing. It also does not solve the missing computer vision primitives, which would still need `opencv-js` at roughly 10 MB.

Rust was chosen over C or AssemblyScript because `imageproc` and `geo` cover contours, morphology, filters and hulls, because the toolchain is already installed, and because the same crate can later serve Python through pyo3 without a second port.

The honest cost is that every future change to the maths happens in Rust. That is why the first substantive task is a spike rather than a migration.

### Spike the deskew first, on its own

Deskew is the right first function: it is self-contained, it has no dependencies on the rest of the core, and it is the function that has already broken twice in ways that were invisible on screen. We know its correct answers to two decimals on three fixtures. If the Rust port reproduces -2.4, 1.1 and -1.4 and runs faster than the JavaScript, the approach is proven on the hardest evidence available. If it does not, we have lost a day and learned it early.

### The core owns geometry and pixels, JavaScript owns everything else

```
   JavaScript                          Rust / WASM
   ─────────────────────────────       ─────────────────────────────
   DOM, canvas, pointer input          skew estimation
   pdf.js page rasterising             edge snapping
   ONNX Runtime orchestration          mask cleanup, convex hull
   pdf-lib PDF writing                 outline trimming
   layout, controls, state             rotated-rect extraction
   deciding what to run                contours, minAreaRect
                                       connected components
                                       morphology, Sobel, blur
                                       page layout arithmetic
```

The boundary is drawn at "does it need the DOM". Anything that is pure array-in, array-out crosses into the core. This keeps the WASM surface small and the bindings boring, and it means the core is testable without a browser at all.

### Data crosses the boundary as raw buffers, not objects

Images pass as `Uint8ClampedArray` views over WASM linear memory, allocated once per frame and reused. Masks pass as `Float32Array`. Geometry returns as small flat arrays of numbers rather than serialised structs. This avoids per-call copying of 36 MB frames, which would erase the speed the core is meant to provide.

### Fixtures are the contract, not prose

The golden corpus is checked in as small fixture scans plus a table of expected values: skew angle, detected box, measured millimetres, and the fraction of a crop that trimming changes. Rust asserts it in `cargo test`. The browser asserts it in Vitest against the built WASM. Any change that moves a number has to move the table too, deliberately and in review.

### Objects mode ships in two stages

Stage one is find several items, give each its own rotation, export a page each. Stage two is the alternatives cycle and merge. Stage one is roughly a third of the work and delivers most of the value, and it is worth shipping before committing to the interaction design of stage two.

## Risks / Trade-offs

**The browser model remains slow with threading available** → Production is isolated and ONNX Runtime uses four threads on the measured host, yet the base-plus encoder still took 16.255 s. The remaining encoder work is on the model/runtime side. The Rust core still has a case as the single tested home for geometry and the missing computer-vision primitives, but it must not be sold as the fix for model latency.

**Rust becomes a second language nobody wants to maintain** → The spike is deliberately scoped to one function so this is discovered in a day rather than after the computer vision layer is committed. If the spike is unpleasant, the fallback is the Worker plus golden corpus, which keeps the tests and forfeits the single source of truth.

**WASM bundle size** → A focused crate should be well under `opencv-js` at roughly 10 MB, but this is an assumption until measured. Budget: the core must stay under 2 MB compressed, or the download argument that justified it disappears.

**Porting introduces its own drift** → Exactly the failure being fixed, so the golden corpus lands with the spike rather than after it. The spike is not complete until the fixture table passes.

**Numeric differences between OpenCV and a Rust reimplementation** → Contour tracing and minimum-area rectangle have many valid implementations that differ in edge cases. Tolerances in the fixture table need to be stated as physical quantities, in millimetres and degrees, rather than exact pixel equality.

**Objects mode may not be what browser users want** → It was built for the Python build and has never been exercised by anyone but us. Stage one first, and watch whether it gets used before building the alternatives cycle.

## Migration Plan

1. Confirm cross-origin isolation and the effective ONNX Runtime thread count on the deployed page. Complete on 2026-07-31: isolation is on and ORT initialises four WASM threads on the measured host.
2. Spike: Rust deskew, wasm-pack build, fixture table, wired into the browser build behind the existing straighten control. Ship it. Delete `deskew.ts` only once the fixtures pass in both suites.
3. Grow the core function by function, each one replacing its TypeScript counterpart and inheriting its fixtures. Order: snap, hull and mask cleanup, trim, rotated-rect extraction.
4. Add the computer vision primitives with no consumer yet, tested in Rust alone.
5. Objects mode stage one on top of them.
6. Parity items that do not need the core, in any order: multi-page navigation, zoom and pan, output resolution.
7. Objects mode stage two.

Rollback at any point is to keep the TypeScript implementation alongside and switch back, since each step replaces one function and both can coexist behind the same signature.

## Open Questions

- Does objects mode in the browser mean the full Python behaviour, including the alternatives cycle and merge, or is stage one sufficient?
- Is multi-page a real need, or only a correctness fix so it stops silently reading page one with nothing said?
- Is 2 MB the right ceiling for the core, given the model download is already 163 MB and dwarfs it?
- Should the Python build eventually adopt the core through pyo3, or is it acceptable for the lab bench to drift once it is no longer the product?
