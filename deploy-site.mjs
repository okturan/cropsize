#!/usr/bin/env node
/**
 * Publish the browser app to the existing cropsize Pages project.
 *
 * Cross-platform replacement for deploy-site.sh: a bash script cannot be launched from
 * npm or Explorer on Windows, and Node is guaranteed here anyway (web/build needs it).
 * shell:true lets spawnSync resolve npm / npm.cmd on every OS.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "web");

// Wrangler lets a CLOUDFLARE_API_TOKEN in the environment override its own login, and a
// shell-wide token made for some other account has no rights on this Pages project. When
// a wrangler login exists, deploy with that and leave the token out of the child's env.
const env = { ...process.env };
if (existsSync(join(homedir(), ".wrangler", "config", "default.toml"))) {
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
}
const r = spawnSync("npm", ["run", "deploy"], { stdio: "inherit", cwd: webDir, shell: true, env });
process.exit(r.status ?? 1);
