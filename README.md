# scanfit

Local web app for cleaning up document scans: upload a PDF or image, detect the document
boundary, straighten it, and place it on a real page at true physical size.

Built for the case that defeats most crop tools — a **near-white document on a near-white
background**, like a passport inside a plastic sleeve. There is no intensity step to
threshold, so contour and flood-fill detectors either grab the printing inside the page or
run away to the scanner lid. SAM handles it because it segments by learned objectness
rather than contrast.

## Run

```bash
./run.sh                      # creates .venv, installs deps, serves on :8077
```

Open <http://localhost:8077>. Nothing is uploaded anywhere — the server is local and
documents are held in memory only, dropped an hour after last use.

### Enable SAM 2 (recommended)

Without it the app falls back to a classic-CV detector that is, honestly, mediocre on
low-contrast boundaries (see *Detection quality* below).

```bash
./.venv/bin/pip install -r requirements-sam.txt
```

That is the whole setup — weights are pulled from Hugging Face on first use, with no
checkpoint file to fetch by hand. Pick a size with `SCANFIT_SAM_MODEL`:

| Model | Params | Notes |
|---|---|---|
| `facebook/sam2.1-hiera-tiny` | 39M | smallest download, best browser-port candidate |
| `facebook/sam2.1-hiera-small` | 46M | |
| `facebook/sam2.1-hiera-base-plus` | 81M | **default** |
| `facebook/sam2.1-hiera-large` | 224M | |

The header badge shows which engine and size is live.

#### Why SAM 2, measured

Against a true 125.0 x 176.0 mm passport spread, box-prompted:

| Scan | SAM 1 (vit_b, 91M) | SAM 2.1 (base_plus, 81M) |
|---|---|---|
| reference A — passport on white | 125.9 x 177.2 | 126.4 x 177.0 |
| reference B — passport in a sleeve | 128.0 x 180.7 | **127.1 x 175.5** |

Equivalent on the easy scan and ~4 mm better on the hard one, with fewer parameters and
faster warm inference (0.70 s vs 1.34 s). A full object sweep of a flatbed dropped from
~3.7 s to ~1.9 s. SAM 1 support was removed rather than kept alongside.

Two SAM 1 quirks disappeared with it: `SamAutomaticMaskGenerator` built its point grid as
float64, which Metal refuses outright, and box prompts wanted shape `(1, 4)` where SAM 2
takes a bare `(4,)`.

## What it does

**Detect** — SAM box-prompted at a 4% inset, best mask that is neither a sliver nor the
whole frame, then the sides snapped to the nearest strong straight edge at full resolution
(SAM itself runs on a 1024 px downscale, so this recovers the last pixels).

**Deskew** — projection-profile search, ±5° in 0.1° steps, picking the angle whose
horizontal projection has the sharpest row-to-row transitions. Rotation only, no
perspective warp: flatbed scans have no keystoning to correct, and warping one would
distort the document for no reason.

**Tone** — **off by default**: the export is the scan as it came, and contrast is there for
when you want legibility rather than fidelity. When enabled it is CLAHE on the L\* channel
plus a *single shared* RGB stretch — deliberately not a per-channel stretch, which shifts
hue, and on documents colour is evidence: stamp inks, security print, paper tint.

**Scale** — the app infers the real-world size of what you cropped, rather than asking you
to know it. A scanner writes the scanned area into PDF page space at 1:1, so a crop's
physical size falls straight out of its pixel size and the page geometry. For raster files
the same comes from PNG `pHYs` / JPEG EXIF resolution, when present.

On a test passport scan this derives 126.1 × 177.0 mm with no preset selected, against a
real ICAO ID-3 spread of 125 × 176 mm — the ~1 mm is SAM's slightly generous crop, not the
scale. The panel shows the measured size next to the requested one, so a large gap tells
you the *crop* is wrong.

**Resolution** — a PDF has no dpi of its own: it has a page size in points and content
drawn into it. The real number is `embedded_pixels ÷ drawn_inches`, so each page is
rasterised at *its own* scan resolution rather than a fixed guess. Rendering a 600 dpi scan
at 300 throws away half of what you were given; rendering a 150 dpi scan at 300 doubles the
work to invent nothing. Bounds: 120–900 dpi, with a 36 MP ceiling per page.
Export defaults to matching the source, overridable to 150/300/600.

Measured across the same content written at four resolutions, the physical measurement is
invariant — 150 dpi, 300, 600 and 1200 (clamped to 900) all yield the same object size to
within 0.4 mm. Resolution affects fidelity and memory, never measurement.

**Size on the page** — three choices, and the UI states what each will actually do rather
than naming a preset:

