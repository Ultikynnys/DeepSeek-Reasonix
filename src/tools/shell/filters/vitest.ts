import type { OutputFilterResult } from "../output-filter.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function filterVitest(raw: string): OutputFilterResult {
  const clean = raw.replace(ANSI, "");
  const summary = clean.match(/^\s*Tests\s+(.+)$/m);
  if (!summary) {
    return {
      commandFamily: "vitest",
      mode: "degraded",
      output: raw,
      warning: "Vitest summary not recognized; raw output preserved",
      omitted: false,
    };
  }
  const failedBlocks: string[] = [];
  const lines = clean.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*(?:FAIL|×|❯)\s/.test(line)) {
      if (current) failedBlocks.push(current.join("\n"));
      current = [line.trimEnd()];
      continue;
    }
    if (current && (/^\s+/.test(line) || line.trim() === "")) {
      current.push(line.trimEnd());
      continue;
    }
    if (current) {
      failedBlocks.push(current.join("\n"));
      current = null;
    }
  }
  if (current) failedBlocks.push(current.join("\n"));
  const skipped = clean.match(/^\s*(?:Test Files|Tests).*skipped.*$/gm) ?? [];
  const body = [...failedBlocks.slice(0, 10), `Tests ${summary[1]!.trim()}`, ...skipped]
    .join("\n")
    .trim();
  if (!body || body.length >= clean.trim().length) {
    return { commandFamily: "vitest", mode: "passthrough", output: raw, omitted: false };
  }
  return { commandFamily: "vitest", mode: "filtered", output: body, omitted: true };
}
