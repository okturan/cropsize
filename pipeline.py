"""Imaging pipeline: load -> transform (rotate/deskew/tone) -> detect -> lay out on a page."""
from __future__ import annotations

import io
import math
from dataclasses import dataclass

import cv2
import fitz  # PyMuPDF
import numpy as np
from PIL import Image

RENDER_DPI = 300


# --------------------------------------------------------------------------- load

@dataclass
class PageMeta:
    """Physical scale of the working image, where it can be established.

    mm_per_px is what makes true-size output possible without the user telling us what
    the object is: a scanner writes the scanned area at 1:1 into PDF page space, so a
    crop's real-world size falls straight out of its pixel size. Note this holds at ANY
    render resolution — choosing the dpi affects fidelity and memory, never measurement.
    """
    mm_per_px: float | None = None
    source_dpi: float | None = None      # optical dpi of the scan itself
    render_dpi: float = RENDER_DPI       # what we actually rasterised at
    origin: str = "unknown"


# A PDF has no dpi of its own — only a page size in points and content drawn into it.
# These bound the resolution we pick from the embedded scan.
DPI_FLOOR = 120          # below this, downstream kernels have too little to bite on
DPI_CEILING = 900        # past this we are storing grain, not detail
PIXEL_BUDGET = 36_000_000    # ~A4 at 600 dpi; keeps a page near 100 MB in memory


def page_optical_dpi(page) -> float | None:
    """Effective resolution of the dominant embedded scan: pixels ÷ drawn inches."""
    try:
        infos = page.get_image_info()
    except Exception:  # noqa: BLE001 - metadata is best-effort
        return None
    if not infos:
        return None                       # vector/text page: no natural resolution
    big = max(infos, key=lambda i: i["width"] * i["height"])
    bbox = fitz.Rect(big["bbox"])
    if bbox.width < 1 or bbox.height < 1:
        return None
    dx = big["width"] / (bbox.width / 72)
    dy = big["height"] / (bbox.height / 72)
    return min(dx, dy)                    # the axis that limits real detail


def choose_render_dpi(page, default: int = RENDER_DPI) -> tuple[float, str]:
    """Rasterise at the scan's own resolution, not a fixed guess.

    Rendering a 600 dpi scan at 300 throws away half the detail the user gave us;
    rendering a 150 dpi scan at 300 doubles the work to invent nothing.
    """
    optical = page_optical_dpi(page)
    if optical is None:
        dpi, why = float(default), f"vector page, no embedded scan — rendering at {default} dpi"
    else:
        dpi = min(max(optical, DPI_FLOOR), DPI_CEILING)
        if abs(dpi - optical) < 1:
            why = f"matching embedded scan at {optical:.0f} dpi"
        else:
            why = f"embedded scan {optical:.0f} dpi, clamped to {dpi:.0f}"

    rect = page.rect
    area_in2 = max((rect.width / 72) * (rect.height / 72), 0.01)
    budget_dpi = math.sqrt(PIXEL_BUDGET / area_in2)
    if dpi > budget_dpi:
        dpi = budget_dpi
        why += f", capped to {dpi:.0f} by the {PIXEL_BUDGET // 1_000_000} MP budget"
    return dpi, why


def _pdf_page_meta(page, dpi: float, why: str) -> PageMeta:
    rect = page.rect
    page_mm = (rect.width / 72 * 25.4, rect.height / 72 * 25.4)
    optical = page_optical_dpi(page)
    note = f"PDF page geometry {page_mm[0]:.0f}×{page_mm[1]:.0f} mm — {why}"
    return PageMeta(25.4 / dpi, optical, dpi, note)


