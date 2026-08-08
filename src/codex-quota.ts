/** Official ChatGPT-plan quota via the Codex app-server — account/rateLimits/read
 *  returns usage windows (usedPercent, windowDurationMins, resetsAt). */
// Requires the codex CLI installed (`npm i -g @openai/codex`) and signed in
// with the ChatGPT account; the CLI owns its credentials, so no config read.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexQuota, CodexQuotaWindow } from "@reasonix/core-utils";
import { createLogger } from "./logging.js";

const log = createLogger("codex-quota");

export const FIVE_HOUR_MINUTES = 300;
export const WEEKLY_MINUTES = 10080;

/** Cooldowns before re-spawning the codex app-server after a failed fetch.
 *  Hard failures (binary missing / spawn errors) are cached much longer —
 *  soft failures (401, network, malformed payload, timeout) only briefly. */
const HARD_FAILURE_COOLDOWN_MS = 30 * 60_000;
const SOFT_FAILURE_COOLDOWN_MS = 2 * 60_000;

interface QuotaFailureCache {
  reason: string;
  at: number;
  hard: boolean;
}

let lastFailure: QuotaFailureCache | null = null;
let lastWarnedReason: string | null = null;

/** Clear the remembered failure — lets an explicit user action (sign-in,
 *  install, click-to-retry) get a fresh attempt without waiting out the
 *  cooldown. Also resets the log-once dedupe. */
export function clearCodexQuotaCache(): void {
  lastFailure = null;
  lastWarnedReason = null;
}

/** Spawn/startup-level problems are "hard": the binary is missing or the
 *  process cannot start, so the failure will repeat identically. */
function isHardFailure(reason: string): boolean {
  return (
    reason.includes("codex app-server error") ||
    reason.includes("failed to start codex app-server") ||
    reason.includes("spawn codex")
  );
}

/** Remember a failure and log once per distinct reason — a missing codex
 *  binary must not re-log on every 60s poll. Uses debug level so it doesn't
 *  alarm users in the desktop console; the statusbar tooltip shows the reason. */
function rememberFailure(reason: string): void {
  lastFailure = { reason, at: Date.now(), hard: isHardFailure(reason) };
  if (reason !== lastWarnedReason) {
    lastWarnedReason = reason;
    log.debug(`quota fetch failed — ${reason}`);
  }
}

interface CodexRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Normalize one rate-limit window; null when required fields are missing.
 *  The single source of the official format math: remainingPercent =
 *  100 - usedPercent and resetsAt → ISO, keyed by windowMinutes. */
export function normalizeCodexWindow(raw: Record<string, unknown>): CodexQuotaWindow | null {
  const windowMinutes = toNumber(raw.windowDurationMins);
  const usedPercent = toNumber(raw.usedPercent);
  if (windowMinutes === undefined || usedPercent === undefined) return null;
  const resetsAt = toNumber(raw.resetsAt);
  return {
    windowMinutes,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: resetsAt !== undefined ? new Date(resetsAt * 1000).toISOString() : null,
  };
}

/** Minimal NDJSON JSON-RPC client over the codex app-server's stdio. */
class CodexRpcClient {
  private readonly proc: ReturnType<typeof spawn>;
  private readonly rl: ReturnType<typeof createInterface>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private closed = false;

  constructor(executable = "codex") {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      throw new Error(`failed to start codex app-server: ${(err as Error).message}`);
    }
    this.proc = proc;
    // stdio: ["pipe", ...] guarantees the streams — the nullability is a spawn typing artifact.
    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    proc.on("error", (err) => this.failAll(new Error(`codex app-server error: ${err.message}`)));
    proc.on("exit", (code) => this.failAll(new Error(`codex app-server exited (${code})`)));
  }

  private onLine(line: string): void {
    let msg: CodexRpcResponse;
    try {
      msg = JSON.parse(line) as CodexRpcResponse;
    } catch {
      return;
    }
    if (msg.id === undefined || !this.pending.has(msg.id)) return;
    const { resolve, reject } = this.pending.get(msg.id)!;
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  /** Send a request and await its response. */
  rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: Record<string, unknown> = { method, id };
    if (params !== undefined) request.params = params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Send a one-way notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    const request: Record<string, unknown> = { method };
    if (params !== undefined) request.params = params;
    this.proc.stdin!.write(`${JSON.stringify(request)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    this.proc.kill();
  }
}

export interface CodexQuotaResult {
  quota: CodexQuota | null;
  reason: string | null;
}

function buildQuota(account: unknown, limits: unknown): CodexQuota {
  const accountObj = (account as { account?: { planType?: unknown } } | undefined)?.account;
  const rateLimits = (
    limits as { rateLimits?: { primary?: unknown; secondary?: unknown } } | undefined
  )?.rateLimits;
  const windows = [rateLimits?.primary, rateLimits?.secondary]
    .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
    .map(normalizeCodexWindow)
    .filter((w): w is CodexQuotaWindow => w !== null);
  return {
    plan:
      typeof accountObj?.planType === "string" && accountObj.planType ? accountObj.planType : null,
    fiveHour: windows.find((w) => w.windowMinutes === FIVE_HOUR_MINUTES) ?? null,
    weekly: windows.find((w) => w.windowMinutes === WEEKLY_MINUTES) ?? null,
    fetchedAt: Date.now(),
  };
}

/** Weekly Codex quota via the official app-server protocol; `reason`
 *  explains a null quota for UI diagnosis. Failures are remembered (hard
 *  30 min, soft 2 min); `force` bypasses the cache for click-to-retry. */
export async function fetchCodexQuotaDetailed(
  timeoutMs = 15_000,
  opts: { force?: boolean } = {},
): Promise<CodexQuotaResult> {
  if (!opts.force && lastFailure && Date.now() - lastFailure.at < cooldownFor(lastFailure)) {
    // Remembered failure — reuse it instead of re-spawning the app-server.
    return { quota: null, reason: lastFailure.reason };
  }
  let client: CodexRpcClient;
  try {
    client = new CodexRpcClient();
  } catch (err) {
    // Binary missing / not on PATH — surfaced in the statusbar tooltip.
    rememberFailure((err as Error).message);
    return { quota: null, reason: (err as Error).message };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.close();
      reject(new Error(`codex app-server timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const quota = await Promise.race([
      (async () => {
        await client.rpc("initialize", {
          clientInfo: { name: "reasonix", title: "Reasonix", version: "1.0.0" },
        });
        client.notify("initialized");
        const account = await client.rpc("account/read", { refreshToken: false });
        const limits = await client.rpc("account/rateLimits/read");
        return buildQuota(account, limits);
      })(),
      deadline,
    ]);
    lastFailure = null;
    return { quota, reason: null };
  } catch (err) {
    const reason = (err as Error).message;
    rememberFailure(reason);
    return { quota: null, reason };
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}

function cooldownFor(failure: QuotaFailureCache): number {
  return failure.hard ? HARD_FAILURE_COOLDOWN_MS : SOFT_FAILURE_COOLDOWN_MS;
}

export async function fetchCodexQuota(timeoutMs?: number): Promise<CodexQuota | null> {
  return (await fetchCodexQuotaDetailed(timeoutMs)).quota;
}
