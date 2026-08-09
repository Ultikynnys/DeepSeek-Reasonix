import { spawn, spawnSync } from "node:child_process";

export type ProcessTreeSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeKillOptions {
  /** Use synchronous taskkill for callers that must attempt termination before settling. */
  syncWindows?: boolean;
  /** Last-resort direct-child fallback for callers that still hold the ChildProcess. */
  fallback?: () => void;
}

/** Terminate a process and its descendants on Windows and POSIX. */
export function killProcessTree(
  pid: number,
  signal: ProcessTreeSignal,
  opts: ProcessTreeKillOptions = {},
): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    if (opts.syncWindows) {
      try {
        spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
        return;
      } catch {
        /* fall through to the POSIX/direct fallback path */
      }
    } else {
      try {
        const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
        killer.on("error", () => {
          /* best effort — the caller has its own deadline */
        });
      } catch {
        /* best effort — the process may already be gone */
      }
      return;
    }
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a process-group leader — fall through to the direct pid */
  }
  try {
    process.kill(pid, signal);
    return;
  } catch {
    /* already gone — try the caller's direct-child fallback, if any */
  }
  opts.fallback?.();
}
