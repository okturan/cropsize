#!/usr/bin/env node
/**
 * Publish the browser app to the existing cropsize Pages project.
 *
 * Cross-platform replacement for deploy-site.sh: a bash script cannot be launched from
 * npm or Explorer on Windows, and Node is guaranteed here anyway (web/build needs it).
 * shell:true lets spawnSync resolve npm / npm.cmd on every OS.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "web");
const r = spawnSync("npm", ["run", "deploy"], { stdio: "inherit", cwd: webDir, shell: true });
process.exit(r.status ?? 1);
