#!/usr/bin/env bash
# Publish the landing page. The screenshots live in docs/ so the README can use them, and
# get copied into site/ at deploy time rather than being committed twice.
set -euo pipefail
cd "$(dirname "$0")"
cp docs/editor.png docs/output.png site/
exec npx wrangler pages deploy site --project-name cropsize --branch main --commit-dirty=true
