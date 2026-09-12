import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../tools/process-tree.js";

export const PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT_MS = 12 * 60 * 1000;
export const PLAYWRIGHT_INSTALL_FINALIZE_TIMEOUT_MS = 2 * 60 * 1000;

export interface PlaywrightInstallerResult {
  code: number | null;
  error?: string;
  cancelled?: boolean;
}

export interface PlaywrightInstallerSupervisor {
  result: Promise<PlaywrightInstallerResult>;
  markDownloadComplete: () => void;
}

export function supervisePlaywrightInstaller(
  child: ChildProcess,
  opts: {
    signal?: AbortSignal;
    attemptTimeoutMs?: number;
    finalizeTimeoutMs?: number;
    terminateChild?: (child: ChildProcess) => void;
  } = {},
): PlaywrightInstallerSupervisor {
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT_MS;
  const finalizeTimeoutMs = opts.finalizeTimeoutMs ?? PLAYWRIGHT_INSTALL_FINALIZE_TIMEOUT_MS;
  let settled = false;
  let finalizeTimer: NodeJS.Timeout | undefined;
  let resolveResult!: (result: PlaywrightInstallerResult) => void;

  const terminate = () => {
    if (opts.terminateChild) {
      opts.terminateChild(child);
      return;
    }
    if (child.pid) {
      killProcessTree(child.pid, "SIGKILL", {
        syncWindows: true,
        fallback: () => child.kill("SIGKILL"),
      });
    } else {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have failed before receiving a pid.
      }
    }
  };

  const finish = (result: PlaywrightInstallerResult, kill = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(attemptTimer);
    if (finalizeTimer) clearTimeout(finalizeTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (kill) terminate();
    resolveResult(result);
  };

  const onAbort = () => {
    finish({ code: null, error: "installation cancelled", cancelled: true }, true);
  };

  const result = new Promise<PlaywrightInstallerResult>((resolve) => {
    resolveResult = resolve;
  });
  const attemptTimer = setTimeout(() => {
    finish(
      {
        code: null,
        error: `installer exceeded the ${Math.round(attemptTimeoutMs / 60_000)} minute source deadline`,
      },
      true,
    );
  }, attemptTimeoutMs);

  child.once("error", (error) => finish({ code: null, error: error.message }));
  child.once("close", (code) => finish({ code }));
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    result,
    markDownloadComplete() {
      if (settled || finalizeTimer) return;
      finalizeTimer = setTimeout(() => {
        finish(
          {
            code: null,
            error: `installer stalled for ${Math.round(finalizeTimeoutMs / 60_000)} minutes after download reached 100%`,
          },
          true,
        );
      }, finalizeTimeoutMs);
    },
  };
}
