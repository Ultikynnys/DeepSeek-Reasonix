// Ripgrep delegation for search_content — upstream's default "auto" engine.
// Honors .gitignore, scans far faster than the JS walker, and RE2 regex can't
// backtrack catastrophically. Missing/misbehaving rg → native fallback; the
// tool description advertises which engine is active so it's never silent.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Output line cap before the child is killed — mirrors upstream's 200-match cap. */
const MAX_OUTPUT_LINES = 200;
/** Same metachar test filesystem.ts uses to split glob-vs-substring filters. */
export const GLOB_METACHARS = /[*?{[]/;
/** Display-truncation for long lines, matching the native scanner's 200-char cut. */
const MAX_LINE_CHARS = 200;

let probe: boolean | null = null;
let probeOverride: boolean | null = null;
let binaryPath: string | null | undefined; // undefined = not resolved yet

/** Resolve rg: REASONIX_RG_PATH env → bundled dist/rg/rg.exe → @vscode/ripgrep package → PATH. */
export function resolveRgBinary(): string | null {
  if (binaryPath !== undefined) return binaryPath;
  const envPath = process.env.REASONIX_RG_PATH;
  if (envPath && envPath.length > 0) {
    binaryPath = envPath;
    return binaryPath;
  }
  // Module-relative: from dist/cli/index.js → dist/rg/rg.exe; from src in
  // dev it resolves to a nonexistent path and falls through.
  try {
    const bundled = fileURLToPath(new URL("../rg/rg.exe", import.meta.url));
    if (existsSync(bundled)) {
      binaryPath = bundled;
      return binaryPath;
    }
  } catch {
    // import.meta.url unavailable — fall through.
  }
  // Walk up from this module looking for the platform package.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, "node_modules", "@vscode", "ripgrep-win32-x64", "bin", "rg.exe");
    if (existsSync(pkg)) {
      binaryPath = pkg;
      return binaryPath;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  binaryPath = null;
  return null;
}

/** Cached probe: is ripgrep reachable? (Once per process; test override supported.) */
export function ripgrepAvailable(): boolean {
  if (probeOverride !== null) return probeOverride;
  if (probe !== null) return probe;
  const binary = resolveRgBinary() ?? "rg";
  try {
    const r = spawnSync(binary, ["--version"], { stdio: "ignore", windowsHide: true });
    probe = !r.error && r.status === 0;
  } catch {
    probe = false;
  }
  return probe;
}

/** Test-only: pin ripgrep availability (null = re-probe on next call). */
export function __setRipgrepForTesting(available: boolean | null): void {
  probeOverride = available;
  if (available === null) binaryPath = undefined;
}

export type RipgrepStop = "cap" | "timeout" | "abort" | null;

export interface RipgrepRun {
  /** True when rg produced output (or cleanly found nothing); false → fall back to native. */
  used: boolean;
  /** Native-format lines ("rel:LINE: text", context "rel:LINE- text", or "rel:count" in summary mode). */
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
  const args = ["--no-messages"];
  if (o.summaryOnly) args.push("--count");
  else args.push("--json");
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

/** rg --json record shape — only the fields we consume. */
interface RgJsonRecord {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

/** Strip rg's leading `.\`/`./` and normalize backslashes to `/` (Windows output). */
function normalizeRgPath(p: string): string {
  let s = p;
  if (s.startsWith("./") || s.startsWith(".\\")) s = s.slice(2);
  return s.replaceAll("\\", "/");
}

/** Trim the trailing newline rg appends to `lines.text`. */
function trimRgLine(text: string): string {
  return text.replace(/\r?\n$/, "");
}

export function runRipgrep(o: RipgrepOptions): Promise<RipgrepRun> {
  return new Promise<RipgrepRun>((resolve) => {
    const binary = resolveRgBinary() ?? "rg";
    const child = spawn(binary, rgArgs(o), {
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

    const pushLine = (l: string): boolean => {
      if (lines.length >= MAX_OUTPUT_LINES) {
        child.kill();
        finish("cap");
        return false;
      }
      lines.push(l);
      return true;
    };

    // Native-format rendering of --json records; the `--` window separator is
    // synthesized from line-number gaps (rg doesn't emit it in JSON mode).
    let lastPath: string | null = null;
    let lastLine = 0;
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (raw.length === 0) continue;
        if (o.summaryOnly) {
          if (raw.includes("binary file matches")) continue;
          if (!pushLine(normalizeRgPath(raw))) return;
          continue;
        }
        let rec: RgJsonRecord;
        try {
          rec = JSON.parse(raw) as RgJsonRecord;
        } catch {
          continue;
        }
        if (rec.type === "begin") {
          lastPath = null;
          lastLine = 0;
          continue;
        }
        if (rec.type !== "match" && rec.type !== "context") continue;
        const d = rec.data;
        const rel = d?.path?.text !== undefined ? normalizeRgPath(d.path.text) : null;
        const lineNo = d?.line_number;
        const text = d?.lines?.text;
        if (rel === null || typeof lineNo !== "number" || text === undefined) continue;
        if (
          o.context &&
          o.context > 0 &&
          lastPath === rel &&
          lastLine !== 0 &&
          lineNo > lastLine + 1
        ) {
          if (!pushLine("--")) return;
        }
        const sep = rec.type === "context" ? "-" : ":";
        const content = trimRgLine(text);
        const display =
          content.length > MAX_LINE_CHARS ? `${content.slice(0, MAX_LINE_CHARS)}…` : content;
        if (!pushLine(`${rel}:${lineNo}${sep} ${display}`)) return;
        lastPath = rel;
        lastLine = lineNo;
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
