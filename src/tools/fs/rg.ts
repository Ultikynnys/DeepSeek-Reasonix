// Ripgrep delegation for search_content — upstream's default "auto" engine.
// Honors .gitignore, scans far faster than the JS walker, and RE2 regex can't
// backtrack catastrophically. Missing/misbehaving rg → native fallback; the
// tool description advertises which engine is active so it's never silent.

import { spawn, spawnSync } from "node:child_process";

/** Output line cap before the child is killed — mirrors upstream's 200-match cap. */
const MAX_OUTPUT_LINES = 200;
/** Same metachar test filesystem.ts uses to split glob-vs-substring filters. */
export const GLOB_METACHARS = /[*?{[]/;
/** Display-truncation for long lines, matching the native scanner's 200-char cut. */
const MAX_LINE_CHARS = 200;

let probe: boolean | null = null;
let probeOverride: boolean | null = null;

/** Cached probe: is ripgrep on PATH? (Once per process; test override supported.) */
export function ripgrepAvailable(): boolean {
  if (probeOverride !== null) return probeOverride;
  if (probe !== null) return probe;
  try {
    const r = spawnSync("rg", ["--version"], { stdio: "ignore", windowsHide: true });
    probe = !r.error && r.status === 0;
  } catch {
    probe = false;
  }
  return probe;
}

/** Test-only: pin ripgrep availability (null = re-probe on next call). */
export function __setRipgrepForTesting(available: boolean | null): void {
  probeOverride = available;
}

export type RipgrepStop = "cap" | "timeout" | "abort" | null;

export interface RipgrepRun {
  /** True when rg produced output (or cleanly found nothing); false → fall back to native. */
  used: boolean;
  /** Raw rg lines ("rel:line:text", or "rel:count" in summary mode). */
  lines: string[];
  stop: RipgrepStop;
}

export interface RipgrepOptions {
  /** Child cwd; also the base for path-relative output. */
  rootDir: string;
  /** Search root relative to rootDir, posix separators. */
  startRel: string;
  pattern: string;
  caseSensitive?: boolean;
  context?: number;
  /** Metachar glob passed straight to rg; substring filters are post-filtered by the caller. */
  glob?: string | null;
  /** Negated gitignore-style globs mirroring the native skip list (one per SKIP_DIR_NAMES). */
  excludeGlobs?: string[];
  includeDeps?: boolean;
  summaryOnly?: boolean;
  /** Kill the child after this many ms and return partial results. */
  deadlineMs: number;
  signal?: AbortSignal;
}

/** Pure arg builder — unit-tested without needing rg installed. */
export function rgArgs(o: RipgrepOptions): string[] {
  const args = ["--no-heading", "--color", "never", "--no-messages"];
  if (o.summaryOnly) args.push("--count");
  else args.push("--line-number", "--with-filename");
  if (!o.caseSensitive) args.push("-i");
  if (o.context && o.context > 0) args.push("-C", String(o.context));
  if (o.glob) args.push("--glob", o.glob);
  for (const g of o.excludeGlobs ?? []) args.push("--glob", g);
  if (o.includeDeps) args.push("--no-ignore", "--hidden");
  args.push("--regexp", o.pattern, "--", o.startRel);
  return args;
}

/** Parse the path prefix out of a ripgrep output line ("rel:line:text" or "rel:count"). */
export function rgRelOf(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line.charAt(i) !== ":") continue;
    let j = i + 1;
    if (j >= line.length) continue;
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) continue;
    while (j < line.length) {
      const d = line.charCodeAt(j);
      if (d < 48 || d > 57) break;
      j++;
    }
    return line.slice(0, i);
  }
  return line;
}

export function runRipgrep(o: RipgrepOptions): Promise<RipgrepRun> {
  return new Promise<RipgrepRun>((resolve) => {
    const child = spawn("rg", rgArgs(o), {
      cwd: o.rootDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let used = true;
    let settled = false;
    const finish = (s: RipgrepStop): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ used, lines, stop: s });
    };
    const onAbort = (): void => {
      child.kill();
      finish("abort");
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("timeout");
    }, o.deadlineMs);
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (raw.length === 0 || raw.includes("binary file matches")) continue;
        lines.push(raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw);
        if (lines.length >= MAX_OUTPUT_LINES) {
          child.kill();
          finish("cap");
          return;
        }
      }
    });
    child.on("error", () => {
      used = false;
      finish(null);
    });
    child.on("close", (code) => {
      if (code === 2 && lines.length === 0) used = false;
      finish(null);
    });
  });
}
