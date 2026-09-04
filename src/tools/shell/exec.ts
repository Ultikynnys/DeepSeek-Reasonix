import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree as killProcessTreeByPid } from "../process-tree.js";
import { parseCommandChain, runChain } from "../shell-chain.js";
import { tokenizeCommand } from "./parse.js";

export const DEFAULT_TIMEOUT_SEC = 60;
export const DEFAULT_MAX_OUTPUT_CHARS = 32_000;

/** Kill child + descendants using the shared cross-platform process-tree helper. */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  killProcessTreeByPid(child.pid, "SIGKILL", {
    syncWindows: true,
    fallback: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  });
}

export interface RunCommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, truncated to `maxOutputChars` with a marker. */
  output: string;
  /** True when the process was killed for exceeding `timeoutSec`. */
  timedOut: boolean;
}

/** Flush cadence for live output — coalesce short writes so a chatty process
 *  doesn't emit one event per data chunk, but never delay a completed line. */
const LIVE_COALESCE_CHARS = 512;

/** Incremental stdout/stderr feed for UIs: decodes raw chunks UTF-8 (tolerating
 *  multi-byte sequences split across chunks), coalesces bursts, and hard-caps
 *  the total forwarded so an unbounded `cat` can't flood the wire. The final
 *  authoritative output is NOT this — runCommand still decodes the full byte
 *  buffer at close (smartDecodeOutput), so live text may degrade to U+FFFD on
 *  non-UTF-8 codepages without hurting the tool result the model sees. */
export class LiveOutputEmitter {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private emitted = 0;
  private done = false;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly maxChars: number,
  ) {}

  push(chunk: Buffer): void {
    if (this.done) return;
    this.pending += this.decoder.write(chunk);
    // Carriage-return progress (spinners, `cargo build` percentage lines):
    // each `\r` restarts the CURRENT partial line, so earlier frames of that
    // line must not stack in the live view. Terminal semantics: only the
    // frame written after the last `\r` survives. Complete lines already
    // flushed past the final `\n` are never touched.
    const nlAt = this.pending.lastIndexOf("\n");
    const tail = this.pending.slice(nlAt + 1);
    if (tail.includes("\r")) {
      const frames = tail.split("\r");
      const visible = frames[frames.length - 1] ?? "";
      this.pending = this.pending.slice(0, nlAt + 1) + visible;
    }
    const newlineAt = this.pending.lastIndexOf("\n");
    // Hold short unterminated writes (progress bars, partial lines) until
    // either a newline completes them or they grow past the coalesce bound.
    if (newlineAt < 0 && this.pending.length < LIVE_COALESCE_CHARS) return;
    this.flushTo(newlineAt >= 0 ? newlineAt + 1 : this.pending.length);
  }

  /** Emit the partial trailing line (command/group ended without a final newline). */
  flushPartial(): void {
    if (this.done || this.pending.length === 0) return;
    this.flushTo(this.pending.length);
  }

  /** Command settled — flush the tail and stop accepting chunks. */
  end(): void {
    if (this.done) return;
    this.flushPartial();
    this.done = true;
    this.pending = "";
    this.decoder.end();
  }

  private flushTo(len: number): void {
    if (len <= 0) return;
    const slice = this.pending.slice(0, len);
    this.pending = this.pending.slice(len);
    const remaining = this.maxChars - this.emitted;
    if (remaining <= 0) {
      this.done = true;
      this.pending = "";
      this.decoder.end();
      return;
    }
    if (slice.length > remaining) {
      this.emit(slice.slice(0, remaining));
      this.emitted = this.maxChars;
      this.done = true;
      this.pending = "";
      this.decoder.end();
      return;
    }
    this.emit(slice);
    this.emitted += slice.length;
  }
}

