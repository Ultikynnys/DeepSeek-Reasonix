/** Codex backend transport + OAuth quota — routes gpt-* requests through
 *  chatgpt.com for plan-quota billing, and fetches rate-limit windows. */

import type { CodexQuota, CodexQuotaWindow } from "@reasonix/core-utils";
import type { ResolvedTransport } from "./client.js";
import { createLogger } from "./logging.js";
import { accountFromIdToken, resolveOpenAIToken } from "./oauth.js";

const log = createLogger("codex");

/** ChatGPT plan-quota endpoint (OpenAI Responses-API compatible). */
export const CODEX_BACKEND_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

interface CodexAuth {
  accessToken: string;
  accountId: string;
}

type CodexAuthResult =
  | { ok: true; accessToken: string; accountId: string }
  | { ok: false; reason: string };

/** Shared OAuth resolution for the model transport and the quota fetch:
 *  access_token + ChatGPT account id from the JWT, or a UI-ready reason. */
async function resolveCodexAuth(): Promise<CodexAuthResult> {
  const accessToken = await resolveOpenAIToken();
  if (!accessToken) return { ok: false, reason: "no OAuth token" };
  // Extract the ChatGPT account id from the access_token JWT claims.
  const accountId = accountFromIdToken(accessToken);
  if (!accountId) return { ok: false, reason: "no ChatGPT account id in token" };
  return { ok: true, accessToken, accountId };
}

function codexHeaders(auth: CodexAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
  };
}

/** Resolves a Codex backend transport when OAuth creds are available; null → API key fallback. */
export async function resolveCodexTransport(): Promise<ResolvedTransport | null> {
  const auth = await resolveCodexAuth();
  if (!auth.ok) {
    log.debug(`${auth.reason} — using API key fallback`);
    return null;
  }

  log.debug(`Codex backend active — account ${auth.accountId}`);
  return {
    endpoint: CODEX_BACKEND_ENDPOINT,
    headers: codexHeaders(auth),
    // The backend speaks the OpenAI Responses API — the client converts the
    // payload (input instead of messages) and parses Responses envelopes/SSE.
    api: "responses",
  };
}

// ── OAuth-based quota fetch (no codex CLI dependency) ──────────────────────

/** Official Codex usage endpoint used by the Codex client for ChatGPT accounts. */
export const CODEX_QUOTA_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
/** Kept as a compatibility fallback for older ChatGPT backend deployments. */
const LEGACY_CODEX_QUOTA_ENDPOINT = "https://chatgpt.com/backend-api/codex/rate_limits";
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function windowMinutesFromSeconds(seconds: number | undefined): number | undefined {
  return seconds !== undefined && seconds > 0 ? Math.ceil(seconds / 60) : undefined;
}

/** Normalize both the current WHAM snake_case response and the older
 *  camelCase rate_limits response into the wire format used by the ribbon. */
export function normalizeCodexWindow(raw: JsonObject): CodexQuotaWindow | null {
  const windowMinutes =
    toNumber(raw.windowDurationMins) ??
    windowMinutesFromSeconds(toNumber(raw.limit_window_seconds));
  const usedPercent = toNumber(raw.usedPercent) ?? toNumber(raw.used_percent);
  if (windowMinutes === undefined || windowMinutes <= 0 || usedPercent === undefined) return null;
  const resetsAt = toNumber(raw.resetsAt) ?? toNumber(raw.reset_at);
  return {
    windowMinutes,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: resetsAt !== undefined ? new Date(resetsAt * 1000).toISOString() : null,
  };
}

/** Parse the official `/wham/usage` payload. The backend has shipped both a
 *  root-level `{ plan_type, rate_limit }` envelope and a nested
 *  `{ rate_limits: { plan_type, rate_limit } }` envelope, so accept both
 *  without making the UI depend on a field's position. */
export function parseCodexQuotaPayload(payload: unknown): CodexQuota | null {
  const data = asObject(payload);
  if (!data) return null;
  const envelope = asObject(data.rate_limits) ?? data;
  const rateLimit =
    asObject(envelope.rate_limit) ??
    asObject(envelope.rateLimits) ??
    asObject(data.rate_limit) ??
    asObject(data.rateLimits);
  if (!rateLimit) return null;

  const windows = [
    rateLimit.primary_window ?? rateLimit.primaryWindow ?? rateLimit.primary,
    rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? rateLimit.secondary,
  ]
    .map(asObject)
    .filter((window): window is JsonObject => window !== null)
    .map(normalizeCodexWindow)
    .filter((window): window is CodexQuotaWindow => window !== null);
  if (windows.length === 0) return null;

  const planValue = [
    envelope.plan_type,
    envelope.planType,
    data.plan_type,
    data.planType,
    data.plan,
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  return {
    plan: planValue ?? null,
    fiveHour: windows.find((window) => window.windowMinutes === FIVE_HOUR_MINUTES) ?? null,
    weekly: windows.find((window) => window.windowMinutes === WEEKLY_MINUTES) ?? null,
    fetchedAt: Date.now(),
  };
}

export interface CodexQuotaResult {
  quota: CodexQuota | null;
  reason: string | null;
}

/** Fetch and parse one Codex usage endpoint. The official client uses the
 *  `codex-cli` user agent for this request; without it some deployments return
 *  a generic no-data response even when the OAuth token is valid. */
async function fetchQuotaEndpoint(
  url: string,
  auth: CodexAuth,
  signal: AbortSignal,
): Promise<CodexQuotaResult> {
  const resp = await fetch(url, {
    headers: { ...codexHeaders(auth), "User-Agent": "codex-cli" },
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const reason = `${url} returned ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
    log.debug(reason);
    return { quota: null, reason };
  }

  const quota = parseCodexQuotaPayload(await resp.json());
  if (!quota) {
    const reason = `${url} response contained no usable rate-limit windows`;
    log.debug(reason);
    return { quota: null, reason };
  }

  const windows = [quota.fiveHour, quota.weekly].filter(
    (window): window is CodexQuotaWindow => window !== null,
  );
  const detail = windows
    .map((window) => `${window.windowMinutes}m: ${window.remainingPercent}%`)
    .join(", ");
  log.debug(`Codex usage: ${detail}`);
  return { quota, reason: null };
}

/** Fetch ChatGPT plan quota via the Codex backend API using OAuth.
 *  The current Codex client reads `/wham/usage`; the legacy endpoint remains
 *  a fallback for older ChatGPT backend deployments. */
export async function fetchCodexQuotaViaOAuth(timeoutMs = 10_000): Promise<CodexQuotaResult> {
  const auth = await resolveCodexAuth();
  if (!auth.ok) return { quota: null, reason: auth.reason };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const reasons: string[] = [];

  try {
    for (const endpoint of [CODEX_QUOTA_ENDPOINT, LEGACY_CODEX_QUOTA_ENDPOINT]) {
      try {
        const result = await fetchQuotaEndpoint(endpoint, auth, ctrl.signal);
        if (result.quota) return result;
        if (result.reason) reasons.push(result.reason);
      } catch (err) {
        const reason = `${endpoint} fetch failed: ${(err as Error).message}`;
        log.debug(reason);
        reasons.push(reason);
      }
    }
    return { quota: null, reason: reasons.join("; ") || "no quota data" };
  } finally {
    clearTimeout(timer);
  }
}
