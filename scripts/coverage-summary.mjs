import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/a/…" which
// path.join turns into "\D:\a\…" and fs then resolves against the current
// drive as "D:\D:\a\…" (ENOENT). fileURLToPath returns a proper "D:\a\…".
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUMMARY_PATH = join(ROOT, "coverage", "coverage-summary.json");

const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
if (!GITHUB_STEP_SUMMARY) {
  console.log("Not running in GitHub Actions (no GITHUB_STEP_SUMMARY). Skipping.");
  process.exit(0);
}

let data;
try {
  data = JSON.parse(readFileSync(SUMMARY_PATH, "utf-8"));
} catch (err) {
  console.error("Failed to read coverage summary:", err.message);
  process.exit(0); // don't fail the build if coverage report is missing
}

const { total } = data;
if (!total) {
  console.error("No 'total' key in coverage summary. Skipping.");
  process.exit(0);
}

const pct = (metric) => {
  const m = total[metric];
  if (!m) return "-";
  return `${m.pct.toFixed(1)}%`;
};

const rows = [
  "| Metric | Coverage |",
  "| ------ | -------- |",
  `| Statements | ${pct("statements")} |`,
  `| Branches   | ${pct("branches")}   |`,
  `| Functions  | ${pct("functions")}  |`,
  `| Lines      | ${pct("lines")}      |`,
];

const md = `## Coverage\n\n${rows.join("\n")}\n`;
appendFileSync(GITHUB_STEP_SUMMARY, md + "\n");
console.log("Coverage summary written to job summary.");
