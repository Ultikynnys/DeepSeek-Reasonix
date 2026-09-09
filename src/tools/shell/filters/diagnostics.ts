import type { OutputFilterResult } from "../output-filter.js";

export function filterDiagnostics(
  raw: string,
  family: string,
  diagnostic: RegExp,
): OutputFilterResult {
  if (!raw.trim())
    return { commandFamily: family, mode: "passthrough", output: raw, omitted: false };
  const groups = new Map<string, string[]>();
  let matched = 0;
  for (const line of raw.split(/\r?\n/)) {
    const match = diagnostic.exec(line);
    if (!match) continue;
    matched++;
    const file = match[1] ?? "unknown";
    const item = `${match[2]}:${match[3]} ${match[5]} ${match[6]}`;
    const current = groups.get(file) ?? [];
    current.push(item);
    groups.set(file, current);
  }
  if (matched === 0) {
    return {
      commandFamily: family,
      mode: "degraded",
      output: raw,
      warning: `${family} diagnostics not recognized; raw output preserved`,
      omitted: false,
    };
  }
  const lines = [`${matched} ${family} diagnostic${matched === 1 ? "" : "s"}`];
  for (const [file, diagnostics] of groups) {
    lines.push(`${file}:`);
    for (const item of diagnostics) lines.push(`  ${item}`);
  }
  return { commandFamily: family, mode: "filtered", output: lines.join("\n"), omitted: true };
}
