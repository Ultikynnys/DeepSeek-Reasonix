import { promises as fs } from "node:fs";
import * as pathMod from "node:path";
import { looksBinary } from "./binary.js";
import { getRegexRunner } from "./regex-runner.js";
import { displayRel } from "./rel.js";
import { GLOB_METACHARS, rgRelOf, ripgrepAvailable, runRipgrep } from "./rg.js";
import { throwIfAborted, walkDir } from "./walk.js";

export interface SearchContext {
  rootDir: string;
  maxListBytes: number;
  skipDirNames: ReadonlySet<string>;
  isBinaryByName: (name: string) => boolean;
  /** Pre-baked filename→regex/substring matcher; null when no glob filter. */
  nameMatch: ((name: string, rel: string) => boolean) | null;
}

export async function searchFiles(
  ctx: Pick<SearchContext, "rootDir" | "maxListBytes" | "skipDirNames">,
  startAbs: string,
  args: {
    pattern: string;
    include_deps?: boolean;
    timeout_seconds?: number;
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  throwIfAborted(args.signal);
  const needle = args.pattern.toLowerCase();
  const includeDeps = args.include_deps === true;
  const timeoutSec = clampTimeoutSeconds(args.timeout_seconds);
  const deadline = Date.now() + timeoutSec * 1000;
  const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
  const walkSignal = args.signal ? AbortSignal.any([args.signal, timeoutSignal]) : timeoutSignal;
  const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 1000)));
  let re: RegExp | null = null;
  try {
    re = new RegExp(args.pattern, "i");
  } catch {
    re = null;
  }
  const matches: string[] = [];
  let totalBytes = 0;
  let timedOut = false;
  let truncated = false;
  const shouldStop = (): boolean => {
    if (timedOut || truncated) return true;
    if (Date.now() >= deadline) {
      timedOut = true;
      return true;
    }
    return false;
  };

  try {
    await walkDir(
      startAbs,
      {
        includeDeps,
        skipDirNames: ctx.skipDirNames,
        signal: walkSignal,
        label: "search",
        shouldStop,
      },
      (entry) => {
        if (!entry.dirent.isFile() && !entry.dirent.isSymbolicLink()) return true;
        const hit = re
          ? re.test(entry.dirent.name)
          : entry.dirent.name.toLowerCase().includes(needle);
        if (!hit) return true;
        const rel = displayRel(ctx.rootDir, entry.full);
        if (totalBytes + rel.length + 1 > ctx.maxListBytes) {
          truncated = true;
          return false;
        }
        matches.push(rel);
        totalBytes += rel.length + 1;
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
        return true;
      },
    );
  } catch (err) {
    if (timeoutSignal.aborted && !args.signal?.aborted) timedOut = true;
    else throw err;
  }

  if (matches.length === 0) {
    if (timedOut) {
      return `(no matches; timed out after ${timeoutSec}s — narrow the path/pattern or raise timeout_seconds)`;
    }
    return "(no matches)";
  }
  if (truncated) {
    matches.push(
      `... (truncated at ${matches.length} results — refine pattern/path or raise limit)`,
    );
  } else if (timedOut) {
    matches.push(
      `... (timed out after ${timeoutSec}s; results incomplete — narrow the path/pattern or raise timeout_seconds)`,
    );
  }
  return matches.join("\n");
}

/** Per-file printed-hit cap; beyond this we emit a "N more matches in this file" footer. */
const MAX_HITS_PER_FILE = 30;
/** Once printed bytes pass this fraction of the byte budget, remaining files switch to histogram. */
const SUMMARY_MODE_TRIGGER_RATIO = 0.8;
// Soft walk deadline in seconds, clamped to [1, 300] — mirrors upstream's
// grep tool (default 30, max 300). On expiry the search returns partial
// results with a "timed out" footer instead of throwing.
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const REGEX_METACHARS = /[\\.+*?()[\]{}|^$]/;

