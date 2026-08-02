"""cropsize — local web app: upload a scan, crop/deskew it, place it on a page, export."""
from __future__ import annotations

import io
import time
import uuid

from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pipeline as P

app = FastAPI(title="cropsize")

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
SESSION_TTL_SECONDS = 60 * 60
DOCS: dict[str, dict] = {}          # doc_id -> {"pages": [ndarray], "metas": [PageMeta], ...}


def _reap() -> None:
    cutoff = time.time() - SESSION_TTL_SECONDS
    for doc_id in [k for k, v in DOCS.items() if v["ts"] < cutoff]:
        DOCS.pop(doc_id, None)


def _doc(doc_id: str, page: int) -> np.ndarray:
    entry = DOCS.get(doc_id)
    if not entry:
        raise HTTPException(404, "document expired or unknown — re-upload it")
    if not 0 <= page < len(entry["pages"]):
        raise HTTPException(404, f"page {page} out of range")
    entry["ts"] = time.time()
    return entry["pages"][page]


def _meta(doc_id: str, page: int) -> P.PageMeta:
    entry = DOCS.get(doc_id)
    if not entry:
        raise HTTPException(404, "document expired or unknown — re-upload it")
    return entry["metas"][page]


SAMPLE_SCAN = Path(__file__).resolve().parent / "fixtures" / "public" / "sample-scan.pdf"


def _store(data: bytes, filename: str) -> dict:
    try:
        pages, metas = P.load_pages(data, filename)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"could not read file: {exc}") from exc

    _reap()
    doc_id = uuid.uuid4().hex[:12]
    DOCS[doc_id] = {"pages": pages, "metas": metas, "name": filename, "ts": time.time()}
    return {
        "doc_id": doc_id,
        "name": filename,
        "pages": [
            {"index": i, "w": p.shape[1], "h": p.shape[0],
             "mm_per_px": m.mm_per_px, "source_dpi": m.source_dpi,
             "render_dpi": round(m.render_dpi), "scale_origin": m.origin,
             "page_mm": P.measured_mm(p, m)}
            for i, (p, m) in enumerate(zip(pages, metas))
        ],
    }


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file larger than 60 MB")
    return _store(data, file.filename or "upload")


@app.post("/api/sample")
def sample():
    """Load the bundled specimen scan, so the app can demonstrate itself."""
    if not SAMPLE_SCAN.exists():
        raise HTTPException(404, "sample scan is not installed")
    return _store(SAMPLE_SCAN.read_bytes(), SAMPLE_SCAN.name)


@app.get("/api/preview/{doc_id}/{page}")
def preview(doc_id: str, page: int, rot: int = 0, skew: float = 0.0,
            clahe: float = 0.0, stretch: int = 0, max_side: int = 1400):
    """The editor's working frame: orientation + deskew + tone already applied, so a
    crop box drawn on this image means the same thing at export time."""
    img = P.transform(_doc(doc_id, page), rot, skew, clahe, bool(stretch))
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s < 1.0:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    # JPEG for the live preview: a 300 dpi page is ~3 MB as PNG, which makes the skew
    # slider feel laggy. Exports always come from the full-resolution original.
    ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise HTTPException(500, "preview encode failed")
    return Response(enc.tobytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "no-store", "X-Full-Width": str(w), "X-Full-Height": str(h)})


class DetectReq(BaseModel):
    doc_id: str
    page: int = 0
    rot: int = 0
    engine: str = "auto"
    deskew: bool = True


@app.post("/api/detect")
def detect(req: DetectReq):
    base = P.rotate90(_doc(req.doc_id, req.page), req.rot)
    skew = P.estimate_skew(base) if req.deskew else 0.0
    det = P.detect(P.rotate_fine(base, skew), req.engine)
    return {"box": det.box, "skew": skew, "engine": det.engine, "note": det.note,
            "outline": det.outline}


class Rect(BaseModel):
    """Rotated rectangle in normalised coords against the rot90 frame."""
    cx: float
    cy: float
    w: float
    h: float
    angle: float = 0.0


class Page(BaseModel):
    page: int
    box: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 1.0)
    rot: int = 0
    skew: float = 0.0
    rect: Rect | None = None        # when set, overrides box+skew (multi-object path)
    outline: list | None = None     # traced document boundary, in the same frame


class ExportReq(BaseModel):
    doc_id: str
    pages: list[Page]
    format: str = "pdf"                 # pdf | png
    page_size: str = "a4"               # a4 | a3 | a5 | letter | legal | auto
    landscape: bool = False
    fit: str = "true"                   # true | real | fit | none
    target_width_mm: float | None = 125.0
    target_height_mm: float | None = None
    margin_mm: float = 8.0
    clahe: float = 0.0          # tone untouched unless the user asks for it
    stretch: bool = False
    out_dpi: float | None = None        # None = match the source, no resampling
    trim_outline: bool = True           # clear the corners the rectangle picked up