export async function runCommand(
  cmd: string,
  opts: {
    cwd: string;
    timeoutSec?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
    /** Called with incremental stdout+stderr text while the command runs. When
     *  absent (tests / non-UI callers) no streaming machinery is created. */
    onOutput?: (text: string) => void;
  },
): Promise<RunCommandResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const argv = tokenizeCommand(cmd);
  if (argv.length === 0) throw new Error("run_command: empty command");
  const chain = parseCommandChain(cmd);
  if (chain !== null) {
    return await runChain(chain, {
      cwd: opts.cwd,
      timeoutSec,
      maxOutputChars: maxChars,
      signal: opts.signal,
      onOutput: opts.onOutput,
    });
  }
  const timeoutMs = timeoutSec * 1000;
  const normalizedEnv = normalizeWindowsEnvVars(process.env);

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    shell: false,
    windowsHide: true,
    // POSIX: detach so the child becomes its own process-group leader.
    // Required for `process.kill(-pid, …)` in killProcessTree to
    // terminate the whole subtree (child + grandchildren) instead of
    // only the leader — without this grandchildren like npm→node→esbuild
    // become orphaned.
    // Windows: detached would spawn a new console window; leave the
    // default and use taskkill /T for tree termination (see killProcessTree).
    detached: process.platform !== "win32",
    // PYTHONIOENCODING + PYTHONUTF8 force any spawned Python child
    // (run_command running `python script.py`, etc.) to emit UTF-8
    // on stdout/stderr. Without this, Chinese-Windows defaults
    // Python's stdout encoder to GBK and `print("…")` raises
    // UnicodeEncodeError on emoji / non-GBK chars — the model then
    // sees a Python traceback instead of the script's real output
    // and goes around in circles trying to fix the wrong problem.
    // Harmless on non-Python processes (env vars they don't read).
    env: { ...normalizedEnv, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  };

  // Windows: two layered fixes on top of shell:false —
  //   1. Resolve bare command names via PATH × PATHEXT (CreateProcess
  //      ignores PATHEXT, so `npm` alone misses `npm.cmd`).
  //   2. Node 21.7.3+ (CVE-2024-27980) refuses to spawn `.cmd`/`.bat`
  //      directly even with shell:false and safe args — throws
  //      EINVAL at invocation time. Wrap those via `cmd.exe /d /s /c`
  //      with verbatim args + manual quoting, so shell metacharacters
  //      in arguments stay literal.
  // Unix path is unchanged.
  const { bin, args, spawnOverrides } = prepareSpawn(argv, { env: normalizedEnv });
  const effectiveSpawnOpts = { ...spawnOpts, ...spawnOverrides };

  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(bin, args, effectiveSpawnOpts);
    } catch (err) {
      reject(err);
      return;
    }
    // Collect raw Buffer chunks rather than decoding incrementally —
    // a multi-byte sequence can land split across chunks, and a naïve
    // chunk.toString() corrupts it before the second half arrives.
    // We decode once at close time, where smartDecodeOutput can also
    // sniff non-UTF-8 codepages cleanly. The byte cap mirrors the
    // prior char cap (2× maxChars worth) so a chatty process can't
    // OOM us.
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const byteCap = maxChars * 2 * 4; // worst-case 4 bytes/char for utf-8/gbk
    let timedOut = false;
    let settled = false;
    const live = opts.onOutput ? new LiveOutputEmitter(opts.onOutput, maxChars * 2) : null;
    const killChildTree = () => killProcessTree(child);
    // Single settle path with an idempotency guard: the kill paths (timeout /
    // abort) call finish() immediately so the result — including whatever
    // partial output was captured — reaches the log and the model the moment
    // the signal fires. Waiting for 'close' alone can lag seconds on Windows
    // + Node ≥ 24 (stdio drain behind taskkill /T /F), which would delay a
    // user cancel message past the point of usefulness. Normal runs settle
    // on 'close' with the real exit code.
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Flush the live tail BEFORE the result resolves: the UI should see the
      // final partial line, then the authoritative full output on tool.result.
      live?.end();
      const merged = Buffer.concat(chunks);
      const buf = smartDecodeOutput(merged);
      const output =
        buf.length > maxChars
          ? `${buf.slice(0, maxChars)}\n\n[… truncated ${buf.length - maxChars} chars …]`
          : buf;
      resolve({ exitCode, output, timedOut });
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      killChildTree();
      finish(null);
    }, timeoutMs);
    const onAbort = () => {
      killChildTree();
      finish(null);
    };
    // Check synchronously first — if the signal aborted before listener attach
    // (parent loop was already cancelled), addEventListener with `once:true`
    // never fires, child runs unbounded.
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      live?.push(b);
      if (totalBytes >= byteCap) return;
      const remaining = byteCap - totalBytes;
      if (b.length > remaining) {
        chunks.push(b.subarray(0, remaining));
        totalBytes = byteCap;
      } else {
        chunks.push(b);
        totalBytes += b.length;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      live?.end();
      reject(err);
    });
    child.on("close", (code) => finish(code));
  });
}