def _raster_meta(data: bytes) -> PageMeta:
    """PNG pHYs / JPEG EXIF resolution, when the scanner bothered to record it."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            d = im.info.get("dpi")
            unit = im.info.get("resolution_unit", 2)
            if d and float(d[0]) > 0:
                dpi = float(d[0])
                if unit == 3:                       # dots per cm
                    dpi *= 2.54
                if 30 <= dpi <= 4800:
                    return PageMeta(25.4 / dpi, dpi, dpi,
                                    f"image metadata: {dpi:.0f} dpi, used as-is")
    except Exception:  # noqa: BLE001
        pass
    # Raster pixels are never resampled on load, so there is nothing to choose here.
    return PageMeta(None, None, RENDER_DPI, "no dpi in file — real size can't be inferred")


def load_pages(data: bytes, filename: str,
               dpi: float | None = None) -> tuple[list[np.ndarray], list[PageMeta]]:
    """Return BGR images plus the physical scale of each.

    `dpi=None` picks each PDF page's resolution from its own embedded scan.
    """
    if filename.lower().endswith(".pdf"):
        doc = fitz.open(stream=data, filetype="pdf")
        imgs, metas = [], []
        for page in doc:
            if dpi is None:
                page_dpi, why = choose_render_dpi(page)
            else:
                page_dpi, why = float(dpi), f"forced to {dpi:.0f} dpi"
            pix = page.get_pixmap(dpi=int(round(page_dpi)))
            rgb = np.array(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
            imgs.append(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
            metas.append(_pdf_page_meta(page, page_dpi, why))
        return imgs, metas
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"could not decode {filename}")
    return [img], [_raster_meta(data)]


# ---------------------------------------------------------------------- transform

def rotate90(img: np.ndarray, quarter_turns: int) -> np.ndarray:
    k = quarter_turns % 4
    if k == 0:
        return img
    code = {1: cv2.ROTATE_90_CLOCKWISE, 2: cv2.ROTATE_180, 3: cv2.ROTATE_90_COUNTERCLOCKWISE}[k]
    return cv2.rotate(img, code)


def rotate_fine(img: np.ndarray, degrees: float, fill=(255, 255, 255)) -> np.ndarray:
    """In-plane rotation about the centre, canvas size preserved, white fill."""
    if abs(degrees) < 1e-3:
        return img
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=fill)


def estimate_skew(img: np.ndarray, limit: float = 5.0, step: float = 0.1) -> float:
    """Projection-profile deskew: pick the angle whose horizontal projection has the
    sharpest row-to-row transitions. Robust on text-bearing documents."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    scale = 800.0 / max(g.shape[1], 1)
    if scale < 1.0:
        g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    binary = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 31, 15)
    best_score, best_angle = -1.0, 0.0
    angle = -limit
    while angle <= limit + 1e-9:
        proj = rotate_fine(binary, angle, fill=0).sum(axis=1).astype(np.float64)
        score = float(((proj[1:] - proj[:-1]) ** 2).sum())
        if score > best_score:
            best_score, best_angle = score, angle
        angle += step
    return round(best_angle, 2)


def apply_tone(img: np.ndarray, clahe_clip: float = 1.2, stretch: bool = True) -> np.ndarray:
    """Luminance-only contrast plus a single shared RGB stretch.

    The stretch is deliberately NOT per-channel: an independent per-channel stretch
    shifts hue, which is wrong for documents where colour is evidence (stamps, inks).
    """
    out = img
    if clahe_clip > 0:
        lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8)).apply(l)
        out = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)
    if stretch:
        f = out.astype(np.float32)
        lo, hi = np.percentile(f, 1), np.percentile(f, 99.5)
        f = (f - lo) * 255.0 / max(hi - lo, 1.0)
        out = np.clip(f, 0, 255).astype(np.uint8)
    return out


def transform(img: np.ndarray, quarter_turns: int = 0, skew: float = 0.0,
              clahe_clip: float = 0.0, stretch: bool = False) -> np.ndarray:
    """Canonical order: 90° orientation -> fine deskew -> tone. The editor previews
    this exact frame, so crop boxes are always expressed against it."""
    out = rotate90(img, quarter_turns)
    out = rotate_fine(out, skew)
    if clahe_clip > 0 or stretch:
        out = apply_tone(out, clahe_clip, stretch)
    return out


# ----------------------------------------------------------------------- detection

@dataclass
class Detection:
    box: tuple[float, float, float, float]  # normalised x0, y0, x1, y1
    engine: str
    note: str = ""
    outline: list | None = None


def _norm(box, w, h):
    x0, y0, x1, y1 = box
    return (max(0.0, x0 / w), max(0.0, y0 / h), min(1.0, x1 / w), min(1.0, y1 / h))


