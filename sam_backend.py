"""Segment Anything 2 backend.

Kept behind lazy imports so the app runs with zero ML dependencies. Enable with:

    pip install -r requirements-sam.txt

Weights come from Hugging Face on first use — there is no checkpoint file to fetch by
hand. Pick a size with CROPBOX_SAM_MODEL:

    facebook/sam2.1-hiera-tiny         39M params, smallest download
    facebook/sam2.1-hiera-small        46M
    facebook/sam2.1-hiera-base-plus    81M  (default)
    facebook/sam2.1-hiera-large       224M

Why a segmenter at all: the hard case for classic CV is a near-white document on a
near-white background — a passport inside a plastic sleeve, a receipt on a white desk.
There is no intensity step to threshold or flood against, and edge detectors lock onto the
printing instead of the paper boundary. SAM segments by learned objectness, so it does not
need that contrast.

Why SAM 2 rather than the original: measured on this project's two reference scans against
a true 125.0 x 176.0 mm passport spread, SAM 1 (vit_b) gave 125.9 x 177.2 and
128.0 x 180.7; SAM 2.1 (base_plus) gave 126.4 x 177.0 and 127.1 x 175.5. Equivalent on the
easy scan, ~4 mm better on the one inside a sleeve, fewer parameters, and faster once warm.
"""
from __future__ import annotations

import functools
import os
import threading

import cv2
import numpy as np

MODEL_ID = os.environ.get("CROPBOX_SAM_MODEL", "facebook/sam2.1-hiera-base-plus")
_PREDICTOR_LOCK = threading.Lock()


def _serialized_predictor(fn):
    """Keep set_image() and every dependent predict() on one request at a time."""
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        with _PREDICTOR_LOCK:
            return fn(*args, **kwargs)
    return wrapped


def sam_available() -> bool:
    try:
        import sam2  # noqa: F401
        import torch  # noqa: F401
        import huggingface_hub  # noqa: F401
    except ImportError:
        return False
    return True


@functools.lru_cache(maxsize=1)
def _predictor():
    import torch
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    device = "cuda" if torch.cuda.is_available() else (
        "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()
        else "cpu")
    # from_pretrained defaults to cuda and raises outright on a CPU/MPS-only torch build.
    return SAM2ImagePredictor.from_pretrained(MODEL_ID, device=device), device


def model_label() -> str:
    return MODEL_ID.rsplit("/", 1)[-1]


def _downscale(img: np.ndarray, side: int = 1024):
    """SAM works at 1024 px internally; shrink first to keep inference bearable."""
    h, w = img.shape[:2]
    s = side / max(h, w)
    if s >= 1.0:
        return img, 1.0
    return cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA), s


# Corner fidelity. Traced from the *unclosed* mask with CHAIN_APPROX_NONE: a 25x25 square
# closing squares off the very arcs we are trying to keep, and CHAIN_APPROX_SIMPLE then
# collapses each arc to the chord across it. On a passport corner that chain took the
# outline from 4730 raw points down to 19 — three segments where there should be an arc.
OUTLINE_EPS = 0.0002        # ~292 points, max 0.19 mm from the traced boundary


def _contour_outline(mask: np.ndarray, sw: int, sh: int):
    """Trace the mask boundary, kept so rounded corners survive the rectangle fit."""
    m = (mask.astype(np.uint8) * 255)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return None
    big = max(cnts, key=cv2.contourArea)
    eps = OUTLINE_EPS * cv2.arcLength(big, True)
    return [[float(x) / sw, float(y) / sh]
            for x, y in cv2.approxPolyDP(big, eps, True).reshape(-1, 2)]


@_serialized_predictor
def auto_object_groups(img: np.ndarray, max_objects: int = 16, grid: int = 8,
                       min_score: float = 0.80):
    """Find every document-like item on the platen without any clicks.

    Prompts on a point grid and keeps whatever looks like a document, then groups
    overlapping proposals so alternatives can be offered rather than silently resolved.

    Every grid point is probed. An earlier version skipped points falling inside an
    already-accepted object, which is fatal here: a passport sits *inside* its sleeve, so
    accepting the sleeve first suppressed every probe that would have found the pages. The
    image encoder runs once, so each extra point is only a decoder pass.
    """
    from pipeline import group_objects, mask_to_obj

    predictor, _ = _predictor()
    small, _ = _downscale(img)
    sh, sw = small.shape[:2]
    predictor.set_image(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))

    objs = []
    step = 1.0 / grid
    for iy in range(grid):
        for ix in range(grid):
            gx, gy = (ix + 0.5) * step, (iy + 0.5) * step
            coords = np.array([[gx * sw, gy * sh]], dtype=np.float32)
            labels = np.array([1], dtype=np.int32)
            masks, scores, _ = predictor.predict(point_coords=coords, point_labels=labels,
                                                 multimask_output=True)
            for mask, score in zip(masks, scores):
                if score < min_score:
                    continue
                o = mask_to_obj(mask, small.shape, float(score))
                if o:
                    objs.append(o)     # keep every plausible one; grouping decides later
    return group_objects(objs)[:max_objects]


