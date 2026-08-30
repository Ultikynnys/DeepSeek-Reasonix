import { performance } from "node:perf_hooks";
import { recordDiagnostic } from "../diagnostics.js";

interface PhaseMark {
  name: string;
  t: number;
}

const marks: PhaseMark[] = [];
let dumped = false;

export function isStartupProfileEnabled(): boolean {
  return true;
}

export function markPhase(name: string): void {
  const t = performance.now();
  const previous = marks.at(-1)?.t ?? 0;
  marks.push({ name, t });
  recordDiagnostic("startup.phase", {
    level: "info",
    durationMs: t - previous,
    details: { phase: name, cumulativeMs: Number(t.toFixed(3)) },
  });
}

export function dumpStartupProfile(stream: NodeJS.WriteStream = process.stderr): void {
  if (dumped || marks.length === 0) return;
  dumped = true;
  const totalMs = marks[marks.length - 1]!.t;
  recordDiagnostic("startup.complete", {
    level: "info",
    durationMs: totalMs,
    details: { phases: marks.length, lastPhase: marks.at(-1)?.name },
  });
  const widest = String(Math.round(totalMs)).length;
  const lines: string[] = ["[startup-profile]"];
  let prev = 0;
  for (const m of marks) {
    const cum = Math.round(m.t).toString().padStart(widest);
    const delta = Math.round(m.t - prev);
    lines.push(`  ${cum}ms  ${m.name.padEnd(28)}  (+${delta})`);
    prev = m.t;
  }
  lines.push(`─── ${Math.round(totalMs)}ms total · last phase ${marks[marks.length - 1]!.name}`);
  if (process.env.REASONIX_PROFILE_STARTUP === "1") stream.write(`${lines.join("\n")}\n`);
}

export function _resetForTests(): void {
  marks.length = 0;
  dumped = false;
}
