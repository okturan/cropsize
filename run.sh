#!/usr/bin/env bash
# Unix wrapper around run.py, which is the real launcher and works on Windows too.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 run.py "$@"
