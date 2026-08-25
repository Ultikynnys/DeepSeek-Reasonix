/** Google Antigravity OAuth (client-secret flow) — browser sign-in powers
 *  gemini-* models through the Cloud Code API on the Antigravity quota. */

import { createHash, randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import {
  type AntigravityOAuthCreds,
  clearAntigravityOAuth,
  defaultConfigPath,
  readConfig,
  saveAntigravityOAuth,
} from "./config.js";

/** Published installed-app OAuth identity used by Google Antigravity. */
export const ANTIGRAVITY_OAUTH_CLIENT_ID =
  "it1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET = "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";

export const ANTIGRAVITY_DEFAULT_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_DEFAULT_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
export const ANTIGRAVITY_CLOUD_CODE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_CLOUD_CODE_API = `${ANTIGRAVITY_CLOUD_CODE_URL}/v1internal`;

const DEFAULT_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

const REFRESH_SLACK_MS = 5 * 60_000;
const OAUTH_FLOW_TIMEOUT_MS = 10 * 60_000;
const ONBOARD_TIMEOUT_MS = 10 * 60_000;
const ONBOARD_POLL_INTERVAL_MS = 5_000;
/** Registered callback used by the Antigravity installed application. */
const OAUTH_CALLBACK_PATH = "/oauth-callback";
const OAUTH_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

function envOr(def: string, name: string): string {
  const v = process.env[name]?.trim();
  return v ? v : def;
}

export function antigravityAuthorizeUrl(): string {
  return envOr(ANTIGRAVITY_DEFAULT_AUTHORIZE_URL, "ANTIGRAVITY_AUTH_URL");
}

export function antigravityTokenUrl(): string {
  return envOr(ANTIGRAVITY_DEFAULT_TOKEN_URL, "ANTIGRAVITY_TOKEN_URL");
}

export function antigravityUserinfoUrl(): string {
  return envOr(ANTIGRAVITY_DEFAULT_USERINFO_URL, "ANTIGRAVITY_USERINFO_URL");
}

export function randomOAuthState(): string {
  return randomBytes(24).toString("hex");
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
  codeChallenge?: string;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scope ?? envOr(DEFAULT_SCOPE, "ANTIGRAVITY_OAUTH_SCOPE"),
    state: p.state,
    access_type: "offline",
    prompt: "consent",
  });
  if (p.codeChallenge) {
    q.set("code_challenge", p.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  return `${antigravityAuthorizeUrl()}?${q.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postTokenForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`OAuth token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.error) {
    throw new Error(
      `OAuth token exchange failed (${res.status}): ${parsed.error_description ?? parsed.error ?? text.slice(0, 200)}`,
    );
  }
  if (!parsed.access_token) throw new Error("OAuth token endpoint returned no access_token");
  return parsed;
}

function toCreds(parsed: TokenResponse, fallbackRefresh: string): AntigravityOAuthCreds {
  return {
    accessToken: parsed.access_token as string,
    refreshToken: parsed.refresh_token ?? fallbackRefresh,
    clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : Date.now() + 10 * 60_000,
  };
}

export async function exchangeAntigravityCode(opts: {
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<AntigravityOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return toCreds(await postTokenForm(antigravityTokenUrl(), body), "");
}

export async function refreshAntigravityToken(
  refreshToken: string,
): Promise<AntigravityOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  return toCreds(await postTokenForm(antigravityTokenUrl(), body), refreshToken);
}

