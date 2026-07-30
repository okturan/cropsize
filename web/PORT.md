# Browser port — status and plan

The goal is a static Cloudflare Pages site where nothing leaves the machine, which turns
cropsize's privacy claim from a promise into an architecture and removes PyMuPDF from the
deployed browser path. The repository itself is licensed under AGPL-3.0.

## Verified before writing any of this

| Question | Answer |
|---|---|
| Does SAM 2.1 ONNX exist? | Yes — `onnx-community/sam2.1-hiera-{tiny,small,base-plus,large}-ONNX`, encoder and decoder as separate graphs. No export work needed. |
| Does it run, and is it accurate enough? | Yes. tiny/fp32 on the white-background reference scan gives **126.9 x 177.5 mm** against torch base-plus's 126.1 x 177.0 and a true 125.0 x 176.0 — a 39M model within 0.8 mm of the 81M one. |
| Is it fast enough? | On **CPU**: encoder 0.74 s, decoder **36 ms**. The decoder is the per-click path, so clicking and hovering will feel instant; WebGPU only improves the encode. |
| Download size? | tiny/fp16 **77.5 MB**, tiny/fp32 155 MB, base-plus/fp16 163 MB. |
| Licences | onnxruntime-web MIT, pdfjs-dist Apache-2.0, pdf-lib MIT and split.js MIT. The browser path does not load PyMuPDF; third-party notices ship with the build. |

## Done

- `src/lib/constants.ts` — models pinned to immutable revisions with an exact byte
  manifest, plus the preprocessing contract read off the graphs (1024x1024 non-aspect-
  preserving resize, ImageNet normalisation, 256x256 mask output).
- `src/lib/model-loader.ts` — fetch with filename allowlist, `Content-Length` check,
  mid-stream overflow abort and exact-size verification.
- `src/lib/model-cache.ts` — IndexedDB cache keyed by revision, best-effort.
- `src/lib/sam.ts` — encode-once / decode-per-prompt session wrapper, WebGPU with WASM
  fallback, external-data wiring.
- Vite + TypeScript in strict mode with `noUncheckedIndexedAccess`, Pages deploy script,
  `_headers` for cross-origin isolation.

Two constraints found by building it rather than by reading docs:

1. **ORT must come from a CDN, not the bundle.** Its threaded WASM binary is 26.8 MB and
   Cloudflare Pages rejects files over 25 MiB. Loaded via `<script>` with Subresource
   Integrity, exactly as tinyvoice does. Bundle went 27 MB -> 16 KB.
2. **onnx-community ships weights in a sidecar `.onnx_data`.** ORT will not find it on its
   own — it must be passed via the session's `externalData` option — and tinyvoice's
   `/\.onnx$/` filename allowlist rejects it outright.

## Done since: the app itself

The browser build now loads a scan, detects, measures, lays out and exports on its own. What
moved across, and what is still only in the Python build:

| Python | Browser | Notes |
|---|---|---|
| PyMuPDF render + page geometry | `pdfjs-dist` | Page size in points comes from `getViewport`; the embedded-image dpi used by `page_optical_dpi` is harder to reach and may need `getOperatorList`. **The dpi inference is the risk item.** |
| `cv2` warpAffine, Sobel, CLAHE, morphology, `findContours`, `minAreaRect`, `approxPolyDP`, `connectedComponents` | `@techstark/opencv-js` | All present in the WASM build. ~10 MB, cached. |
| `estimate_skew`, `snap_edges`, `mask_to_obj`, `group_objects`, `refine_obj`, `trim_to_outline` | port to TS | Pure array maths over OpenCV primitives; direct translation. |
| `place_on_page`, `to_pdf` | `pdf-lib` | Physical-size maths is unit arithmetic and moves as-is. |
| Editor UI | already vanilla JS canvas | Largely portable from `static/app.js`. |

Suggested order: PDF load + dpi inference first (it is the risk), then SAM wiring against
the reference scans, then the imaging translation, then export.

## Guard rail

The Python test suite encodes the properties that must survive the port: measurement
invariant across 150/300/600/1200 dpi, physical size surviving a crop, exact page geometry,
preset boxes constraining the taller axis. Port those to Vitest and the browser build has
the same safety net. Any implementation that reproduces **126.x x 177.x mm** on the
white-background reference scan and **85.6 x 54.0 mm** on the ID card is behaving.

## Deploy

```bash
cd web && npm install
npm run dev                # local, with cross-origin isolation headers
npm run build              # -> dist, ~16 KB plus CDN'd ORT
npm run deploy             # wrangler pages deploy dist --project-name cropsize
```

No Pages project exists yet; the first `npm run deploy` creates it.
