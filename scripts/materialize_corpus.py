#!/usr/bin/env python3
"""Render the PDF corpus into deterministic grayscale images for non-PDF test suites."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pipeline as P  # noqa: E402


def source_path(row: dict) -> Path | None:
    local = ROOT / "fixtures" / row["file"]
    if local.exists():
        return local
    supplied = os.environ.get("CROPSIZE_PRIVATE_FIXTURES_DIR")
    if row["visibility"] == "private" and supplied:
        candidate = Path(supplied) / row["source_name"]
        if candidate.exists():
            return candidate
    return None


def main() -> int:
    manifest = json.loads((ROOT / "fixtures" / "corpus.json").read_text())
    missing: list[str] = []
    for row in manifest["fixtures"]:
        source = source_path(row)
        if source is None:
            missing.append(row["id"])
            continue
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != row["sha256"]:
            raise SystemExit(f"{row['id']}: source hash {digest} does not match corpus.json")

        images, _ = P.load_pages(data, source.name, dpi=manifest["render_dpi"])
        grey = cv2.cvtColor(images[0], cv2.COLOR_BGR2GRAY)
        output = ROOT / "fixtures" / row["raster_file"]
        output.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(output), grey, [cv2.IMWRITE_PNG_COMPRESSION, 9]):
            raise SystemExit(f"could not write {output}")
        print(f"{row['id']}: {output.relative_to(ROOT)} ({grey.shape[1]}x{grey.shape[0]})")

    if missing:
        print("not installed: " + ", ".join(missing))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
