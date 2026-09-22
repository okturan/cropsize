# Browser build

The public product is the static app at [cropsize.pages.dev](https://cropsize.pages.dev).
PDF parsing, image processing, segmentation and PDF writing happen in the tab. Scans are not
sent to an application server.

## Production baseline

Measured in Chrome on 2026-07-31 with cached model files and cold sessions:

| Fact | Result |
| --- | --- |
| Cross-origin isolation | On; `SharedArrayBuffer` is available. |
| ONNX Runtime threads | Four WASM threads on a host with ten logical cores. |
| Default model | SAM 2.1 base-plus fp16, about 163 MB. |
| Optional model | SAM 2.1 tiny fp16, about 78 MB. |
| Base-plus encoder | 16.255 seconds on the public sample. |
| Open to crop | 35.105 seconds on the public sample. |
| Decoder passes | 52.7 ms and 46.9 ms. |
| Peak sampled JavaScript heap | 250.6 MiB. |

The browser is already isolated and multithreaded. The encoder time is real model inference,
not a missing-header problem. The Rust core below is a correctness and parity investment; it
does not fix that latency.

## What ships

- PDF and raster input. PDF page geometry supplies physical scale; raster files are reported
  as scale unknown.
- Multi-page navigation with separate crop, rotation, skew and object state on every visited
  page.
- Single-document detection with a draggable normalized crop and optional corner trimming.
- Several-items detection from one model encode. Every item carries its own fitted angle and
  exports as its own PDF page.
- Measured overlapping candidates, selection between them, merging selected items and undo.
- A sheet tray: crops pinned from any file or page print together on one sheet, stacked or
  side by side at their sizes, flowing onto more pages only when they cannot fit.
- Detection that votes across several prompts when the box prompt returns the whole frame,
  so a card photographed on a plain surface is found rather than the surface.
- Fit zoom, up to four-times zoom, modifier-wheel zoom and drag-to-pan mode.
- Real-size, known-size and fill-sheet output on A3, A4, A5, Letter, Legal or no sheet.
- Source-pixel export by default, plus explicit 150, 300 and 600 dpi output.
- Optional CLAHE and white-point controls.
- Base-plus and tiny model choices with verified local caching in the Cache API. The choice is
  remembered between visits.
- A stepped loading panel: download bytes, speed and time left; model start and encoder
  filling against this device's own previous timings; counted detection passes. It appears
  only when work takes longer than a quarter second.
- Model work runs one job at a time, and an encoding is reused for as long as the image on
  screen is unchanged, so detecting again or finding several items skips the encoder.
- Phone photos of ID-1 cards print at 85.6 by 54 mm under Real size; Known size turns its
  preset to match an upright crop.

## Implementation map

| Area | Browser implementation |
| --- | --- |
| Source | `pdfjs-dist`, rendered page by page with PDF geometry preserved. |
| Segmentation | SAM 2.1 through `onnxruntime-web`; one encode, then box, point or grid prompts. |
| Imaging maths | `core/crates/imaging-core`, compiled with `wasm-pack`. |
| Browser orchestration | `main.ts` wires `model.ts` (model choice and job queue), `workspace.ts` (document, pages, detection, items, sheet tray) and `ui/` (loading panel, scan pane, output, settings, lists). |
| Model cache | Cache API, one entry per artifact, keyed by pinned revision. IndexedDB caps a value at 127 MB in Chrome, below the 153 MB encoder weights. |
| PDF output | `pdf-lib`; source pixels by default, optional explicit resampling. |
| Sheet packing | TypeScript in `sheet.ts`: column, row or shelf layout of several items on one page. |
| Tests | Native Rust tests, Vitest Browser Mode in headless Chrome, and a Playwright end-to-end run of the real UI. |

The core owns skew, edge snapping, mask cleanup, convex hulls, trimming, rotated extraction,
page layout arithmetic, tone work and the computer-vision primitives used by objects mode.
TypeScript owns the DOM, canvas interaction, ONNX orchestration, PDF parsing and PDF writing.
There is no TypeScript copy of the core maths.

The final optimized core measures 96,929 bytes raw, 40,879 bytes with gzip and 34,180 bytes
with Brotli. The removed `@techstark/opencv-js@5.0.0-release.1` package is 4,031,133
bytes as an npm tarball and 14,731,296 bytes unpacked.

## Fixtures and tests

`fixtures/corpus.json` is the shared contract. The public synthetic scan is checked in. The
two passport PDFs remain outside Git; ignored links under `fixtures/private/` point to the
original local files, and the manifest pins their hashes and expected measurements.

```bash
cd web
npm test
CROPSIZE_RUN_BROWSER_MODEL_FIXTURES=1 npm test
```

The ordinary suite builds the WASM core and runs module tests in Chrome. The opt-in suite
loads the real base-plus model and checks the public flatbed plus any private fixtures present
on the machine.

```bash
npm run e2e                                   # a local dev server
npm run e2e -- --url https://cropsize.pages.dev   # the deployed site
npm run e2e -- --shots /tmp/cropsize-shots    # with a screenshot per stage
```

The end-to-end run drives the whole UI in Chrome: detection on a throttled first download
with every loading-panel state recorded, measurement, turns, dragging a corner, detecting
again, several items with merge, undo and remove, every print mode, the PDFs themselves, two
files on one sheet, a two-page PDF, the straighten and contrast controls, and switching
models. It also fails on any page error, console error or failed request. Weights are served
from `web/.models/<size>/` when that ignored folder exists, which keeps it offline and fast;
otherwise they come from Hugging Face. The dev server alone serves that folder, so it can
never end up in a build.

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
