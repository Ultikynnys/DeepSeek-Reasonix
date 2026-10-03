/** Codex backend transport + OAuth quota — routes gpt-* requests through
 *  chatgpt.com for plan-quota billing, and fetches rate-limit windows. */

import type { CodexQuota, CodexQuotaWindow } from "@reasonix/core-utils";
import type { ResolvedTransport } from "./client.js";
import { createLogger } from "./logging.js";
import { accountFromIdToken, resolveOpenAIToken } from "./oauth.js";

const log = createLogger("codex");

/** ChatGPT plan-quota endpoint (OpenAI Responses-API compatible). */
const CODEX_BACKEND_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

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

// ── Image generation via the hosted `image_generation` tool ─────────────────

/** Model that exposes the hosted `image_generation` tool on the ChatGPT/Codex
 *  backend. Image support is model-specific, so we do NOT reuse the chat model
 *  id; override with REASONIX_IMAGE_MODEL when the default drifts. */
export const DEFAULT_IMAGE_MODEL = "gpt-5.5";

/** Resolved image model: env override > DEFAULT_IMAGE_MODEL. */
export function imageModel(): string {
  return process.env.REASONIX_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
}

export interface GenerateImageOptions {
  prompt: string;
  size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  quality?: "auto" | "low" | "medium" | "high";
  background?: "auto" | "transparent" | "opaque";
  /** Override the image model (defaults to `imageModel()`). */
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the `~/.reasonix/config.json` lookup — primarily for tests. */
  configPath?: string;
}

export type GenerateImageResult =
  | { ok: true; pngBase64: string; model: string }
  | { ok: false; reason: string };

interface ImageGenerationPayload {
  model: string;
  instructions: string;
  input: Array<{
    type: "message";
    role: "user";
    content: Array<{ type: "input_text"; text: string }>;
  }>;
  tools: Array<{
    type: "image_generation";
    output_format: "png";
    size: string;
    quality: string;
    background: string;
  }>;
  tool_choice: { type: "image_generation" };
  parallel_tool_calls: boolean;
  reasoning: null;
  store: boolean;
  stream: boolean;
  include: unknown[];
  prompt_cache_key: string;
  client_metadata: Record<string, string>;
}

/** Responses payload that forces the hosted image tool (mirrors the Codex CLI /
 *  codex-imagegen contract we verified live against a Plus account). */
function buildImagePayload(opts: GenerateImageOptions, model: string): ImageGenerationPayload {
  return {
    model,
    instructions:
      "Use the available image generation tool to generate exactly one PNG image for the user request. Do not use any other tool.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: opts.prompt }] },
    ],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        size: opts.size ?? "auto",
        quality: opts.quality ?? "auto",
        background: opts.background ?? "auto",
      },
    ],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: "reasonix-image-gen",
    client_metadata: { "x-codex-installation-id": "reasonix" },
  };
}

/** Recursively locate an `image_generation_call` result (base64 PNG) anywhere in
 *  a decoded Responses event — the item sits under response.output / output_item. */
function findImageResult(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageResult(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as JsonObject;
    if (obj.type === "image_generation_call" && typeof obj.result === "string" && obj.result) {
      return obj.result;
    }
    for (const item of Object.values(obj)) {
      const found = findImageResult(item);
      if (found) return found;
    }
  }
  return null;
}

/** Read the Responses SSE body and return the base64 PNG from the first
 *  `image_generation_call` frame. Line-based `data:` parsing — no SSE dependency. */
async function readImageFromSse(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: string | null = null;
  try {
    while (!result) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              result = findImageResult(JSON.parse(data));
            } catch {
              /* keep-alive or non-JSON frame */
            }
          }
        }
        if (result) break;
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}

/** Generate one image through the Codex backend using the stored OpenAI OAuth.
 *  Bills against the account's plan quota — same surface as the chat models. */
export async function generateImageViaCodex(
  opts: GenerateImageOptions,
): Promise<GenerateImageResult> {
  const accessToken = await resolveOpenAIToken(opts.configPath);
  if (!accessToken) {
    return { ok: false, reason: "no OpenAI OAuth session — sign in with OpenAI in Settings" };
  }
  const accountId = accountFromIdToken(accessToken);
  if (!accountId) {
    return { ok: false, reason: "no ChatGPT account id in the OAuth token" };
  }

  const model = opts.model?.trim() || imageModel();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const resp = await fetch(CODEX_BACKEND_ENDPOINT, {
      method: "POST",
      headers: {
        ...codexHeaders({ accessToken, accountId }),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(buildImagePayload(opts, model)),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        reason: `image backend returned ${resp.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      };
    }
    if (!resp.body) return { ok: false, reason: "image backend returned no response body" };
    const pngBase64 = await readImageFromSse(resp.body);
    if (!pngBase64) return { ok: false, reason: "image backend returned no image" };
    return { ok: true, pngBase64, model };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      return {
        ok: false,
        reason: opts.signal?.aborted ? "cancelled" : `image generation timed out (${timeoutMs}ms)`,
      };
    }
    return { ok: false, reason: e.message };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ── OAuth-based quota fetch (no codex CLI dependency) ──────────────────────

/** Official Codex usage endpoint used by the Codex client for ChatGPT accounts. */
const CODEX_QUOTA_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
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
function normalizeCodexWindow(raw: JsonObject): CodexQuotaWindow | null {
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

/** Parse `/wham/usage` — accepts both root-level `{plan_type, rate_limit}` and
 *  nested `{rate_limits: {plan_type, rate_limit}}` envelopes. */
function parseCodexQuotaPayload(payload: unknown): CodexQuota | null {
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
