#!/usr/bin/env bash
# Publish the browser app to the existing cropsize Pages project.
set -euo pipefail
cd "$(dirname "$0")/web"
exec npm run deploy
