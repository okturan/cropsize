# Browser build: current state

The public product is the static app at [cropsize.pages.dev](https://cropsize.pages.dev).
PDF parsing, image processing, segmentation and PDF writing happen in the tab. A scan is not
sent to an application server.

This file records what the browser build does now. The implementation plan for closing the
remaining gaps lives in `openspec/changes/browser-core-and-parity/`.

## Production facts

Measured on 2026-07-31 in Chrome:

| Fact | Current result |
| --- | --- |
| Cross-origin isolation | On. `crossOriginIsolated === true`; `SharedArrayBuffer` is available. |
| ONNX Runtime threads | `ort.env.wasm.numThreads` is unset before the first WASM session. ONNX Runtime Web 1.27 then selected 4 threads on a host reporting 10 logical cores. |
| Default model | SAM 2.1 base-plus, fp16, about 163 MB. Tiny fp16, about 78 MB, is optional. |
| Sample skew | -2.4 degrees. |
| Sample size | 104.9 by 147.9 mm against a true 105 by 148 mm. |
| Browser baseline | Base-plus encoder 16.255 s; decoder passes 52.7 ms and 46.9 ms; 35.105 s from opening the sample to seeing the crop. Model files were cached and sessions were cold. |
| Peak sampled JavaScript heap | 250.6 MiB during that run. |

The old 0.74 s and 1.9 s encoder figures came from native CPU runs. They are useful model
comparisons, but they are not browser performance figures. The production browser is already
isolated and ORT is already multithreaded, so the current 16.255 s encoder result is not a
missing-header or one-thread problem.

## What ships

- PDF and raster input. PDF page geometry supplies the physical scale; raster files are
  reported as scale unknown.
- The first page of a PDF, rendered at 300 dpi.
- Automatic skew measurement, single-document segmentation, edge snapping and a draggable
  crop rectangle.
- Optional corner trimming, contrast and white-point controls.
- Real-size, known-size and fill-sheet layout on A3, A4, A5, Letter, Legal or no sheet.
- A preview composed by the same path used for PDF export.
- Local model caching and a choice between base-plus and tiny.

## What does not ship yet

- Several-items mode, per-item rotation, candidate cycling or merge.
- Multi-page navigation. The browser currently opens page one without exposing the page
  count.
- Zoom and pan.
- Output-resolution control.
- Browser fixture tests. The TypeScript imaging maths is still a hand port with no Vitest
  coverage.

## Implementation map

| Area | Browser implementation | Current limitation |
| --- | --- | --- |
| Source | `pdfjs-dist` and canvas | `loadPdf()` always calls `getPage(1)`. |
| Segmentation | SAM 2.1 through `onnxruntime-web` | One box/point result, not an object set. |
| Geometry | Hand-written TypeScript in `deskew.ts`, `detect.ts` and `sheet.ts` | No shared core and no fixture suite. |
| Computer vision primitives | None | `opencv-js` was removed during the public-release cleanup. |
| Output | `pdf-lib` | Fixed internal export resolution. |
| UI | One `main.ts` file plus canvas | No page state, object list, zoom or pan. |

Two constraints still shape the build:

1. ONNX Runtime is loaded from jsDelivr with Subresource Integrity, keeping its runtime
   binaries outside the application bundle. The largest WASM variant in 1.27.0 is
   26,827,543 bytes.
2. The model weights use `.onnx_data` sidecars. They must be passed through ORT's
   `externalData` option and are verified against the pinned byte manifest before caching.

## Tests and next work

The Python suite has 15 tests for physical scale, crop geometry, page layout, rotation,
deskew, trimming and PDF export. The browser does not yet assert those fixtures. The
`browser-core-and-parity` OpenSpec change adds a shared corpus, a browser suite and a measured
Rust/WASM spike before committing to the rest of the computer-vision layer.

## Run and deploy

```bash
cd web
npm install
npm run dev
npm run build
npm run deploy
```

`npm run deploy` publishes `web/dist` to the existing Cloudflare Pages project named
`cropsize`.