/** Clamp caller-supplied timeout seconds to [1, 300]; omitted/0 → 30. */
export function clampTimeoutSeconds(sec: number | undefined): number {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.floor(sec), MAX_TIMEOUT_SECONDS);
}

/** "path:count" → "path: N match(es)" (ripgrep --count output). */
function formatRgSummary(lines: string[]): string[] {
  return lines.map((l) => {
    const i = l.lastIndexOf(":");
    if (i === -1) return l;
    const count = Number.parseInt(l.slice(i + 1), 10);
    return `${l.slice(0, i)}: ${count} match${count === 1 ? "" : "es"}`;
  });
}

export async function searchContent(
  ctx: SearchContext,
  startAbs: string,
  args: {
    pattern: string;
    case_sensitive?: boolean;
    include_deps?: boolean;
    context?: number;
    glob?: string;
    /** Skip line content; return only "rel: N matches" per file. */
    summary_only?: boolean;
    /** Abort and return partial results after this many seconds (default 30, max 300). */
    timeout_seconds?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  throwIfAborted(args.signal);
  const caseSensitive = args.case_sensitive === true;
  const includeDeps = args.include_deps === true;
  const ctxLines = Math.max(0, Math.min(20, Math.floor(args.context ?? 0)));
  const summaryOnly = args.summary_only === true;
  const reFlags = caseSensitive ? "" : "i";
  // Patterns with no regex metacharacters take the main-thread `text.includes`
  // path below — building a worker dispatch for plain literals dominates wall
  // time on multi-file scans (#1748).
  const hasMeta = REGEX_METACHARS.test(args.pattern);
  let reSource: string | null = null;
  if (hasMeta) {
    try {
      new RegExp(args.pattern, reFlags);
      reSource = args.pattern;
    } catch {
      reSource = null;
    }
  }
  const needle = caseSensitive ? args.pattern : args.pattern.toLowerCase();
  const matches: string[] = [];
  let totalBytes = 0;
  let scanned = 0;
  let truncated = false;
  let summaryMode = summaryOnly;
  let summaryNoticeEmitted = false;
  const fileHitCounts = new Map<string, number>();
  const regexSkippedFiles: Array<{ rel: string; reason: string }> = [];
  const timeoutSec = clampTimeoutSeconds(args.timeout_seconds);
  const deadlineMs = timeoutSec * 1000;
  const t0 = Date.now();
  let timedOut = false;
  /** True once the walk budget is spent; the walk stops and results come back partial. */
  const checkDeadline = (): boolean => {
    if (timedOut) return true;
    if (Date.now() - t0 > deadlineMs) timedOut = true;
    return timedOut;
  };

  const pushLine = (out: string): boolean => {
    if (totalBytes + out.length + 1 > ctx.maxListBytes) {
      matches.push(`[… truncated at ${ctx.maxListBytes} bytes — refine pattern or path …]`);
      truncated = true;
      return false;
    }
    matches.push(out);
    totalBytes += out.length + 1;
    return true;
  };

  const maybeEnterSummaryMode = (): void => {
    if (summaryMode) return;
    if (totalBytes <= SUMMARY_MODE_TRIGGER_RATIO * ctx.maxListBytes) return;
    summaryMode = true;
    if (!summaryNoticeEmitted) {
      const pct = Math.round((totalBytes / ctx.maxListBytes) * 100);
      pushLine(
        `[switching to summary mode — byte budget at ${pct}%; remaining files will report match counts only]`,
      );
      summaryNoticeEmitted = true;
    }
  };

  // Ripgrep fast path (upstream's default "auto" engine): honors .gitignore
  // and scans far faster than the JS walker. Falls back to the native walk
  // below on any rg absence/failure.
  if (ripgrepAvailable()) {
    const absRoot = pathMod.resolve(ctx.rootDir);
    const relToRoot = pathMod.relative(absRoot, startAbs);
    if (relToRoot === "" || (!relToRoot.startsWith("..") && !pathMod.isAbsolute(relToRoot))) {
      const globArg = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : null;
      const metaGlob = globArg !== null && GLOB_METACHARS.test(globArg);
      const excludeGlobs: string[] = [];
      if (!includeDeps) {
        for (const name of ctx.skipDirNames) excludeGlobs.push(`!**/${name}/**`);
      }
      const rgRun = await runRipgrep({
        rootDir: absRoot,
        startRel: (relToRoot === "" ? "." : relToRoot).replaceAll("\\", "/"),
        pattern: args.pattern,
        caseSensitive: args.case_sensitive,
        context: ctxLines,
        glob: metaGlob ? globArg : null,
        excludeGlobs,
        includeDeps,
        summaryOnly,
        deadlineMs,
        signal: args.signal,
      });
      if (rgRun.used) {
        throwIfAborted(args.signal);
        // Extension skip + substring-glob filters can't be expressed as rg
        // flags, so post-filter each output line by its parsed path.
        const lines = rgRun.lines.filter((l) => {
          if (l === "--") return true;
          const rel = rgRelOf(l);
          const base = rel.slice(rel.lastIndexOf("/") + 1);
          if (ctx.isBinaryByName(base)) return false;
          if (
            globArg !== null &&
            !metaGlob &&
            ctx.nameMatch !== null &&
            !ctx.nameMatch(base, rel)
          ) {
            return false;
          }
          return true;
        });
        const out: string[] = [];
        let bytes = 0;
        for (const l of summaryOnly ? formatRgSummary(lines) : lines) {
          if (bytes + l.length + 1 > ctx.maxListBytes) {
            out.push(`[… truncated at ${ctx.maxListBytes} bytes — refine pattern or path …]`);
            break;
          }
          out.push(l);
          bytes += l.length + 1;
        }
        let result = out.join("\n");
        if (result === "") {
          result =
            rgRun.stop === "timeout"
              ? `(no matches; timed out after ${timeoutSec}s — narrow the path/pattern or raise timeout_seconds)`
              : "(no matches)";
        } else if (rgRun.stop === "timeout") {
          result += `\n... (timed out after ${timeoutSec}s; results incomplete — narrow the path/pattern or raise timeout_seconds)`;
        } else if (rgRun.stop === "cap") {
          result += "\n... (truncated at 200 matches)";
        }
        return result;
      }
    }
  }

  await walkDir(
    startAbs,
    {
      includeDeps,
      skipDirNames: ctx.skipDirNames,
      signal: args.signal,
      label: "search",
      shouldStop: () => truncated || checkDeadline(),
    },
    async (entry): Promise<boolean> => {
      if (truncated) return false;
      if (checkDeadline()) return false;
      const full = entry.full;
      if (ctx.nameMatch && !ctx.nameMatch(entry.dirent.name, displayRel(ctx.rootDir, full)))
        return true;
      if (ctx.isBinaryByName(entry.dirent.name)) return true;
      let fh: import("node:fs/promises").FileHandle;
      try {
        fh = await fs.open(full, "r");
      } catch {
        return true;
      }
      let raw: Buffer;
      try {
        throwIfAborted(args.signal);
        const st = await fh.stat();
        if (st.size > 2 * 1024 * 1024) {
          await fh.close();
          return true;
        }
        raw = await fh.readFile();
      } catch {
        await fh.close().catch(() => {});
        return true;
      }
      await fh.close();
      throwIfAborted(args.signal);
      if (looksBinary(raw)) return true;
      const text = raw.toString("utf8");
      const rel = displayRel(ctx.rootDir, full);
      let hits: number[];
      let lines: string[];
      if (reSource !== null) {
        lines = text.split(/\r?\n/);
        // Cap per-file regex work at the remaining walk budget so a single
        // pathological file can't overshoot timeout_seconds by a full 60 s.
        const regexBudgetMs = Math.max(1_000, deadlineMs - (Date.now() - t0));
        try {
          hits = await getRegexRunner().testLines(text, reSource, reFlags, {
            signal: args.signal,
            timeoutMs: regexBudgetMs,
          });
        } catch (err) {
          const reason = (err as Error).message;
          // Genuine abort bubbles up; regex-timeout means this single file's
          // pattern is pathological — skip it and keep walking.
          if (reason.includes("aborted")) throw err;
          regexSkippedFiles.push({ rel, reason });
          return true;
        }
      } else {
        const haystack = caseSensitive ? text : text.toLowerCase();
        if (haystack.indexOf(needle) === -1) {
          scanned++;
          return true;
        }
        lines = text.split(/\r?\n/);
        hits = [];
        for (let li = 0; li < lines.length; li++) {
          const lineForCheck = caseSensitive ? lines[li]! : lines[li]!.toLowerCase();
          if (lineForCheck.includes(needle)) hits.push(li);
        }
      }
      scanned++;
      if (hits.length === 0) return true;
      fileHitCounts.set(rel, hits.length);

      if (summaryMode) {
        if (!pushLine(`${rel}: ${hits.length} match${hits.length === 1 ? "" : "es"}`)) return false;
        return true;
      }

      const printable = Math.min(hits.length, MAX_HITS_PER_FILE);
      const omittedFromFile = hits.length - printable;
      const printableHits = hits.slice(0, printable);

      if (ctxLines === 0) {
        for (const li of printableHits) {
          if (truncated) return false;
          const line = lines[li]!;
          const display = line.length > 200 ? `${line.slice(0, 200)}…` : line;
          if (!pushLine(`${rel}:${li + 1}: ${display}`)) return false;
        }
      } else {
        const hitSet = new Set(printableHits);
        let prevWindowEnd = -2;
        for (const li of printableHits) {
          if (truncated) return false;
          const winStart = Math.max(0, li - ctxLines);
          const winEnd = Math.min(lines.length - 1, li + ctxLines);
          if (winStart > prevWindowEnd + 1 && prevWindowEnd >= 0) {
            if (!pushLine("--")) return false;
          }
          const realStart = winStart > prevWindowEnd + 1 ? winStart : prevWindowEnd + 1;
          for (let i = realStart; i <= winEnd; i++) {
            const line = lines[i]!;
            const display = line.length > 200 ? `${line.slice(0, 200)}…` : line;
            const sep = hitSet.has(i) ? ":" : "-";
            if (!pushLine(`${rel}:${i + 1}${sep} ${display}`)) return false;
          }
          prevWindowEnd = winEnd;
        }
      }

      if (omittedFromFile > 0) {
        if (
          !pushLine(
            `[${rel}: ${omittedFromFile} more match${omittedFromFile === 1 ? "" : "es"} in this file — re-grep with a tighter pattern or use read_file to see them]`,
          )
        )
          return false;
      }

      maybeEnterSummaryMode();
      return true;
    },
  );

  if (regexSkippedFiles.length > 0) {
    pushLine(
      `[regex timed out on ${regexSkippedFiles.length} file${regexSkippedFiles.length === 1 ? "" : "s"} — pattern may have catastrophic backtracking; first: ${regexSkippedFiles[0]!.rel}]`,
    );
  }
  if (timedOut) {
    if (matches.length === 0) {
      return `(no matches; timed out after ${timeoutSec}s — narrow the path/pattern or raise timeout_seconds)`;
    }
    matches.push(
      `... (timed out after ${timeoutSec}s; results incomplete — narrow the path/pattern or raise timeout_seconds)`,
    );
  }
  if (matches.length === 0) {
    return scanned === 0
      ? "(no files scanned — path empty or all files filtered out)"
      : `(no matches across ${scanned} file${scanned === 1 ? "" : "s"})`;
  }
  return matches.join("\n");
}