def auto_objects(img: np.ndarray, max_objects: int = 16, **kw):
    return [g[0] for g in auto_object_groups(img, max_objects, **kw)]


@_serialized_predictor
def object_at(img: np.ndarray, points: list[tuple[float, float, int]]):
    """Click-to-select: positive points include, negative points carve away."""
    from pipeline import mask_to_obj

    predictor, _ = _predictor()
    small, _ = _downscale(img)
    sh, sw = small.shape[:2]
    predictor.set_image(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))

    coords = np.array([[p[0] * sw, p[1] * sh] for p in points], dtype=np.float32)
    labels = np.array([p[2] for p in points], dtype=np.int32)
    masks, scores, _ = predictor.predict(point_coords=coords, point_labels=labels,
                                         multimask_output=True)
    best, best_score = None, -1.0
    for mask, score in zip(masks, scores):
        o = mask_to_obj(mask, small.shape, float(score))
        if o and score > best_score:
            best, best_score = o, float(score)
    if best is None:                                   # fall back to SAM's own pick
        i = int(np.argmax(scores))
        best = mask_to_obj(masks[i], small.shape, float(scores[i]))
    return best


@_serialized_predictor
def detect_sam(img: np.ndarray):
    """Box-prompt at a generous inset and return the best mask's bounds plus outline."""
    from pipeline import Detection, snap_edges

    predictor, device = _predictor()
    small, _ = _downscale(img)
    sh, sw = small.shape[:2]

    predictor.set_image(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))

    def pick(masks, scores, hi):
        best, best_score = None, -1.0
        for mask, score in zip(masks, scores):
            frac = float(mask.mean())
            if not 0.05 < frac < hi:        # reject slivers and whole-frame masks
                continue
            if score > best_score:
                best, best_score = mask, float(score)
        return best, best_score

    # SAM 2 takes a bare XYXY box, where SAM 1 wanted shape (1, 4).
    inset = np.array([sw * 0.04, sh * 0.04, sw * 0.96, sh * 0.96], dtype=np.float32)
    masks, scores, _ = predictor.predict(box=inset, multimask_output=True)
    best, best_score = pick(masks, scores, 0.97)

    # A box prompt spanning most of the frame says "the thing inside this box", which on a
    # small document sitting on a big platen is the platen. When the answer comes back
    # covering nearly everything, ask again with a single centre point instead.
    if best is None or float(best.mean()) > 0.85:
        pmasks, pscores, _ = predictor.predict(
            point_coords=np.array([[sw / 2, sh / 2]], dtype=np.float32),
            point_labels=np.array([1], dtype=np.int32), multimask_output=True)
        alt, alt_score = pick(pmasks, pscores, 0.85)
        if alt is not None:
            best, best_score = alt, alt_score
    if best is None:
        i = int(np.argmax(scores))
        best, best_score = masks[i], float(scores[i])

    m = cv2.morphologyEx((best.astype(np.uint8) * 255), cv2.MORPH_CLOSE,
                         np.ones((25, 25), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats((m > 0).astype(np.uint8), 8)
    if n > 1:
        i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        x, y, cw, ch = stats[i, :4]
    else:
        ys, xs = np.where(m > 0)
        x, y, cw, ch = xs.min(), ys.min(), xs.ptp() + 1, ys.ptp() + 1

    # Outline from the raw mask, bounds from the closed one: closing is there to make the
    # bounding box robust, and it is exactly what damages the corners.
    outline = _contour_outline(best, sw, sh)
    box = (x / sw, y / sh, (x + cw) / sw, (y + ch) / sh)
    # The mask lands within a millimetre or two; snap the sides to the nearest strong
    # straight edge at full resolution, since inference ran on a 1024 px downscale.
    box = snap_edges(img, box, reach=0.025, prominence=6.0)

    det = Detection(box, "sam", f"{model_label()} on {device}, score {best_score:.3f}")
    det.outline = outline
    return det