def detect_classic(img: np.ndarray) -> Detection:
    """Fallback detector for the common case: one document on a plain background.

    Works on a saturation+gradient energy map rather than raw intensity, because a
    near-white page on a near-white background has no usable intensity step. Falls
    back to a small inset if nothing separates from the background.
    """
    h, w = img.shape[:2]
    small = cv2.resize(img, (min(w, 1200), int(h * min(w, 1200) / w)), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape[:2]
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    energy = np.abs(cv2.Sobel(cv2.GaussianBlur(g, (5, 5), 0), cv2.CV_32F, 1, 0)) + \
             np.abs(cv2.Sobel(cv2.GaussianBlur(g, (5, 5), 0), cv2.CV_32F, 0, 1))
    energy = cv2.blur(energy, (31, 31))
    sat = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32)
    score = cv2.normalize(energy, None, 0, 255, cv2.NORM_MINMAX) + \
            cv2.normalize(cv2.blur(sat, (31, 31)), None, 0, 255, cv2.NORM_MINMAX)

    mask = (score > np.percentile(score, 55)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((35, 35), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n > 1:
        i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        x, y, cw, ch = stats[i, :4]
        if cw * ch > 0.15 * sw * sh:
            pad = int(0.004 * max(sw, sh))
            box = _norm((x - pad, y - pad, x + cw + pad, y + ch + pad), sw, sh)
            return Detection(snap_edges(img, box), "classic", "gradient mask + edge snap")
    return Detection(snap_edges(img, (0.02, 0.02, 0.98, 0.98)), "classic",
                     "no region found; edge snap from full frame")


def snap_edges(img: np.ndarray, box: tuple[float, float, float, float],
               reach: float = 0.06, prominence: float = 4.0) -> tuple:
    """Pull each side of `box` onto the strongest straight edge near it.

    A document boundary is a long straight step, so it dominates the summed gradient
    profile perpendicular to that side — in testing the true page edge scored ~20x the
    local median. Sides whose best candidate is not that distinct are left alone, which
    is the honest outcome when the boundary genuinely has no contrast.
    """
    h, w = img.shape[:2]
    g = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    gx = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))

    x0, y0, x1, y1 = box
    px0, py0, px1, py1 = int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)
    # profile each axis over the middle half of the opposite axis, avoiding corners
    cols = gx[py0 + (py1 - py0) // 4: py1 - (py1 - py0) // 4].mean(axis=0)
    rows = gy[:, px0 + (px1 - px0) // 4: px1 - (px1 - px0) // 4].mean(axis=1)

    def best(profile, centre, span, sign):
        """Strongest peak in an asymmetric window: generous outward, tight inward.

        The asymmetry matters. Printing inside the document (an MRZ line, a ruled
        table) often outscores the paper edge itself, so a symmetric argmax walks
        inward and clips content. Searching mostly outward biases toward the true
        boundary; the window stops it reaching the scanner lid or a holder edge.
        """
        out_span, in_span = int(span), int(span * 0.2)
        lo = max(0, centre - (out_span if sign < 0 else in_span))
        hi = min(len(profile), centre + (in_span if sign < 0 else out_span))
        seg = profile[lo:hi]
        if len(seg) < 5:
            return None
        med = float(np.median(profile)) or 1.0
        i = int(np.argmax(seg))
        return lo + i if seg[i] > med * prominence else None

    span_x, span_y = int(w * reach), int(h * reach)
    nx0 = best(cols, px0, span_x, -1)
    nx1 = best(cols, px1, span_x, +1)
    ny0 = best(rows, py0, span_y, -1)
    ny1 = best(rows, py1, span_y, +1)
    out = (nx0 if nx0 is not None else px0, ny0 if ny0 is not None else py0,
           nx1 if nx1 is not None else px1, ny1 if ny1 is not None else py1)
    if out[2] - out[0] < w * 0.2 or out[3] - out[1] < h * 0.2:
        return box
    return _norm(out, w, h)


def detect(img: np.ndarray, engine: str = "auto") -> Detection:
    """engine: 'auto' (SAM if available, else classic), 'sam', or 'classic'."""
    if engine in ("auto", "sam"):
        from sam_backend import sam_available, detect_sam
        if sam_available():
            try:
                return detect_sam(img)
            except Exception as exc:  # noqa: BLE001 - never fail the request on SAM
                if engine == "sam":
                    return Detection(detect_classic(img).box, "classic",
                                     f"SAM failed ({exc}); used classic")
        elif engine == "sam":
            return Detection(detect_classic(img).box, "classic",
                             "SAM 2 not installed; used classic")
    return detect_classic(img)


# --------------------------------------------------------------- multiple objects

@dataclass
class Obj:
    """One detected item on the bed, as a rotated rectangle in normalised coords.

    Each object carries its OWN angle. A global deskew is wrong the moment there is
    more than one thing on the platen — four photos land at four different angles — and
    for photographs there is no text to run a projection profile on anyway, so the
    rectangle fitted to the mask is the only rotation signal available.
    """
    cx: float
    cy: float
    w: float
    h: float
    angle: float
    score: float = 0.0
    outline: list | None = None      # normalised mask contour, for trimming the corners


def _normalise_rect(rect) -> tuple:
    """Fold minAreaRect's angle into [-45, 45] so crops come out the right way up."""
    (cx, cy), (w, h), ang = rect
    while ang < -45:
        ang, w, h = ang + 90, h, w
    while ang > 45:
        ang, w, h = ang - 90, h, w
    return (cx, cy), (w, h), ang


def rect_px(obj: Obj, shape) -> tuple:
    h, w = shape[:2]
    return (obj.cx * w, obj.cy * h), (obj.w * w, obj.h * h), obj.angle


def crop_rotated_rect(img: np.ndarray, rect) -> np.ndarray:
    """Extract a rotated rectangle, straightened, in one resample."""
    (cx, cy), (rw, rh), ang = rect
    rw, rh = max(1, int(round(rw))), max(1, int(round(rh)))
    m = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    m[0, 2] += rw / 2 - cx
    m[1, 2] += rh / 2 - cy
    return cv2.warpAffine(img, m, (rw, rh), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))


def mask_to_obj(mask: np.ndarray, shape, score: float = 0.0) -> Obj | None:
    """Fit a rotated rectangle to a mask and reject anything not document-shaped."""
    h, w = shape[:2]
    m = (mask.astype(np.uint8) * 255)
    if m.shape[:2] != (h, w):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
    raw_cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    area = cv2.contourArea(c)
    (cx, cy), (rw, rh), ang = _normalise_rect(cv2.minAreaRect(c))
    if rw < 8 or rh < 8:
        return None
    frac = area / float(w * h)
    if not 0.015 < frac < 0.92:                       # slivers, and the whole platen
        return None
    if area / (rw * rh) < 0.82:                       # not rectangular enough to be a page
        return None
    ar = rw / rh
    if not 0.12 < ar < 8.0:
        return None
    # Keep the traced contour, not just the rectangle. A document has rounded corners, so
    # the min-area rect necessarily squares them off and drags in whatever sits outside
    # the rounding — background, or the sleeve the document is in.
    # Trace the corners off the unclosed mask; the closing above squares them off.
    traced = max(raw_cnts, key=cv2.contourArea) if raw_cnts else c
    eps = 0.0002 * cv2.arcLength(traced, True)
    simple = cv2.approxPolyDP(traced, eps, True).reshape(-1, 2)
    outline = [[float(x) / w, float(y) / h] for x, y in simple]
    return Obj(cx / w, cy / h, rw / w, rh / h, float(ang), float(score), outline)


def refine_obj(img: np.ndarray, o: Obj, pad_frac: float = 0.06) -> Obj:
    """Snap an object's sides to the real edges, in its own straightened frame.

    SAM decides *which* object; it is not precise about *where* it ends — masks are
    computed at 256x256 and upsampled, so the boundary is good to a few millimetres at
    300 dpi. Straightening the object first means the same axis-aligned edge snap used
    on the single-crop path applies to a rotated object too.
    """
    h, w = img.shape[:2]
    (cx, cy), (rw, rh), ang = rect_px(o, img.shape)
    pad = max(8.0, max(rw, rh) * pad_frac)
    crop = crop_rotated_rect(img, ((cx, cy), (rw + 2 * pad, rh + 2 * pad), ang))
    ch, cw = crop.shape[:2]
    if cw < 20 or ch < 20:
        return o

    snapped = snap_edges(crop, (pad / cw, pad / ch, (pad + rw) / cw, (pad + rh) / ch),
                         reach=0.05, prominence=5.0)
    x0, y0, x1, y1 = (snapped[0] * cw, snapped[1] * ch, snapped[2] * cw, snapped[3] * ch)
    new_w, new_h = x1 - x0, y1 - y0
    if new_w < rw * 0.5 or new_h < rh * 0.5:      # snapped onto interior print — keep SAM's
        return o

    # Move the centre by the snap offset, rotated back out of the straightened frame.
    dx, dy = (x0 + x1) / 2 - cw / 2, (y0 + y1) / 2 - ch / 2
    a = math.radians(ang)
    al, be = math.cos(a), math.sin(a)
    return Obj((cx + al * dx - be * dy) / w, (cy + be * dx + al * dy) / h,
               new_w / w, new_h / h, ang, o.score, o.outline)


def group_objects(objs: list[Obj], iou_thresh: float = 0.45,
                  containment_thresh: float = 0.75) -> list[list[Obj]]:
    """Group overlapping candidates; the first of each group is the default pick.

    Overlapping candidates are not noise to be thrown away — on a passport in a plastic
    sleeve SAM offers the sleeve (130.5 x 185.5 mm, score 0.969) and each page
    (127.1 x 92.1, 0.966) but never the spread, because the spread is a semantic grouping
    rather than a visual object. Which one is "the document" is genuinely the user's call,
    so the alternatives are kept and offered instead of silently resolved.
    """
    groups: list[list[Obj]] = []
    for o in sorted(objs, key=lambda x: (-x.score, -(x.w * x.h))):
        for g in groups:
            # Containment as well as IoU: a page inside its sleeve scores only ~0.44 IoU,
            # so on IoU alone the two never group and the sleeve silently wins.
            if _iou(o, g[0]) > iou_thresh or _containment(o, g[0]) > containment_thresh:
                g.append(o)
                break
        else:
            groups.append([o])
    return groups


def dedupe_objects(objs: list[Obj], iou_thresh: float = 0.45) -> list[Obj]:
    return [g[0] for g in group_objects(objs, iou_thresh)]


def merge_objects(objs: list[Obj], shape) -> Obj:
    """Union of several rotated rects — how two facing pages become one spread."""
    pts = []
    for o in objs:
        pts.extend(cv2.boxPoints(rect_px(o, shape)))
    (cx, cy), (w, h), ang = _normalise_rect(cv2.minAreaRect(np.array(pts, dtype=np.float32)))
    H, W = shape[:2]
    return Obj(cx / W, cy / H, w / W, h / H, float(ang),
               min(o.score for o in objs))


def _bounds(o: Obj):
    return o.cx - o.w / 2, o.cy - o.h / 2, o.cx + o.w / 2, o.cy + o.h / 2


def _containment(a: Obj, b: Obj) -> float:
    """Intersection over the smaller area — ~1.0 when one sits inside the other."""
    ax0, ay0, ax1, ay1 = _bounds(a)
    bx0, by0, bx1, by1 = _bounds(b)
    ix = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0.0, min(ay1, by1) - max(ay0, by0))
    smaller = min(a.w * a.h, b.w * b.h)
    return (ix * iy) / smaller if smaller > 0 else 0.0


