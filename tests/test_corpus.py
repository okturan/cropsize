"""Golden corpus shared with the browser and Rust suites.

The public rows always run. Private identity-document rows run when their ignored local links
exist. SAM-backed assertions are opt-in so ordinary CI remains free of model weights.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pipeline as P  # noqa: E402


CORPUS = json.loads((ROOT / "fixtures" / "corpus.json").read_text())
ROWS = CORPUS["fixtures"]


def fixture_path(row: dict) -> Path | None:
    local = ROOT / "fixtures" / row["file"]
    if local.exists():
        return local
    private_dir = os.environ.get("CROPSIZE_PRIVATE_FIXTURES_DIR")
    if row["visibility"] == "private" and private_dir:
        supplied = Path(private_dir) / row["source_name"]
        if supplied.exists():
            return supplied
    return None


def available_path(row: dict) -> Path:
    path = fixture_path(row)
    if path is None:
        pytest.skip(f"private fixture {row['id']} is not installed")
    return path


def load_reference(row: dict):
    path = available_path(row)
    images, metas = P.load_pages(path.read_bytes(), path.name, dpi=CORPUS["render_dpi"])
    return images[0], metas[0]


@pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
def test_fixture_hash_is_the_recorded_scan(row):
    data = available_path(row).read_bytes()
    assert hashlib.sha256(data).hexdigest() == row["sha256"]


@pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
def test_fixture_skew_matches_contract(row):
    image, _ = load_reference(row)
    assert P.estimate_skew(image) == pytest.approx(
        row["expected"]["skew_degrees"], abs=row["tolerance"]["skew_degrees"])


@pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
def test_python_sam_matches_corpus(row):
    if os.environ.get("CROPSIZE_RUN_MODEL_FIXTURES") != "1":
        pytest.skip("set CROPSIZE_RUN_MODEL_FIXTURES=1 to run model-backed corpus rows")
    path = fixture_path(row)
    assert path is not None, f"private fixture {row['id']} is not installed"

    import sam_backend

    assert sam_backend.sam_available(), "SAM dependencies are required for model fixtures"
    assert sam_backend.MODEL_ID == CORPUS["model"]
    image, meta = load_reference(row)
    skew = P.estimate_skew(image)
    straight = P.rotate_fine(image, skew)
    detected = sam_backend.detect_sam(straight)

    expected = row["expected"]
    tolerance = row["tolerance"]
    page_w, page_h = row["page_mm"]
    for i, (actual, wanted) in enumerate(zip(detected.box, expected["box"])):
        axis_mm = page_w if i % 2 == 0 else page_h
        assert abs(actual - wanted) * axis_mm <= tolerance["box_mm"]

    cropped = P.crop(straight, detected.box)
    measured = P.measured_mm(cropped, meta)
    assert measured is not None
    assert measured == pytest.approx(expected["measured_mm"], abs=tolerance["measured_mm"])

    ih, iw = straight.shape[:2]
    ox, oy = detected.box[0] * iw, detected.box[1] * ih
    trimmed = P.trim_to_outline(
        cropped,
        detected.outline,
        lambda x, y: (x * iw - ox, y * ih - oy),
    )
    changed_fraction = float(np.any(trimmed != cropped, axis=2).mean())
    assert changed_fraction == pytest.approx(
        expected["trim_changed_fraction"], abs=tolerance["trim_changed_fraction"])
    assert changed_fraction < row["limits"]["trim_changed_fraction"]
