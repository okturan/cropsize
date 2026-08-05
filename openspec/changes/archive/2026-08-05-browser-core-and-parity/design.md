## Context

cropsize exists twice. The Python build is complete and now has 26 collected tests. The browser build is what the public URL serves, and it began as a hand port with no fixture suite. The port has already produced three defects that the original never had:

| defect | cause | how it was caught |
| --- | --- | --- |
| tilt reported as 0.0 on a scan tilted 1.4 degrees | projected onto `x·sin + y·cos` where OpenCV uses `-x·sin + y·cos`, and zero degrees won by default because its row coordinates land on whole numbers | replicating the TypeScript back into Python and comparing |
| 72.7 percent of a passport's second page whited out | kept only the largest connected mask region, but a spread splits at the gutter | measuring pixels the trim changed, after a first measurement counted the naturally white page as damage |
| corners square on some sides, clipped on others | outline mapped through a box that gets snapped afterwards, and the two disagree by up to 0.4 mm per side | printing both boxes and differencing them |

None of these were visible by looking at the screen. All were found by comparing numbers against an implementation that already worked.

At proposal time the browser could not do objects mode, which was the largest remaining feature gap, and objects mode needed a computer vision layer that the browser build did not have at all. `@techstark/opencv-js` was added and then removed during the public release cleanup. The applied change now supplies that layer through the focused Rust core.

Relevant measured facts carried in from earlier work and the production gate:

- Native CPU reference, not a browser result: SAM 2.1 base-plus fp16 ONNX encoded in 1.9 s and decoded in about 70 ms.
- Production browser baseline on 2026-07-31, Chrome, base-plus fp16/WASM, model files cached and sessions cold: encoder 16.255 s; decoder passes 52.7 ms and 46.9 ms; 35.105 s from opening the sample to seeing the crop; peak sampled JavaScript heap 250.6 MiB.
- Production is cross-origin isolated. ONNX Runtime Web 1.27 leaves `ort.env.wasm.numThreads` unset until its first WASM session, then resolved it to four threads on the measured host's ten logical cores. The browser/native gap is not a one-thread header failure.
- The browser holds three full-resolution frames, roughly 110 MB for a 300 dpi A4.
- Before the core port, `snapEdges` allocated a 36 MB float array per call and `refreshOutput` re-cropped and re-trimmed about 3M pixels on every settings change.
- Known-good answers: deskew of -2.4 on the sample, 1.1 on ilkyaz, -1.4 on irene. Measured sizes of 104.9 by 147.9 mm on the sample against a true 105 by 148, and 175.1 by 126.7 mm on the landscape ilkyaz scan.

## Goals / Non-Goals

**Goals:**

- One implementation of the imaging maths, in one language, with one test suite.
- The computer vision primitives objects mode needs, without importing a 10 MB general-purpose library.
- Feature parity for the browser build: objects, alternatives, merge, zoom and pan, output resolution, multi-page.
- Numeric behaviour pinned by fixtures so drift is caught by a test rather than by a user screenshot.

**Non-Goals:**

- Rewriting the Python build on the core. The Python app remains a local reference build; pyo3 packaging is deliberately not part of this change.
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

### Spike result: continue with Rust

The kill switch was evaluated on 2026-08-02 and the spike passed:

- Native `cargo test` and browser Vitest both reproduce all three fixture angles within the 0.3 degree contract.
- In headless Chrome on the 2551 by 3508 sample, seven warm repetitions measured a 50.2 ms median for TypeScript and 27.2 ms for WebAssembly, a 1.85 times speedup. A second run measured 49.0 ms and 30.4 ms; the direction is stable even though browser timing varies.
- JavaScript writes the frame once through a live `Uint8Array` view over the core allocation. The browser test confirms that repeated estimates retain the same pointer, byte length and underlying WebAssembly buffer.
- The optimized module is 33,838 bytes raw, 15,538 bytes with gzip and 13,609 bytes with Brotli. Its generated JavaScript glue is 7,427 bytes raw and 2,197 bytes with gzip; together they are about 18 KB gzipped, far below the 2 MB ceiling.

The decision is to continue growing the Rust core. `web/src/lib/deskew.ts` was removed after the native and browser corpus suites passed, so skew estimation again has one implementation.

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

The golden corpus has one checked-in synthetic scan plus a tracked table of expected values: skew angle, detected box, measured millimetres, and the fraction of a crop that trimming changes. The two passport PDFs remain outside Git; their hashes and stable local names are tracked, and ignored symlinks make them available to every local suite. Rust asserts the table in `cargo test`. The browser asserts it in Vitest against the built WASM. Any change that moves a number has to move the table too, deliberately and in review.