- **Keep real size** — default. The label reads back the measured size, e.g. *"print it at
  126.1 x 177.0 mm, as measured"*.
- **Scale to a known size** — force an exact width (passport spread 125 x 176, passport
  page 125 x 88, ID-1 card 85.6 x 54, or custom). If the forced width differs from the
  measured one by more than 1.5 mm the panel says so, because that gap means the *crop* is
  wrong, not the preset.
- **Fill the sheet** — as large as the margins allow, explicitly not to scale.

**Output preview** — the right rail renders the actual composed sheet, server-side, at
110 dpi. It is the same code path as the export, so it is not an approximation: change the
paper size and you watch the item stay the same physical size while the sheet around it
changes.

## Detection quality — what to expect

Measured against hand-measured ground truth on two passport-in-holder scans:

| Engine | Result |
|---|---|
| SAM 2.1 (base_plus) + edge snap | within ~1–2 mm on all four sides, well under 1 s per page warm on Apple Silicon MPS |
| Classic CV | gets skew right; the box is a rough starting point and often includes the holder |

Known ranking weakness: groups are ordered by SAM's own confidence, which is not always
the tightest boundary. On the synthetic flatbed one item defaults to 92.7 x 109.7 mm while
its *first alternative* is 78.5 x 109.7 — the correct one, one ⇄ click away. Ranking
candidates by how well their edges are supported in the image would likely fix this.

The classic path is a fallback, not a peer. On these scans I tried Canny + contour quad
(locks onto the guilloche printing), flood-fill from the borders (leaks straight into the
page — paper and sleeve are both near-white), and a local-variance texture threshold (the
holder's fabric stitching has as much variance as the security print). A parameter sweep of
the surviving gradient heuristic gave unstable answers across the two files, which is why
the app ships with a manual editor rather than pretending the box is always right.

**The crop box is always editable.** Auto-detect is a starting point.

- **Crop tool** (`C`) — drag the box to move, a handle to resize, double-click to reset.
- **Pan tool** (`H`), hold space, or middle-drag — drag to move the view.
- Zoom with the `−` / `+` / Fit / 100% buttons or ⌘/Ctrl + scroll, anchored on the cursor.
  Zoom scales the canvas backing store, so zooming in sharpens rather than blurs.

## Layout

```
app.py            FastAPI routes: upload, preview, detect, measure, export
pipeline.py       imaging — load, transform, skew, tone, detect (classic), page layout
sam_backend.py    optional SAM 2 detector, lazily imported so torch stays optional
static/           editor UI (vanilla JS canvas, no build step)
```

The transform order is fixed at `rotate90 → deskew → tone`, and the editor previews exactly
that frame, so a crop box in normalised coordinates means the same thing in the preview and
at export. Change the order in one place and both follow.

## API

Usable headlessly:

```bash
ID=$(curl -s -F "file=@scan.pdf" localhost:8077/api/upload | jq -r .doc_id)
curl -s -X POST localhost:8077/api/detect -H 'Content-Type: application/json' \
  -d "{\"doc_id\":\"$ID\",\"page\":0,\"engine\":\"sam\"}"
curl -s -X POST localhost:8077/api/export -H 'Content-Type: application/json' \
  -d "{\"doc_id\":\"$ID\",\"pages\":[{\"page\":0,\"box\":[0.07,0.04,0.96,0.95],\"skew\":-1.4}],
       \"page_size\":\"a4\",\"fit\":\"real\",\"target_width_mm\":125}" -o out.pdf
```

## Known limits

- Rotation is 90° steps plus fine deskew. There is no perspective/keystone correction, so
  phone photos taken at an angle will not be squared up.
- Multi-page PDFs: pages are selectable and each keeps its own crop, but export currently
  emits the page you have open.
- SAM 2 on CPU is slow. MPS or CUDA is much better.
- In-memory sessions — restarting the server drops uploads.

## Tests

```bash
./.venv/bin/pip install pytest
./.venv/bin/pytest tests/ -q
```

They run on the classic-CV path with synthetic PDFs, so no model weights or torch are
needed — which is also what CI runs. The properties covered are the ones that would ruin
output silently: render dpi following the embedded scan, measurement staying invariant
across resolutions, physical size surviving a crop, exact page geometry, preset boxes
constraining the taller axis, lossless rotation, skew recovery, and outline trimming.

## Licence

All rights reserved — see `LICENSE`. Note that PyMuPDF, currently used for PDF rendering,
is AGPL-3.0-or-commercial; swapping it for pypdfium2 would remove that constraint before
any hosted or distributed use.