/** GBK fallback on Windows — cmd.exe's localized error DLL and native EXE stderr ignore chcp 65001. */
export function smartDecodeOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // Fall through to platform-specific fallback.
  }
  if (process.platform === "win32") {
    try {
      // TextDecoder supports gbk / gb18030 in Node 18+ via the WHATWG
      // Encoding spec. gb18030 is the modern superset; falling back
      // to it covers GBK byte sequences plus the rare 4-byte CJK
      // characters that appear in newer system messages.
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      // Decoder unavailable in this build — fall through.
    }
  }
  // Last resort: lossy UTF-8 with replacement chars. The model still
  // gets "something happened" with the structural exit-code marker
  // intact, which is more useful than throwing away the entire output.
  return buf.toString("utf8");
}

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  isFile?: (path: string) => boolean;
  pathDelimiter?: string;
}

/** CreateProcess ignores PATHEXT — bare `npm` fails ENOENT under `shell:false` without this resolver. */
export function resolveExecutable(cmd: string, opts: ResolveExecutableOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return cmd;
  if (!cmd) return cmd;
  // Already a path fragment — spawn handles these natively.
  if (cmd.includes("/") || cmd.includes("\\") || pathMod.isAbsolute(cmd)) return cmd;
  // If the model wrote `npm.cmd` explicitly, respect that verbatim.
  if (pathMod.extname(cmd)) return cmd;

  const env = opts.env ?? process.env;
  const pathExt = (getEnvCaseInsensitive(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const delimiter = opts.pathDelimiter ?? (platform === "win32" ? ";" : pathMod.delimiter);
  const pathDirs = (getEnvCaseInsensitive(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const isFile = opts.isFile ?? defaultIsFile;

  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      // Force win32 join so CI tests that pass `platform: "win32"`
      // from a Linux runner get backslash-joined paths; the real-
      // Windows runtime path lands here too and gets the correct
      // separator regardless of where pathMod defaults.
      const full = pathMod.win32.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return cmd;
}

export function normalizeWindowsEnvVars(
  env: NodeJS.ProcessEnv,
  opts: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { ...env };

  const out: NodeJS.ProcessEnv = {};
  const pathValues: string[] = [];
  const pathExtValues: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (lower === "path") {
      if (typeof value === "string") pathValues.push(value);
      continue;
    }
    if (lower === "pathext") {
      if (typeof value === "string") pathExtValues.push(value);
      continue;
    }
    out[key] = value;
  }

  if (pathValues.length > 0) out.Path = mergeWindowsPathLike(pathValues, ";");
  if (pathExtValues.length > 0) out.PATHEXT = mergeWindowsPathLike(pathExtValues, ";");

  return out;
}

function getEnvCaseInsensitive(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const exact = env[key];
  if (exact !== undefined) return exact;
  const target = key.toLowerCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toLowerCase() === target) return value;
  }
  return undefined;
}

function mergeWindowsPathLike(values: readonly string[], delimiter: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of values) {
    for (const part of value.split(delimiter)) {
      const entry = part.trim();
      if (!entry) continue;
      const normalized = entry.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(entry);
    }
  }

  return merged.join(delimiter);
}

