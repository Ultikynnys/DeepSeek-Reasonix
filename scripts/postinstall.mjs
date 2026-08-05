#!/usr/bin/env node
// No-op when run from the published tarball (no desktop/package.json shipped) —
// only the git checkout has workspace deps to install.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("desktop/package.json")) process.exit(0);

execSync("npm --prefix desktop ci --ignore-scripts", { stdio: "inherit" });
