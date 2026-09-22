#!/usr/bin/env node
/**
 * Build the Rust imaging core to WebAssembly, on any platform.
 *
 * Replaces build-core.sh: npm runs scripts through cmd.exe on Windows, which cannot
 * execute a POSIX shell script, so `npm run build`, `npm test` and `npm run deploy`
 * all failed outright on Windows. Node is already required by the web build, so the
 * launcher is Node.
 *
 * Mirrors the shell version's one trick: when rustup manages the toolchain, put the
 * stable toolchain's bin directory first on PATH and pin RUSTUP_TOOLCHAIN=stable, so
 * wasm-pack picks a predictable compiler even with several toolchains installed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(repoDir, "core", "crates", "imaging-core");
const outDir = resolve(repoDir, "web", "src", "generated", "imaging-core");

function run(cmd, args, env) {
  // shell:false everywhere; spawnSync resolves .exe on Windows by itself.
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.error) throw r.error;
  return r.status === 0;
}

/** Path to the stable toolchain's bin dir, or null when rustup is not in charge. */
function stableToolchainBin() {
  const probe = spawnSync("rustup", ["which", "rustc", "--toolchain", "stable"], {
    encoding: "utf8",
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  const rustc = probe.stdout.trim().split(/\r?\n/).pop();
  return rustc && existsSync(rustc) ? dirname(rustc) : null;
}

const env = { ...process.env };
const toolchainBin = stableToolchainBin();
if (toolchainBin) {
  env.PATH = toolchainBin + delimiter + (env.PATH ?? "");
  env.RUSTUP_TOOLCHAIN = "stable";
} else {
  env.RUSTUP_TOOLCHAIN = env.RUSTUP_TOOLCHAIN ?? "stable";
}

mkdirSync(outDir, { recursive: true });
const ok = run(
  "wasm-pack",
  ["build", crateDir, "--target", "web", "--release", "--out-dir", outDir],
  env,
);
if (!ok) {
  console.error(
    "wasm-pack build failed. Install Rust with rustup and add the"
    + " wasm32-unknown-unknown target: rustup target add wasm32-unknown-unknown",
  );
  process.exit(1);
}
