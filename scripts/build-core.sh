#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
crate_dir="$repo_dir/core/crates/imaging-core"
output_dir="../../../web/src/generated/imaging-core"

if command -v rustup >/dev/null 2>&1; then
  rustup_bin=$(command -v rustup)
  toolchain_bin=$(dirname "$("$rustup_bin" which rustc --toolchain stable)")
  PATH="$toolchain_bin:$PATH" RUSTUP_TOOLCHAIN=stable \
    exec wasm-pack build "$crate_dir" --target web --release --out-dir "$output_dir"
fi

if command -v brew >/dev/null 2>&1; then
  rustup_prefix=$(brew --prefix rustup 2>/dev/null || true)
  if [ -n "$rustup_prefix" ] && [ -x "$rustup_prefix/bin/rustup" ]; then
    toolchain_bin=$(dirname "$("$rustup_prefix/bin/rustup" which rustc --toolchain stable)")
    PATH="$toolchain_bin:$PATH" RUSTUP_TOOLCHAIN=stable \
      exec wasm-pack build "$crate_dir" --target web --release --out-dir "$output_dir"
  fi
fi

echo "rustup is required; install it and add wasm32-unknown-unknown" >&2
exit 1