function defaultIsFile(full: string): boolean {
  try {
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

/** Windows workarounds: PATHEXT lookup + CVE-2024-27980 prohibition on direct `.cmd`/`.bat` spawn. */
export function prepareSpawn(
  argv: readonly string[],
  opts: ResolveExecutableOptions = {},
): { bin: string; args: string[]; spawnOverrides: SpawnOptions } {
  const head = argv[0] ?? "";
  const tail = argv.slice(1);
  const platform = opts.platform ?? process.platform;
  const resolved = resolveExecutable(head, opts);

  if (platform !== "win32") {
    return { bin: resolved, args: [...tail], spawnOverrides: {} };
  }

  // `.cmd` / `.bat` wrappers require cmd.exe on post-CVE Node.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const cmdline = [resolved, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", withUtf8Codepage(cmdline)],
      // windowsVerbatimArguments prevents Node from re-quoting the /c
      // payload — we've already composed an exact cmd.exe command
      // line. Without this Node wraps our already-quoted string in
      // another round of quotes and cmd.exe can't parse it.
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }

  // Bare command names that PATH × PATHEXT couldn't resolve to an
  // on-disk file — these are almost always cmd.exe built-ins (`dir`,
  // `echo`, `type`, `ver`, `vol`, `where`, `help`, …) which don't
  // exist as standalone executables. Direct spawn crashes with ENOENT;
  // routing through cmd.exe lets the built-in resolve, and if it's
  // genuinely unknown the user gets the standard "'foo' is not
  // recognized" message instead of a raw spawn failure.
  if (isBareWindowsName(resolved) && resolved === head) {
    const cmdline = [head, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", withUtf8Codepage(cmdline)],
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }

  // PowerShell variants: chcp 65001 doesn't help here because PowerShell
  // sets its own [Console]::OutputEncoding at startup — usually system
  // codepage (CP936/CP932/CP949 on CJK Windows) or UTF-16. The result
  // is mojibake when our `chunk.toString()` UTF-8-decodes its stdout.
  // Inject a UTF-8 setup prelude into the `-Command` (or `-c`) arg so
  // any output produced thereafter is UTF-8.
  if (isPowerShellExe(resolved)) {
    const patched = injectPowerShellUtf8(tail);
    if (patched) {
      return { bin: resolved, args: patched, spawnOverrides: {} };
    }
  }

  return { bin: resolved, args: [...tail], spawnOverrides: {} };
}

/** Resolved bin path looks like Windows PowerShell or PowerShell Core. */
function isPowerShellExe(resolved: string): boolean {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(resolved);
}

/** Targets `-Command` only — PowerShell quoting is finicky enough that wrapping script-file mode could break it. */
export function injectPowerShellUtf8(args: readonly string[]): string[] | null {
  const prelude =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^-(?:Command|c)$/i.test(a) && i + 1 < args.length) {
      const out = [...args];
      out[i + 1] = `${prelude}${args[i + 1] ?? ""}`;
      return out;
    }
  }
  return null;
}

/** Single `&` (not `&&`) so the command still runs on Win7 where chcp can return non-zero. */
export function withUtf8Codepage(cmdline: string): string {
  return `chcp 65001 >nul & ${cmdline}`;
}

function isBareWindowsName(s: string): boolean {
  if (!s) return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (pathMod.isAbsolute(s)) return false;
  if (pathMod.extname(s)) return false;
  return true;
}

/** Doubles embedded quotes per cmd.exe's `""` escape rule; bare alnum passes through unquoted. */
export function quoteForCmdExe(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%(),;!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