/** Account email from userinfo, for the settings card. Undefined on failure. */
export async function antigravityAccount(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(antigravityUserinfoUrl(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { email?: string };
    return info.email;
  } catch {
    return undefined;
  }
}

let refreshInFlight: Promise<string | undefined> | null = null;

/** A usable Google access token. Refresh failures are surfaced to the caller so
 *  an invalid or revoked credential is never misreported as a missing sign-in. */
export async function resolveAntigravityToken(
  path: string = defaultConfigPath(),
): Promise<string | undefined> {
  const creds = readConfig(path).antigravityOAuth;
  if (!creds?.accessToken) return undefined;
  if (creds.clientId !== ANTIGRAVITY_OAUTH_CLIENT_ID) {
    clearAntigravityOAuth(path);
    throw new Error("Stored Antigravity OAuth credentials use an obsolete client; sign in again");
  }
  if (!creds.refreshToken || creds.expiresAt - Date.now() > REFRESH_SLACK_MS)
    return creds.accessToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next = await refreshAntigravityToken(creds.refreshToken);
      saveAntigravityOAuth(
        { ...next, account: creds.account, projectId: creds.projectId, models: creds.models },
        path,
      );
      return next.accessToken;
    } catch (err) {
      throw new Error(`Antigravity OAuth refresh failed: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ── Antigravity project discovery ──────────────────────────────────────────

interface AntigravityTier {
  id?: string;
  isDefault?: boolean;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string } | null;
  currentTier?: AntigravityTier | null;
  allowedTiers?: AntigravityTier[] | null;
  ineligibleTiers?: Array<{ reasonCode?: string; reasonMessage?: string }> | null;
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?: { cloudaicompanionProject?: { id?: string } };
}

export interface AntigravityModel {
  id: string;
  displayName: string;
  maxTokens?: number;
  maxOutputTokens?: number;
}

interface UserQuotaResponse {
  buckets?: Array<{ modelId?: string }> | null;
}

/** Static metadata expected by the Antigravity Code Assist flow. It intentionally
 *  matches the maintained Windows client even when Reasonix runs elsewhere. */
const CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "WINDOWS_AMD64",
  pluginType: "GEMINI",
  ideName: "antigravity",
} as const;

export function antigravityHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "antigravity",
  };
}

async function antigravityPost<T>(
  accessToken: string,
  method: string,
  payload: unknown,
): Promise<T> {
  const res = await fetch(`${ANTIGRAVITY_CLOUD_CODE_API}:${method}`, {
    method: "POST",
    headers: antigravityHeaders(accessToken),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${method} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

function projectFromLoad(data: LoadCodeAssistResponse): string | undefined {
  if (typeof data.cloudaicompanionProject === "string") {
    return data.cloudaicompanionProject || undefined;
  }
  return data.cloudaicompanionProject?.id || undefined;
}

/** Resolve the account's managed project, provisioning the eligible free tier when needed. */
export async function onboardAntigravity(accessToken: string): Promise<string> {
  const load = await antigravityPost<LoadCodeAssistResponse>(accessToken, "loadCodeAssist", {
    metadata: CLIENT_METADATA,
    mode: "FULL_ELIGIBILITY_CHECK",
  });
  const existingProject = projectFromLoad(load);
  if (existingProject) return existingProject;
  if (load.currentTier) {
    throw new Error("Code Assist reports an existing tier but did not return its managed project");
  }
  const tier = (load.allowedTiers ?? []).find((candidate) => candidate.isDefault);
  if (!tier) {
    const reasons = (load.ineligibleTiers ?? []).map(
      (item) => item.reasonMessage ?? item.reasonCode ?? "unknown reason",
    );
    throw new Error(
      `No eligible default Code Assist tier was returned${reasons.length ? `: ${reasons.join("; ")}` : ""}`,
    );
  }
  if (tier.id !== "free-tier") {
    throw new Error(`Default Code Assist tier is ${JSON.stringify(tier.id)}, not the free tier`);
  }

  let operation = await antigravityPost<OnboardOperation>(accessToken, "onboardUser", {
    tierId: tier.id,
    metadata: CLIENT_METADATA,
  });
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  while (!operation.done && operation.name) {
    if (Date.now() >= deadline) throw new Error("Code Assist onboarding timed out");
    await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
    const segments = operation.name.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Code Assist onboarding returned an invalid operation name");
    }
    const name = segments.map((segment) => encodeURIComponent(segment)).join("/");
    const res = await fetch(`${ANTIGRAVITY_CLOUD_CODE_API}/${name}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Code Assist onboarding poll failed (${res.status}): ${await res.text()}`);
    }
    operation = (await res.json()) as OnboardOperation;
  }
  if (operation.error) {
    throw new Error(
      `Code Assist onboarding failed: ${operation.error.message ?? JSON.stringify(operation.error)}`,
    );
  }
  const projectId = operation.response?.cloudaicompanionProject?.id;
  if (!projectId) throw new Error("Onboarding completed without a managed project ID");
  return projectId;
}

/** Fetch the exact model ids advertised by the account's quota buckets. */
export async function fetchAntigravityModels(
  accessToken: string,
  projectId: string,
): Promise<AntigravityModel[]> {
  const quota = await antigravityPost<UserQuotaResponse>(accessToken, "retrieveUserQuota", {
    project: projectId,
  });
  const ids = new Set(
    (quota.buckets ?? []).flatMap((bucket) => {
      const id = bucket.modelId?.trim();
      return id ? [id] : [];
    }),
  );
  if (ids.size === 0) throw new Error("Antigravity quota returned no model ids");
  return [...ids].sort().map((id) => ({ id, displayName: id }));
}

// ── Browser OAuth flow ─────────────────────────────────────────────────────

export interface OAuthFlow {
  /** Authorize URL to open in the system browser. */
  url: string;
  /** Resolves with exchanged tokens; rejects on error / cancel / timeout. */
  done: Promise<AntigravityOAuthCreds>;
  cancel: () => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;max-width:34em;margin:4em auto;line-height:1.6">
<h2>Signed in to Google</h2><p>You can close this window and return to Reasonix.</p></body></html>`;

function errorPage(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui;max-width:34em;margin:4em auto;line-height:1.6">
<h2>Sign-in failed</h2><p>${escapeHtml(msg)}</p>
<p>You can close this window and retry from Reasonix.</p></body></html>`;
}

/** Starts the browser OAuth dance: a one-shot localhost callback server and the
 *  authorize URL. `done` rejects on error, cancel, or the 10-minute timeout. */
export async function beginAntigravityOAuthFlow(
  opts: {
    timeoutMs?: number;
  } = {},
): Promise<OAuthFlow> {
  const state = randomOAuthState();
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const timeoutMs = opts.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (creds: AntigravityOAuthCreds) => void = () => {};
  let rejectDone: (err: Error) => void = () => {};
  const done = new Promise<AntigravityOAuthCreds>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const redirectUri =
    process.env.ANTIGRAVITY_OAUTH_REDIRECT_URI?.trim() || ANTIGRAVITY_REDIRECT_URI;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn();
    server.closeIdleConnections();
    server.close(() => {});
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404).end("Not found");
      return;
    }
    const q = url.searchParams;
    if (q.get("error")) {
      const msg = q.get("error_description") ?? q.get("error") ?? "access_denied";
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(errorPage(msg));
      settle(() => rejectDone(new Error(`OAuth sign-in failed: ${msg}`)));
      return;
    }
    const code = q.get("code");
    if (!code || q.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(errorPage("State mismatch — this sign-in attempt is invalid. Retry from settings."));
      settle(() => rejectDone(new Error("OAuth state mismatch")));
      return;
    }
    void exchangeAntigravityCode({ redirectUri, code, codeVerifier })
      .then((creds) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(SUCCESS_PAGE);
        settle(() => resolveDone(creds));
      })
      .catch((err: unknown) => {
        const msg = (err as Error).message;
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage(msg));
        settle(() => rejectDone(err as Error));
      });
  });
  server.on("error", () => {
    /* surfaced via the listening promise / settle-close */
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        resolve();
      });
      server.listen(port, "localhost");
    });

  const callbackPort = Number(new URL(redirectUri).port);
  if (!Number.isInteger(callbackPort) || callbackPort <= 0) {
    throw new Error("Antigravity OAuth redirect URI must include a valid callback port");
  }
  try {
    await listen(callbackPort);
  } catch {
    throw new Error(`Antigravity OAuth callback server failed to bind port ${callbackPort}`);
  }

  const url = buildAuthorizeUrl({
    clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge,
  });

  timer = setTimeout(() => {
    settle(() => rejectDone(new Error("OAuth sign-in timed out — retry from settings")));
  }, timeoutMs);

  return {
    url,
    done,
    cancel: () => settle(() => rejectDone(new Error("OAuth sign-in cancelled"))),
  };
}

/** Convenience for sign-out: wipe local creds (Google has no simple revoke
 *  endpoint for this client; local state clears regardless). */
export async function signOutAntigravity(path: string = defaultConfigPath()): Promise<void> {
  clearAntigravityOAuth(path);
}
