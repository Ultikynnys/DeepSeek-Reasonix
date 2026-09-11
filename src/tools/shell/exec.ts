import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as pathMod from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  OutputRecoveryCapture,
  type OutputRecoveryRef,
  shouldPersistOutputRecovery,
} from "../output-recovery.js";
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
  /** Combined stdout+stderr preview, bounded to `maxOutputChars`. */
  output: string;
  /** True when output was omitted from the preview. */
  truncated?: boolean;
  /** Complete number of stdout+stderr bytes observed. */
  totalOutputBytes?: number;
  /** Wall-clock command duration. */
  durationMs?: number;
  /** Content-addressed recovery artifact when output was omitted. */
  recovery?: OutputRecoveryRef;
  /** Explicit recovery failure. Never silently discards omitted output. */
  recoveryError?: string;
  /** True when the process was killed for exceeding `timeoutSec`. */
  timedOut: boolean;
}

/** Flush cadence for live output: coalesce short writes so a chatty process
 *  doesn't emit one event per data chunk, but never delay a completed line. */
const LIVE_COALESCE_CHARS = 512;

/** Incremental stdout/stderr feed for UIs: decodes chunks UTF-8 (multi-byte
 *  splits safe), coalesces bursts, and hard-caps total text forwarded. Not
 *  authoritative: runCommand re-decodes the full byte buffer at close. */
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
    outputRecovery?: import("../output-recovery.js").OutputRecoveryLimits;
    /** Preserve raw output because a post-execution semantic filter may omit material. */
    preserveOutput?: boolean;
  },
): Promise<RunCommandResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const startedAt = Date.now();
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
      commandLabel: cmd,
      startedAt,
      outputRecovery: opts.outputRecovery,
      preserveOutput: opts.preserveOutput,
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
    let bufferedBytes = 0;
    let totalBytes = 0;
    const byteCap = maxChars * 2 * 4; // worst-case 4 bytes/char for utf-8/gbk
    const recoveryCapture = new OutputRecoveryCapture(opts.cwd, opts.outputRecovery);
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
      const truncated = buf.length > maxChars || totalBytes > merged.length;
      // Capture every non-empty result so a later semantic filter can offer the exact raw body.
      // The formatter only exposes the reference when output was omitted or the command failed.
      const recoveryResult = recoveryCapture.finish(
        cmd,
        shouldPersistOutputRecovery(totalBytes, truncated, exitCode, opts.preserveOutput),
        opts.outputRecovery,
      );
      resolve(
        assembleResult({
          buf,
          totalBytes,
          rawByteLength: merged.length,
          exitCode,
          durationMs: Date.now() - startedAt,
          timedOut,
          maxChars,
          recovery: recoveryResult?.ok ? recoveryResult.ref : undefined,
          recoveryError: recoveryResult && !recoveryResult.ok ? recoveryResult.error : undefined,
        }),
      );
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
      recoveryCapture.append(b);
      totalBytes += b.length;
      live?.push(b);
      if (bufferedBytes >= byteCap) return;
      const remaining = byteCap - bufferedBytes;
      const kept = b.length > remaining ? b.subarray(0, remaining) : b;
      chunks.push(kept);
      bufferedBytes += kept.length;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      live?.end();
      recoveryCapture.finish(cmd, false);
      reject(err);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Shared result assembly for runCommand and runCommandElevated: apply the char
 *  cap, build the truncation marker, and attach any content-addressed recovery
 *  ref. Kept pure so both the piped and the elevated (temp-file) paths converge. */
export function assembleResult(args: {
  /** Decoded stdout+stderr (already passed through smartDecodeOutput). */
  buf: string;
  /** Total stdout+stderr bytes observed (may exceed rawByteLength when capped). */
  totalBytes: number;
  /** Byte length of the buffer `buf` was decoded from. */
  rawByteLength: number;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  maxChars: number;
  recovery?: OutputRecoveryRef;
  recoveryError?: string;
}): RunCommandResult {
  const truncated = args.buf.length > args.maxChars || args.totalBytes > args.rawByteLength;
  const omittedBytes = Math.max(
    0,
    args.totalBytes -
      Math.min(args.totalBytes, Buffer.byteLength(args.buf.slice(0, args.maxChars))),
  );
  const marker = truncated ? `\n\n[… truncated ${omittedBytes} chars …]` : "";
  const output = truncated ? `${args.buf.slice(0, args.maxChars)}${marker}` : args.buf;
  return {
    exitCode: args.exitCode,
    output,
    truncated,
    totalOutputBytes: args.totalBytes,
    durationMs: args.durationMs,
    timedOut: args.timedOut,
    ...(args.recovery ? { recovery: args.recovery } : {}),
    ...(args.recoveryError ? { recoveryError: args.recoveryError } : {}),
  };
}

/** Exit code the launcher powershell exits with when `Start-Process -Verb RunAs`
 *  is cancelled at the UAC prompt (ERROR_CANCELLED = 1223) or fails to launch. */
export const ELEVATION_DECLINED_EXIT = 1223;

/** Non-elevated launcher that raises the UAC consent prompt. */
export interface ElevatedInvocation {
  bin: string;
  args: string[];
}

