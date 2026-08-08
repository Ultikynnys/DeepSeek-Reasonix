/** Codex backend transport + OAuth quota — routes gpt-* requests through
 *  chatgpt.com for plan-quota billing, and fetches rate-limit windows. */

import type { CodexQuota, CodexQuotaWindow } from "@reasonix/core-utils";
import type { ResolvedTransport } from "./client.js";
import { createLogger } from "./logging.js";
import { accountFromIdToken, resolveOpenAIToken } from "./oauth.js";

const log = createLogger("codex");

/** ChatGPT plan-quota endpoint (OpenAI Responses-API compatible). */
export const CODEX_BACKEND_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/** Resolves a Codex backend transport when OAuth creds are available; null → API key fallback. */
export async function resolveCodexTransport(): Promise<ResolvedTransport | null> {
  const accessToken = await resolveOpenAIToken();
  if (!accessToken) {
    log.debug("no OAuth token available — using API key fallback");
    return null;
  }

  // Extract the ChatGPT account id from the access_token JWT claims.
  const accountId = accountFromIdToken(accessToken);
  if (!accountId) {
    log.debug("OAuth token present but no ChatGPT account id — using API key fallback");
    return null;
  }

  log.debug(`Codex backend active — account ${accountId}`);
  return {
    endpoint: CODEX_BACKEND_ENDPOINT,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
    },
  };
}

// ── OAuth-based quota fetch (no codex CLI dependency) ──────────────────────

const CODEX_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizeWindow(raw: Record<string, unknown>): CodexQuotaWindow | null {
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

export interface CodexQuotaResult {
  quota: CodexQuota | null;
  reason: string | null;
}

/** Fetch ChatGPT plan quota via the Codex backend API using OAuth.
 *  Returns null when OAuth isn't available or the endpoint is unreachable —
 *  callers fall back to the codex CLI path. */
export async function fetchCodexQuotaViaOAuth(timeoutMs = 10_000): Promise<CodexQuotaResult> {
  const accessToken = await resolveOpenAIToken();
  if (!accessToken) return { quota: null, reason: "no OAuth token" };

  const accountId = accountFromIdToken(accessToken);
  if (!accountId) return { quota: null, reason: "no ChatGPT account id in token" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(CODEX_RATE_LIMITS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
      },
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.debug(`rate_limits HTTP ${resp.status}: ${body.slice(0, 200)}`);
      return { quota: null, reason: `rate_limits returned ${resp.status}` };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const rateLimits = (data as { rateLimits?: { primary?: unknown; secondary?: unknown } })
      ?.rateLimits;

    const windows = [rateLimits?.primary, rateLimits?.secondary]
      .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
      .map(normalizeWindow)
      .filter((w): w is CodexQuotaWindow => w !== null);

    const detail = windows.map((w) => `${w.windowMinutes}m: ${w.remainingPercent}%`).join(", ");
    log.debug(`rate_limits: ${windows.length} windows — ${detail}`);

    return {
      quota: {
        plan: null,
        fiveHour: windows.find((w) => w.windowMinutes === FIVE_HOUR_MINUTES) ?? null,
        weekly: windows.find((w) => w.windowMinutes === WEEKLY_MINUTES) ?? null,
        fetchedAt: Date.now(),
      },
      reason: null,
    };
  } catch (err) {
    const reason = `rate_limits fetch failed: ${(err as Error).message}`;
    log.debug(reason);
    return { quota: null, reason };
  } finally {
    clearTimeout(timer);
  }
}
