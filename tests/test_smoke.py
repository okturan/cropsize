"""End-to-end smoke tests that need no model weights.

Everything here runs on the classic-CV path so CI stays free of the ~1 GB torch install.
The properties under test are the ones that would silently ruin output: physical scale,
resolution handling, and page geometry.
"""
import io
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pipeline as P  # noqa: E402


def make_pdf(dpi: int, card_mm=(85.6, 54.0), page_mm=(150.0, 120.0)) -> bytes:
    """A synthetic 'scan': a card of known physical size on a known page, at a given dpi."""
    px = lambda mm: max(1, int(round(mm / 25.4 * dpi)))
    page = np.full((px(page_mm[1]), px(page_mm[0]), 3), 244, np.uint8)
    cw, ch = px(card_mm[0]), px(card_mm[1])
    card = np.full((ch, cw, 3), 250, np.uint8)
    cv2.rectangle(card, (0, 0), (cw - 1, ch - 1), (90, 90, 90), max(1, dpi // 150))
    y, x = px(20.0), px(30.0)
    page[y:y + ch, x:x + cw] = card
    buf = io.BytesIO()
    Image.fromarray(cv2.cvtColor(page, cv2.COLOR_BGR2RGB)).save(
        buf, "PDF", resolution=float(dpi))
    return buf.getvalue()


@pytest.mark.parametrize("dpi", [150, 300, 600])
def test_render_dpi_follows_the_scan(dpi):
    """A PDF has no dpi of its own — we must adopt the embedded scan's resolution."""
    imgs, metas = P.load_pages(make_pdf(dpi), "scan.pdf")
    assert metas[0].render_dpi == pytest.approx(dpi, abs=1)
    assert imgs[0].shape[1] == pytest.approx(150.0 / 25.4 * dpi, rel=0.02)


def test_dpi_is_clamped_by_the_pixel_budget():
    _, metas = P.load_pages(make_pdf(1200), "scan.pdf")
    assert metas[0].render_dpi <= P.DPI_CEILING
    assert metas[0].source_dpi == pytest.approx(1200, rel=0.02)


@pytest.mark.parametrize("dpi", [150, 300, 600])
def test_measurement_is_resolution_invariant(dpi):
    """Physical size must not depend on how finely we rasterised."""
    imgs, metas = P.load_pages(make_pdf(dpi), "scan.pdf")
    w_mm, h_mm = P.measured_mm(imgs[0], metas[0])
    assert w_mm == pytest.approx(150.0, abs=1.0)
    assert h_mm == pytest.approx(120.0, abs=1.0)


def test_true_size_survives_a_crop():
    imgs, metas = P.load_pages(make_pdf(300), "scan.pdf")
    half = P.crop(imgs[0], (0.0, 0.0, 0.5, 1.0))
    w_mm, _ = P.measured_mm(half, metas[0])
    assert w_mm == pytest.approx(75.0, abs=1.0)


def test_page_layout_is_exact():
    imgs, metas = P.load_pages(make_pdf(300), "scan.pdf")
    content = P.crop(imgs[0], (0.1, 0.1, 0.6, 0.6))
    page = P.place_on_page(content, "a4", 300, False, 125.0, 8.0, "real", metas[0].mm_per_px)
    assert P.mm_size(page, 300) == pytest.approx((210.0, 297.0), abs=0.5)


def test_preset_box_limits_the_taller_axis():
    """Two presets sharing a width must not behave identically: the height separates them."""
    content = np.zeros((1000, 500, 3), np.uint8)          # 2:1 portrait, dark so it counts
    wide = P.place_on_page(content, "a4", 300, False, 125.0, 0, "real", None, None)
    boxed = P.place_on_page(content, "a4", 300, False, 125.0, 0, "real", None, 88.0)
    assert boxed.shape == wide.shape                      # same sheet either way
    # Width alone would place both identically; the height cap must shrink the boxed one.
    assert np.count_nonzero(boxed.max(axis=2) < 250) < np.count_nonzero(wide.max(axis=2) < 250)


def test_rotation_is_lossless_and_reversible():
    img = np.random.randint(0, 255, (40, 60, 3), dtype=np.uint8)
    assert np.array_equal(P.rotate90(P.rotate90(img, 1), 3), img)


def test_skew_estimate_recovers_a_known_angle():
    page = np.full((900, 700, 3), 255, np.uint8)
    for y in range(120, 800, 40):                          # text-like ruled lines
        cv2.line(page, (80, y), (620, y), (20, 20, 20), 6)
    tilted = P.rotate_fine(page, -2.0)
    assert P.estimate_skew(tilted) == pytest.approx(2.0, abs=0.3)


def test_trim_to_outline_clears_outside_the_shape():
    content = np.zeros((100, 100, 3), np.uint8)
    square = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]
    out = P.trim_to_outline(content, square, lambda x, y: (x * 100, y * 100), feather=0)
    assert out[50, 50].tolist() == [0, 0, 0]               # inside survives
    assert out[5, 5].tolist() == [255, 255, 255]           # outside cleared


def test_classic_detector_returns_a_sane_box():
    imgs, _ = P.load_pages(make_pdf(300), "scan.pdf")
    det = P.detect_classic(imgs[0])
    x0, y0, x1, y1 = det.box
    assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
    assert (x1 - x0) * (y1 - y0) > 0.05


def test_export_produces_a_readable_pdf():
    imgs, metas = P.load_pages(make_pdf(300), "scan.pdf")
    page = P.place_on_page(P.crop(imgs[0], (0.1, 0.1, 0.9, 0.9)), "a4", 300,
                           False, 125.0, 8.0, "real", metas[0].mm_per_px)
    data = P.to_pdf([page, page], 300)
    assert data.startswith(b"%PDF")
    import fitz
    doc = fitz.open(stream=data, filetype="pdf")
    assert doc.page_count == 2
    assert doc[0].rect.width / 72 * 25.4 == pytest.approx(210.0, abs=0.5)


def test_shared_sam_predictor_calls_are_serialized():
    """A second request must not replace the image used by an in-flight prediction."""
    import concurrent.futures
    import threading
    import time

    import sam_backend

    for name in ("detect_sam", "auto_object_groups", "object_at"):
        assert hasattr(getattr(sam_backend, name), "__wrapped__")

    active = 0
    peak = 0
    state_lock = threading.Lock()

    @sam_backend._serialized_predictor
    def predictor_transaction():
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.03)
        with state_lock:
            active -= 1

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: predictor_transaction(), range(2)))

    assert peak == 1
