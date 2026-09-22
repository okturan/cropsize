"""Cross-platform launcher for the local app.

The old quick start assumed bash and a Unix venv layout: `./run.sh`, `.venv/bin/pip`.
None of that exists on Windows, where venvs live in `.venv\\Scripts` and npm-style
`python3` is called `py`. This script does the same job with whatever interpreter
started it, on macOS, Linux and Windows alike:

    python run.py        # or: py run.py

It creates .venv if missing, installs requirements into it, then serves the app on
http://localhost:8077 (override with PORT).
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"


def venv_python() -> Path:
    name = "python.exe" if os.name == "nt" else "python"
    return VENV / ("Scripts" if os.name == "nt" else "bin") / name


def main() -> int:
    if not VENV.exists():
        print("creating .venv ...")
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)])
    py = venv_python()
    if not py.exists():
        print(f".venv exists but {py} is missing; delete .venv and run this again.",
              file=sys.stderr)
        return 1

    subprocess.check_call(
        [str(py), "-m", "pip", "install", "-q",
         "-r", str(ROOT / "requirements.txt")])

    # The segmentation model is optional; point at it rather than failing quietly later.
    has_sam = subprocess.run(
        [str(py), "-c", "import sam2"], capture_output=True).returncode == 0
    if not has_sam:
        print("segmentation model not installed; detection falls back to classic CV.")
        pip = py.relative_to(ROOT)
        print(f"to enable it: {pip} -m pip install -r requirements-sam.txt")

    port = os.environ.get("PORT", "8077")
    print(f"serving on http://localhost:{port}")
    return subprocess.call([
        str(py), "-m", "uvicorn", "app:app",
        "--reload", "--port", port,
    ])


if __name__ == "__main__":
    raise SystemExit(main())
