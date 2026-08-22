#!/usr/bin/env node
// Docs-only pushes skip the full verify chain, matching the release
// workflow's `paths-ignore` policy (README*, docs/, any *.md). Everything
// else still runs `npm run verify` exactly as before. Fail-open: any
// uncertainty about what changed runs the full verify.
import { execFileSync } from "node:child_process";

const files = changedFiles();
if (files !== null && files.length > 0 && files.every(isDocsPath)) {
  console.log("docs-only push — skipping npm run verify");
  process.exit(0);
}
execFileSync("npm", ["run", "verify"], { stdio: "inherit" });

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
