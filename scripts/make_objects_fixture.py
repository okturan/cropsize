#!/usr/bin/env python3
"""Generate the public three-item flatbed contract used by objects-mode tests."""
from __future__ import annotations

import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DPI = 150
PAGE_MM = (220.0, 180.0)


def px(mm: float) -> int:
    return round(mm / 25.4 * DPI)


def document(
    page: np.ndarray,
    center_mm: tuple[float, float],
    size_mm: tuple[float, float],
    angle: float,
    colour: tuple[int, int, int],
    label: str,
) -> None:
    center = (px(center_mm[0]), px(center_mm[1]))
    size = (px(size_mm[0]), px(size_mm[1]))
    rect = (center, size, angle)
    corners = np.round(cv2.boxPoints(rect)).astype(np.int32)
    cv2.fillConvexPoly(page, corners, colour)
    cv2.polylines(page, [corners], True, (35, 35, 35), max(2, DPI // 60), cv2.LINE_AA)

    # Content gives the segmenter document-like structure without changing the outer metric.
    overlay = np.zeros_like(page)
    mask = np.zeros(page.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, corners, 255)
    cv2.putText(
        overlay, label, (center[0] - size[0] // 4, center[1]),
        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (45, 45, 45), 2, cv2.LINE_AA,
    )
    for offset in (-size[1] // 5, size[1] // 5):
        cv2.line(
            overlay,
            (center[0] - size[0] // 4, center[1] + offset),
            (center[0] + size[0] // 4, center[1] + offset),
            (70, 70, 70), 2, cv2.LINE_AA,
        )
    page[mask > 0] = np.minimum(page[mask > 0], np.where(overlay[mask > 0] > 0,
                                                        overlay[mask > 0], 255))


def main() -> None:
    page = np.full((px(PAGE_MM[1]), px(PAGE_MM[0]), 3), 232, np.uint8)
    document(page, (52, 46), (85.6, 54), -7, (205, 224, 246), "ID")
    document(page, (164, 48), (58, 78), 10, (226, 205, 235), "PHOTO")
    document(page, (126, 136), (72, 50), 3, (211, 240, 211), "NOTE")
    output = ROOT / "fixtures" / "public" / "objects-flatbed.pdf"
    buffer = io.BytesIO()
    Image.fromarray(cv2.cvtColor(page, cv2.COLOR_BGR2RGB)).save(
        buffer, "PDF", resolution=float(DPI), quality=95,
    )
    output.write_bytes(buffer.getvalue())
    print(output)


if __name__ == "__main__":
    main()