def _iou(a: Obj, b: Obj) -> float:
    ax0, ay0, ax1, ay1 = a.cx - a.w / 2, a.cy - a.h / 2, a.cx + a.w / 2, a.cy + a.h / 2
    bx0, by0, bx1, by1 = b.cx - b.w / 2, b.cy - b.h / 2, b.cx + b.w / 2, b.cy + b.h / 2
    ix, iy = max(0.0, min(ax1, bx1) - max(ax0, bx0)), max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = ix * iy
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def find_objects_classic(img: np.ndarray, max_objects: int = 16) -> list[Obj]:
    """Fallback multi-object finder: closed edge contours, filtered for rectangularity.

    Deliberately conservative. Items sitting close together on the platen merge into one
    contour, and a merged blob fails the rectangularity test and is dropped rather than
    returned as a bogus object — one right answer beats three wrong ones. Reliable
    multi-object separation needs SAM.
    """
    small = cv2.resize(img, (1024, int(img.shape[0] * 1024 / img.shape[1])),
                       interpolation=cv2.INTER_AREA) if img.shape[1] > 1024 else img
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    e = cv2.Canny(cv2.GaussianBlur(g, (5, 5), 0), 30, 90)
    e = cv2.dilate(e, np.ones((3, 3), np.uint8), iterations=2)
    e = cv2.morphologyEx(e, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    cnts, _ = cv2.findContours(e, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    objs = []
    for c in cnts:
        if cv2.contourArea(c) < 0.015 * g.size:
            continue
        filled = np.zeros(g.shape, np.uint8)
        cv2.drawContours(filled, [cv2.convexHull(c)], -1, 255, -1)
        o = mask_to_obj(filled > 0, small.shape, 0.0)
        if o:
            objs.append(o)
    return dedupe_objects(objs)[:max_objects]


def find_object_groups(img: np.ndarray, engine: str = "auto",
                       max_objects: int = 16) -> tuple[list[list[Obj]], str]:
    """Each group is one item plus the overlapping alternatives SAM also proposed."""
    if engine in ("auto", "sam"):
        from sam_backend import sam_available, auto_object_groups
        if sam_available():
            try:
                groups = auto_object_groups(img, max_objects)
                if groups:
                    return groups, "sam"
            except Exception:  # noqa: BLE001
                pass
    return [[o] for o in find_objects_classic(img, max_objects)], "classic"


def find_objects(img: np.ndarray, engine: str = "auto", max_objects: int = 16) -> tuple[list[Obj], str]:
    groups, engine = find_object_groups(img, engine, max_objects)
    return [g[0] for g in groups], engine


# -------------------------------------------------------------------------- layout

PAGE_SIZES_MM = {
    "a3": (297.0, 420.0),
    "a4": (210.0, 297.0),
    "a5": (148.0, 210.0),
    "letter": (215.9, 279.4),
    "legal": (215.9, 355.6),
}

# width x height of the *content*, for real-size presets
CONTENT_PRESETS_MM = {
    "passport_spread": (125.0, 176.0),   # ICAO ID-3 open spread
    "passport_page": (125.0, 88.0),      # ICAO ID-3 single page
    "id_card": (85.6, 54.0),             # ID-1 (also bank cards, most driving licences)
    "a4_content": (210.0, 297.0),
}


def crop(img: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    x0, x1 = sorted((int(round(x0 * w)), int(round(x1 * w))))
    y0, y1 = sorted((int(round(y0 * h)), int(round(y1 * h))))
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, max(x1, x0 + 1)), min(h, max(y1, y0 + 1))
    return img[y0:y1, x0:x1]


def place_on_page(content: np.ndarray, page: str = "a4", dpi: float = RENDER_DPI,
                  landscape: bool = False, target_width_mm: float | None = None,
                  margin_mm: float = 0.0, fit: str = "real",
                  src_mm_per_px: float | None = None,
                  target_height_mm: float | None = None) -> np.ndarray:
    """Compose the cropped content onto a white page.

    `dpi` is the OUTPUT resolution of the page raster; `src_mm_per_px` is the physical
    scale of `content`. Keeping the two separate is what lets a 600 dpi scan stay 600 dpi
    on export while a 150 dpi one is not pointlessly upsampled.

    fit='real'  -> scale so content is exactly `target_width_mm` wide (true size)
    fit='fit'   -> scale to fill the page minus margins, preserving aspect
    fit='none'  -> preserve the content's own physical size
    """
    if page == "auto":
        m = int(round(margin_mm / 25.4 * dpi))
        return cv2.copyMakeBorder(content, m, m, m, m, cv2.BORDER_CONSTANT, value=(255, 255, 255))

    pw_mm, ph_mm = PAGE_SIZES_MM[page]
    if landscape:
        pw_mm, ph_mm = ph_mm, pw_mm
    pw = int(round(pw_mm / 25.4 * dpi))
    ph = int(round(ph_mm / 25.4 * dpi))

    ch, cw = content.shape[:2]
    if fit == "real" and target_width_mm:
        # With a height too, fit inside that box. Scaling preserves aspect, so a single
        # dimension makes presets that share a width (an ID-3 page and an ID-3 spread are
        # both 125 mm wide) behave identically — the height is what tells them apart.
        new_w = max(1, int(round(target_width_mm / 25.4 * dpi)))
        new_h = max(1, int(round(ch * new_w / cw)))
        if target_height_mm:
            box_h = max(1, int(round(target_height_mm / 25.4 * dpi)))
            if new_h > box_h:
                new_h, new_w = box_h, max(1, int(round(cw * box_h / ch)))
    elif fit == "none" and src_mm_per_px:
        new_w = max(1, int(round(cw * src_mm_per_px / 25.4 * dpi)))
        new_h = max(1, int(round(ch * src_mm_per_px / 25.4 * dpi)))
    elif fit == "fit":
        avail_w = pw - 2 * int(round(margin_mm / 25.4 * dpi))
        avail_h = ph - 2 * int(round(margin_mm / 25.4 * dpi))
        s = min(avail_w / cw, avail_h / ch)
        new_w, new_h = max(1, int(cw * s)), max(1, int(ch * s))
    else:
        new_w, new_h = cw, ch

    if (new_w, new_h) != (cw, ch):
        interp = cv2.INTER_AREA if new_w < cw else cv2.INTER_CUBIC
        content = cv2.resize(content, (new_w, new_h), interpolation=interp)

    # Content larger than the page is scaled down rather than clipped.
    if new_w > pw or new_h > ph:
        s = min(pw / new_w, ph / new_h)
        new_w, new_h = max(1, int(new_w * s)), max(1, int(new_h * s))
        content = cv2.resize(content, (new_w, new_h), interpolation=cv2.INTER_AREA)

    page_img = np.full((ph, pw, 3), 255, np.uint8)
    ox, oy = (pw - new_w) // 2, (ph - new_h) // 2
    page_img[oy:oy + new_h, ox:ox + new_w] = content
    return page_img


def to_pdf(pages: list[np.ndarray], dpi: float = RENDER_DPI) -> bytes:
    imgs = [Image.fromarray(cv2.cvtColor(p, cv2.COLOR_BGR2RGB)) for p in pages]
    buf = io.BytesIO()
    imgs[0].save(buf, "PDF", resolution=float(dpi), save_all=True, append_images=imgs[1:])
    return buf.getvalue()


def to_png(img: np.ndarray) -> bytes:
    ok, enc = cv2.imencode(".png", img)
    if not ok:
        raise ValueError("PNG encode failed")
    return enc.tobytes()


def mm_size(img: np.ndarray, dpi: float = RENDER_DPI) -> tuple[float, float]:
    h, w = img.shape[:2]
    return round(w / dpi * 25.4, 1), round(h / dpi * 25.4, 1)


def measured_mm(img: np.ndarray, meta: PageMeta) -> tuple[float, float] | None:
    """True physical size of `img`, or None when the source carries no scale."""
    if not meta or not meta.mm_per_px:
        return None
    h, w = img.shape[:2]
    return round(w * meta.mm_per_px, 1), round(h * meta.mm_per_px, 1)


def trim_to_outline(content: np.ndarray, outline, mapper, feather: int = 2) -> np.ndarray:
    """White out everything outside the traced document boundary.

    This is what puts the rounded corners back: the crop is still a rectangle, but the
    corner areas that the rectangle picked up beyond the document's rounding are cleared.
    `mapper` converts a normalised source point into content pixel coordinates.
    """
    if not outline or len(outline) < 3:
        return content
    pts = np.array([mapper(x, y) for x, y in outline], dtype=np.float32)
    mask = np.zeros(content.shape[:2], np.uint8)
    cv2.fillPoly(mask, [np.round(pts).astype(np.int32)], 255)
    if not mask.any():
        return content
    if feather > 0:
        mask = cv2.GaussianBlur(mask, (feather * 2 + 1,) * 2, 0)
    a = (mask.astype(np.float32) / 255.0)[..., None]
    return np.clip(content * a + 255 * (1 - a), 0, 255).astype(np.uint8)