// Pure builder for the launcher that elevates `wrapperPath` via UAC consent.
// The launcher is a plain powershell.exe; elevation happens inside it via
// `Start-Process -Verb RunAs`, which shows the real Windows UAC dialog. It waits
// (`-Wait -PassThru`) and exits with the elevated process's code. No filesystem
// or process access here, so the shape is unit-testable; the caller owns writing
// the wrapper + temp files.
export function buildElevatedInvocation(wrapperPath: string): ElevatedInvocation {
  const script = [
    "$ErrorActionPreference='Stop'",
    "try {",
    `  $p = Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/s','/c','"${wrapperPath}"' -Verb RunAs -Wait -PassThru`,
    "  exit $p.ExitCode",
    "} catch {",
    "  [Console]::Error.WriteLine('ELEVATION_DECLINED: ' + $_.Exception.Message)",
    `  exit ${ELEVATION_DECLINED_EXIT}`,
    "}",
  ].join("\n");
  return {
    bin: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
  };
}

export interface ElevatedCommandResult extends RunCommandResult {
  /** True when the user dismissed the Windows UAC consent prompt. */
  elevationDeclined?: boolean;
}

// Minimal spawn + wait + capture used by the elevated runner. Unlike runCommand
// it does not stream live output or retain a large stdout buffer: the elevated
// process writes its real output to a temp file, so the launcher's stdout/stderr
// only carry diagnostics (e.g. a UAC-decline message). On timeout/abort the
// launcher tree is killed; the elevated process itself is a separate integrity
// level and may survive (documented limitation).
function spawnCollect(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutSec: number; signal?: AbortSignal },
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(err);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
    };
    const killChildTree = () => killProcessTree(child);
    const killTimer = setTimeout(() => {
      timedOut = true;
      killChildTree();
      finish(null);
    }, opts.timeoutSec * 1000);
    const onAbort = () => {
      killChildTree();
      finish(null);
    };
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (c: Buffer) => stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (err) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => finish(code));
  });
}

// Run `cmd` in an elevated context on Windows via UAC consent. Windows-only:
// `Start-Process -Verb RunAs` raises the OS UAC dialog and cannot pipe to our
// stdout, so the command is written to a generated temp `.cmd` wrapper that
// redirects combined stdout+stderr to a temp file; the file is read back and fed
// through the same truncation/recovery pipeline. A dismissed UAC prompt is
// surfaced as `elevationDeclined` rather than a silent empty result.
export async function runCommandElevated(
  cmd: string,
  opts: {
    cwd: string;
    timeoutSec?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
    outputRecovery?: import("../output-recovery.js").OutputRecoveryLimits;
    preserveOutput?: boolean;
    platform?: NodeJS.Platform;
  },
): Promise<ElevatedCommandResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("run_command: elevate=true is only supported on Windows");
  }
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const startedAt = Date.now();

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wrapperPath = pathMod.join(os.tmpdir(), `rsx-elev-${token}.cmd`);
  const outPath = pathMod.join(os.tmpdir(), `rsx-elev-${token}.out`);
  // UTF-8 codepage, then the command with combined stdout+stderr redirected to
  // the temp file. cmd-native chaining (|, &&, …) still applies inside the wrapper.
  const wrapper = `@echo off\r\nchcp 65001>nul 2>&1\r\n${cmd} > "${outPath}" 2>&1\r\n`;

  try {
    await writeFile(wrapperPath, wrapper, "utf8");
    const { bin, args } = buildElevatedInvocation(wrapperPath);
    const collected = await spawnCollect(bin, args, {
      cwd: opts.cwd,
      timeoutSec,
      signal: opts.signal,
    });

    let raw: Buffer = Buffer.alloc(0);
    try {
      raw = await readFile(outPath);
    } catch {
      /* output file absent — e.g. UAC declined before the wrapper ran */
    }
    const stderrText = smartDecodeOutput(collected.stderr);
    const elevationDeclined =
      collected.exitCode === ELEVATION_DECLINED_EXIT || /ELEVATION_DECLINED/.test(stderrText);

    const buf = smartDecodeOutput(raw);
    const totalBytes = raw.length;
    const recoveryCapture = new OutputRecoveryCapture(opts.cwd, opts.outputRecovery);
    recoveryCapture.append(raw);
    const recoveryResult = recoveryCapture.finish(
      cmd,
      shouldPersistOutputRecovery(
        totalBytes,
        buf.length > maxChars,
        collected.exitCode,
        opts.preserveOutput,
      ),
      opts.outputRecovery,
    );
    const result = assembleResult({
      buf,
      totalBytes,
      rawByteLength: raw.length,
      exitCode: collected.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: collected.timedOut,
      maxChars,
      recovery: recoveryResult?.ok ? recoveryResult.ref : undefined,
      recoveryError: recoveryResult && !recoveryResult.ok ? recoveryResult.error : undefined,
    });

    if (elevationDeclined) {
      const note =
        "\n\n[elevation declined: the Windows UAC consent prompt was dismissed or failed to launch — the command did not run elevated]";
      return {
        ...result,
        elevationDeclined: true,
        output: `${result.output}${stderrText ? `\n${stderrText}` : ""}${note}`,
      };
    }
    return result;
  } finally {
    await Promise.allSettled([unlink(wrapperPath), unlink(outPath)]);
  }
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
