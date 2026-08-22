#!/usr/bin/env node
// Pre-push gate. Skips the full verify chain when the push contains no
// code: pure branch deletions, and docs-only pushes (README*, docs/,
// any *.md) — matching the release workflow's `paths-ignore` policy.
// Everything else runs `npm run verify` exactly as before. Fail-open:
// any uncertainty about what changed runs the full verify.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ZERO_OID = "0".repeat(40);
const stdin = readFileSync(0, "utf8");
const hasContentPush = stdin
  .split("\n")
  .filter(Boolean)
  .some((line) => {
    const [, localOid] = line.split(/\s+/);
    return localOid !== undefined && localOid !== ZERO_OID;
  });

// Pure branch deletions (all-zero local oids) need no verification.
if (!hasContentPush) {
  console.log("branch deletion — skipping npm run verify");
  process.exit(0);
}

const files = changedFiles();
if (files !== null && files.length > 0 && files.every(isDocsPath)) {
  console.log("docs-only push — skipping npm run verify");
  process.exit(0);
}
// Windows has no bare `npm` executable — run through the shell so npm.cmd resolves.
execFileSync("npm", ["run", "verify"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

/** Local-only files vs origin/main, or null when the state is unknown. */
function changedFiles() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const base = execFileSync(
      "git",
      ["merge-base", "HEAD", "origin/main"],
      { encoding: "utf8" },
    ).trim();
    if (!base) return null;
    return execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function isDocsPath(p) {
  return /\.md$/i.test(p) || p.startsWith("docs/");
}