def _content(req: ExportReq, spec: "Page", tone: bool = True,
             max_side: int | None = None) -> np.ndarray:
    clahe = req.clahe if tone else 0.0
    stretch = req.stretch if tone else False
    if max_side:
        # Preview path: shrink before transforming. Deskew + CLAHE on a 35 MP page costs
        # seconds; on a 900 px proxy it is imperceptible, and crops are normalised so the
        # geometry is identical either way.
        src = _doc(req.doc_id, spec.page)
        sc = max_side / max(src.shape[:2])
        if sc < 1.0:
            small = cv2.resize(src, (max(1, int(src.shape[1] * sc)), max(1, int(src.shape[0] * sc))),
                               interpolation=cv2.INTER_AREA)
            base = P.transform(small, spec.rot, 0.0 if spec.rect else spec.skew, clahe, stretch)
            if spec.rect:
                r = spec.rect
                return P.crop_rotated_rect(base, P.rect_px(
                    P.Obj(r.cx, r.cy, r.w, r.h, r.angle), base.shape))
            return P.crop(base, spec.box)
    if spec.rect:
        # Object path: the rectangle carries its own rotation, so no global deskew.
        base = P.transform(_doc(req.doc_id, spec.page), spec.rot, 0.0, clahe, stretch)
        r = spec.rect
        rect = P.rect_px(P.Obj(r.cx, r.cy, r.w, r.h, r.angle), base.shape)
        content = P.crop_rotated_rect(base, rect)
        if req.trim_outline and spec.outline:
            (ccx, ccy), (rw, rh), ang = rect
            m = cv2.getRotationMatrix2D((ccx, ccy), ang, 1.0)
            m[0, 2] += round(rw) / 2 - ccx
            m[1, 2] += round(rh) / 2 - ccy
            bh, bw = base.shape[:2]
            content = P.trim_to_outline(content, spec.outline, lambda x, y: (
                m[0, 0] * x * bw + m[0, 1] * y * bh + m[0, 2],
                m[1, 0] * x * bw + m[1, 1] * y * bh + m[1, 2]))
        return content
    img = P.transform(_doc(req.doc_id, spec.page), spec.rot, spec.skew, clahe, stretch)
    content = P.crop(img, spec.box)
    if req.trim_outline and spec.outline:
        ih, iw = img.shape[:2]
        ox, oy = spec.box[0] * iw, spec.box[1] * ih
        content = P.trim_to_outline(content, spec.outline,
                                    lambda x, y: (x * iw - ox, y * ih - oy))
    return content


def _out_dpi(req: ExportReq) -> float:
    """Default to the source resolution so a 600 dpi scan exports at 600, not 300."""
    if req.out_dpi:
        return float(req.out_dpi)
    dpis = [_meta(req.doc_id, s.page).render_dpi for s in req.pages]
    return max(dpis) if dpis else P.RENDER_DPI


def _render(req: ExportReq) -> list[np.ndarray]:
    out, dpi = [], _out_dpi(req)
    for spec in req.pages:
        content = _content(req, spec)
        meta = _meta(req.doc_id, spec.page)
        fit, width_mm = req.fit, req.target_width_mm
        if fit == "true":
            # Scale straight from the scan: no preset, no assumption about the object.
            m = P.measured_mm(content, meta)
            if m:
                fit, width_mm = "real", m[0]
            else:
                fit = "none"        # source carries no scale; keep pixels as-is
        out.append(P.place_on_page(content, req.page_size, dpi, req.landscape,
                                   width_mm, req.margin_mm, fit, meta.mm_per_px,
                                   req.target_height_mm if req.fit == "real" else None))
    return out


class ObjectsReq(BaseModel):
    doc_id: str
    page: int = 0
    rot: int = 0
    engine: str = "auto"
    max_objects: int = 16


@app.post("/api/objects")
def objects(req: ObjectsReq):
    """Find every document-like item on the page — a flatbed of photos in one pass."""
    base = P.rotate90(_doc(req.doc_id, req.page), req.rot)
    groups, engine = P.find_object_groups(base, req.engine, req.max_objects)
    meta = _meta(req.doc_id, req.page)
    out = []
    for g in groups:
        prim = P.refine_obj(base, g[0])
        # No synthesised union here: on a document inside a sleeve every member mask is
        # already inflated by the sleeve, so merging pages compounds the error (two ~92 mm
        # pages make 186 mm against a true 176). Merging stays a deliberate user action.
        alts = [_obj_json(P.refine_obj(base, a), base, meta) for a in g[1:4]]
        j = _obj_json(prim, base, meta)
        j["alts"] = alts
        out.append(j)
    return {"engine": engine, "objects": out}


class MergeReq(BaseModel):
    doc_id: str
    page: int = 0
    rot: int = 0
    rects: list[Rect]


@app.post("/api/merge")
def merge(req: MergeReq):
    """Combine several selections into one — e.g. two facing pages into a spread."""
    if len(req.rects) < 2:
        raise HTTPException(400, "need at least two objects to merge")
    base = P.rotate90(_doc(req.doc_id, req.page), req.rot)
    objs = [P.Obj(r.cx, r.cy, r.w, r.h, r.angle) for r in req.rects]
    merged = P.refine_obj(base, P.merge_objects(objs, base.shape))
    return _obj_json(merged, base, _meta(req.doc_id, req.page))