### Objects mode ships in two stages

Stage one was implemented and verified first: find several items, give each its own rotation, export a page each. Stage two then added measured overlapping choices and reversible merge. Keeping the stages separate made the synthetic flatbed contract pass before the sleeve interaction was added.

### The Python build stays independent

The browser is the product and the Rust core is the source of truth for new imaging maths. The local Python app will not adopt this core through pyo3 in this change. Shipping a native extension would add platform wheels, Python ABI support and another release path for a build that is now the lab bench rather than the public product.

The Python fixture suite remains valuable as an independent reference. Both builds read the same corpus, so a numeric disagreement stays visible instead of being hidden behind shared code. New browser product behavior goes into the core; the Python build may drift in features, but changes to its recorded fixture answers must still be deliberate. Revisit pyo3 only if the local app becomes a supported product again.

## Risks / Trade-offs

**The browser model remains slow with threading available** → Production is isolated and ONNX Runtime uses four threads on the measured host, yet the base-plus encoder still took 16.255 s. The remaining encoder work is on the model/runtime side. The Rust core still has a case as the single tested home for geometry and the missing computer-vision primitives, but it must not be sold as the fix for model latency.

**Rust becomes a second language nobody wants to maintain** → The spike is deliberately scoped to one function so this is discovered in a day rather than after the computer vision layer is committed. If the spike is unpleasant, the fallback is the Worker plus golden corpus, which keeps the tests and forfeits the single source of truth.

**WASM bundle size** → A focused crate should be well under `opencv-js` at roughly 10 MB, but this is an assumption until measured. Budget: the core must stay under 2 MB compressed, or the download argument that justified it disappears.

Measured after the complete primitive layer on 2026-08-02: the optimized core is 94,650 bytes raw, 39,914 bytes with gzip and 33,509 bytes with Brotli. The exact removed dependency, `@techstark/opencv-js@5.0.0-release.1`, is a 4,031,133-byte npm tarball and 14,731,296 bytes unpacked. The focused core is about one hundredth of the compressed package and uses 2 percent of its own 2 MB ceiling.

After the objects-mode edge refinement and merge geometry were added, the final production module is 96,929 bytes raw, 40,879 bytes with gzip and 34,180 bytes with Brotli.

**Porting introduces its own drift** → Exactly the failure being fixed, so the golden corpus lands with the spike rather than after it. The spike is not complete until the fixture table passes.

**Numeric differences between OpenCV and a Rust reimplementation** → Contour tracing and minimum-area rectangle have many valid implementations that differ in edge cases. Tolerances in the fixture table need to be stated as physical quantities, in millimetres and degrees, rather than exact pixel equality.

**Objects mode may not be what browser users want** → The work was kept in two independently tested stages. The browser now has the complete behavior, but deployment telemetry or user reports should decide whether it deserves further prominence.

## Migration Plan

1. Confirm cross-origin isolation and the effective ONNX Runtime thread count on the deployed page. Complete on 2026-07-31: isolation is on and ORT initialises four WASM threads on the measured host.
2. Spike: Rust deskew, wasm-pack build, fixture table, wired into the browser build behind the existing straighten control. Ship it. Delete `deskew.ts` only once the fixtures pass in both suites.
3. Grow the core function by function, each one replacing its TypeScript counterpart and inheriting its fixtures. Order: snap, hull and mask cleanup, trim, rotated-rect extraction.
4. Add the computer vision primitives with no consumer yet, tested in Rust alone.
5. Objects mode stage one on top of them.
6. Parity items that do not need the core, in any order: multi-page navigation, zoom and pan, output resolution.
7. Objects mode stage two: measured alternatives, candidate selection and reversible merge.

Rollback is a Git revert to the last fixture-passing core revision. The TypeScript counterparts were deleted as their replacements passed, so the repository does not retain a quiet second implementation.

## Resolved Questions

- Objects mode includes the full Python behavior: separate items, per-item rotation, measured alternatives and reversible merge.
- Multi-page navigation is both a correctness fix and part of the supported browser workflow. Every page remains reachable and keeps its own state.
- The 2 MB compressed ceiling stays as a conservative guard. The finished primitive layer is 33,509 bytes with Brotli, so the exact ceiling is not a live trade-off.
- The Python lab bench is allowed to drift in features. It keeps asserting the shared corpus, but it does not take on pyo3 packaging unless it becomes a supported product again.