class PointsReq(BaseModel):
    doc_id: str
    page: int = 0
    rot: int = 0
    points: list[tuple[float, float, int]]      # (x, y, 1=include | 0=exclude)


@app.post("/api/object_at")
def object_at(req: PointsReq):
    """Click-to-select one object; negative points carve parts back out."""
    from sam_backend import object_at as sam_object_at, sam_available
    if not sam_available():
        raise HTTPException(400, "click-to-select needs SAM — pip install -r requirements-sam.txt")
    if not req.points:
        raise HTTPException(400, "no points given")
    base = P.rotate90(_doc(req.doc_id, req.page), req.rot)
    obj = sam_object_at(base, req.points)
    if not obj:
        raise HTTPException(422, "nothing document-shaped found at that point")
    obj = P.refine_obj(base, obj)
    return _obj_json(obj, base, _meta(req.doc_id, req.page))


def _obj_json(o: P.Obj, base: np.ndarray, meta: P.PageMeta) -> dict:
    h, w = base.shape[:2]
    mm = None
    if meta and meta.mm_per_px:
        mm = [round(o.w * w * meta.mm_per_px, 1), round(o.h * h * meta.mm_per_px, 1)]
    # Corners come from OpenCV so the client never has to reason about angle sign.
    poly = [[float(x) / w, float(y) / h]
            for x, y in cv2.boxPoints(P.rect_px(o, base.shape))]
    return {"cx": o.cx, "cy": o.cy, "w": o.w, "h": o.h, "poly": poly,
            "angle": round(o.angle, 2), "score": round(o.score, 3), "mm": mm,
            "outline": o.outline, "alts": []}


@app.post("/api/measure")
def measure(req: ExportReq):
    """What the export will physically measure, without producing the file."""
    spec = req.pages[0]
    meta = _meta(req.doc_id, spec.page)
    content = _content(req, spec, tone=False)
    measured = P.measured_mm(content, meta)
    pages = _render(req)
    out_h, out_w = pages[0].shape[:2]

    # Physical size of the placed content, derived the same way the export does it.
    placed = None
    ch_px, cw_px = content.shape[:2]
    if req.fit == "true" and measured:
        placed = measured
    elif req.fit == "real" and req.target_width_mm:
        pw, ph = req.target_width_mm, req.target_width_mm * ch_px / cw_px
        if req.target_height_mm and ph > req.target_height_mm:
            ph, pw = req.target_height_mm, req.target_height_mm * cw_px / ch_px
        placed = [round(pw, 1), round(ph, 1)]
    elif req.fit == "none":
        placed = measured or P.mm_size(content, meta.render_dpi)
    return {
        "measured_mm": measured,
        "placed_mm": placed,
        "page_mm": P.mm_size(pages[0], _out_dpi(req)),
        "scale_origin": meta.origin,
        "source_dpi": meta.source_dpi,
        "render_dpi": round(meta.render_dpi),
        "out_dpi": round(_out_dpi(req)),
    }


@app.post("/api/page_preview")
def page_preview(req: ExportReq):
    """Render the composed output page itself, small — what you see is what exports."""
    if not req.pages:
        raise HTTPException(400, "no pages selected")
    spec = req.pages[0]
    meta = _meta(req.doc_id, spec.page)
    content = _content(req, spec, tone=True, max_side=1000)

    fit, width_mm = req.fit, req.target_width_mm
    height_mm = req.target_height_mm if req.fit == "real" else None
    if fit == "true":
        m = P.measured_mm(_content(req, spec, tone=False), meta)
        if m:
            fit, width_mm, height_mm = "real", m[0], None
        else:
            fit = "none"
    preview_dpi = 110.0            # ~910 px tall for A4: crisp on screen, cheap to make
    page = P.place_on_page(content, req.page_size, preview_dpi, req.landscape,
                           width_mm, req.margin_mm, fit, meta.mm_per_px, height_mm)
    ok, enc = cv2.imencode(".jpg", page, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise HTTPException(500, "preview encode failed")
    return Response(enc.tobytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.post("/api/export")
def export(req: ExportReq):
    if not req.pages:
        raise HTTPException(400, "no pages selected")
    pages = _render(req)
    if req.format == "png":
        return Response(P.to_png(pages[0]), media_type="image/png",
                        headers={"Content-Disposition": 'attachment; filename="cropsize.png"'})
    return Response(P.to_pdf(pages, _out_dpi(req)), media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="cropsize.pdf"'})


@app.get("/api/capabilities")
def capabilities():
    from sam_backend import MODEL_ID, sam_available
    return {
        "sam": sam_available(),
        "sam_model": MODEL_ID,
        "page_sizes": sorted(P.PAGE_SIZES_MM),
        "presets": P.CONTENT_PRESETS_MM,
        "default_dpi": P.RENDER_DPI,
        "dpi_bounds": [P.DPI_FLOOR, P.DPI_CEILING],
        "pixel_budget": P.PIXEL_BUDGET,
    }


@app.get("/")
def index():
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
