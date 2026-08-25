/** Google Antigravity OAuth (client-secret flow) — browser sign-in powers
 *  gemini-* models through the Cloud Code API on the Antigravity quota. */

import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import {
  type AntigravityOAuthCreds,
  clearAntigravityOAuth,
  defaultConfigPath,
  readConfig,
  saveAntigravityOAuth,
} from "./config.js";

/** OAuth client for the Antigravity/Gemini CLI flow — client id/secret are
 *  passed in as input parameters (see loadAntigravityOAuthClient). */

export const ANTIGRAVITY_DEFAULT_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_DEFAULT_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
/** Cloud Code API — onboarding (tier/project resolution) and model calls. */
export const ANTIGRAVITY_CLOUD_CODE_URL = "https://cloudcode-pa.googleapis.com";

const DEFAULT_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const REFRESH_SLACK_MS = 5 * 60_000;
const OAUTH_FLOW_TIMEOUT_MS = 10 * 60_000;
/** Callback path the Google OAuth client allowlists. */
const OAUTH_CALLBACK_PATH = "/oauth2callback";

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
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scope ?? envOr(DEFAULT_SCOPE, "ANTIGRAVITY_OAUTH_SCOPE"),
    state: p.state,
    // Offline access yields a refresh_token so the session survives expiry.
    access_type: "offline",
    prompt: "consent",
  });
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
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : Date.now() + 10 * 60_000,
  };
}

export async function exchangeAntigravityCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<AntigravityOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  return toCreds(await postTokenForm(antigravityTokenUrl(), body), "");
}

export async function refreshAntigravityToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<AntigravityOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
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

/** A usable Google access token — refreshes from the stored refresh token when
 *  expired or within 5 min of expiry. Undefined when no OAuth creds exist or
 *  refresh fails (callers fall back to a static key or error). */
export async function resolveAntigravityToken(
  path: string = defaultConfigPath(),
  clientId?: string,
  clientSecret?: string,
): Promise<string | undefined> {
  const creds = readConfig(path).antigravityOAuth;
  if (!creds?.accessToken) return undefined;
  if (!creds.refreshToken || creds.expiresAt - Date.now() > REFRESH_SLACK_MS)
    return creds.accessToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next = await refreshAntigravityToken(
        creds.refreshToken,
        clientId ?? "",
        clientSecret ?? "",
      );
      saveAntigravityOAuth({ ...next, account: creds.account, projectId: creds.projectId }, path);
      return next.accessToken;
    } catch (err) {
      console.warn(`reasonix: Antigravity OAuth refresh failed — ${(err as Error).message}`);
      return undefined;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ── Cloud Code onboarding (Starter tier + project id) ─────────────────────

interface ClientMetadata {
  ideType?: string;
  platform?: string;
  pluginType?: string;
}

interface LoadCodeAssistResponse {
  currentTier?: { id?: string } | null;
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }> | null;
  ineligibleTiers?: Array<{ reasonMessage?: string }> | null;
  cloudaicompanionProject?: string | null;
}

interface OnboardUserResponse {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
  error?: { code?: number; message?: string };
}

function platformName(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "DARWIN_ARM64" : "DARWIN_AMD64";
  if (p === "linux") return a === "arm64" ? "LINUX_ARM64" : "LINUX_AMD64";
  if (p === "win32") return "WINDOWS_AMD64";
  return "PLATFORM_UNSPECIFIED";
}

function clientMetadata(): ClientMetadata {
  return { ideType: "IDE_UNSPECIFIED", platform: platformName(), pluginType: "GEMINI" };
}

async function parseCloudCodeResponse<T>(res: Response, method: string): Promise<T> {
  const text = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new Error(`Cloud Code ${method} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Cloud Code ${method} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return parsed;
}

async function cloudCodePost<T>(accessToken: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${ANTIGRAVITY_CLOUD_CODE_URL}/v1internal:${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  return parseCloudCodeResponse<T>(res, method);
}

async function cloudCodeGetOperation<T>(accessToken: string, name: string): Promise<T> {
  const res = await fetch(`${ANTIGRAVITY_CLOUD_CODE_URL}/v1internal/${name}`, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  return parseCloudCodeResponse<T>(res, "getOperation");
}

const ONBOARD_POLL_INTERVAL_MS = 5_000;
const ONBOARD_MAX_POLLS = 60;

function onboardingProject(op: OnboardUserResponse): string | undefined {
  if (op.error) {
    throw new Error(
      `Antigravity onboarding failed${op.error.code ? ` (${op.error.code})` : ""}: ${op.error.message ?? "unknown error"}`,
    );
  }
  return op.response?.cloudaicompanionProject?.id;
}

async function loadCodeAssist(
  accessToken: string,
  metadata: ClientMetadata,
): Promise<LoadCodeAssistResponse> {
  return cloudCodePost<LoadCodeAssistResponse>(accessToken, "loadCodeAssist", {
    cloudaicompanionProject: undefined,
    metadata,
  });
}

/** Resolve the managed Cloud Code companion project used for Gemini quota. */
export async function onboardAntigravity(accessToken: string): Promise<string> {
  const metadata = clientMetadata();
  const load = await loadCodeAssist(accessToken, metadata);

  if (load.currentTier) {
    if (load.cloudaicompanionProject) return load.cloudaicompanionProject;
    throw new Error("Antigravity account is onboarded but has no companion project");
  }

  const tiers = load.allowedTiers ?? [];
  const tier = tiers.find((candidate) => candidate.isDefault) ?? tiers[0];
  if (!tier?.id) {
    const reasons = (load.ineligibleTiers ?? [])
      .map((candidate) => candidate.reasonMessage)
      .filter((reason): reason is string => Boolean(reason));
    throw new Error(
      reasons.length > 0
        ? `Antigravity account is not eligible: ${reasons.join(", ")}`
        : "Antigravity account has no eligible Gemini tier",
    );
  }

  let op = await cloudCodePost<OnboardUserResponse>(accessToken, "onboardUser", {
    tierId: tier.id,
    cloudaicompanionProject: undefined,
    metadata,
  });
  let projectId = onboardingProject(op);
  if (projectId) return projectId;
  if (!op.done && !op.name) {
    throw new Error("Antigravity onboarding returned an incomplete operation without a name");
  }

  for (let poll = 0; !op.done && poll < ONBOARD_MAX_POLLS; poll++) {
    if (!op.name) {
      throw new Error("Antigravity onboarding returned an incomplete operation without a name");
    }
    if (poll > 0) {
      await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
    }
    op = await cloudCodeGetOperation<OnboardUserResponse>(accessToken, op.name);
    projectId = onboardingProject(op);
    if (projectId) return projectId;
  }

  if (!op.done) throw new Error("Antigravity onboarding timed out");

  const reloaded = await loadCodeAssist(accessToken, metadata);
  if (reloaded.cloudaicompanionProject) return reloaded.cloudaicompanionProject;
  throw new Error("Antigravity onboarding completed without a companion project");
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
export async function beginAntigravityOAuthFlow(opts: {
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}): Promise<OAuthFlow> {
  const state = randomOAuthState();
  const timeoutMs = opts.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (creds: AntigravityOAuthCreds) => void = () => {};
  let rejectDone: (err: Error) => void = () => {};
  const done = new Promise<AntigravityOAuthCreds>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const envRedirect = process.env.ANTIGRAVITY_OAUTH_REDIRECT_URI?.trim();
  let redirectUri = envRedirect ?? `http://localhost:0${OAUTH_CALLBACK_PATH}`;

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
    void exchangeAntigravityCode({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri,
      code,
    })
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
      server.listen(port);
    });

  let port = 0;
  try {
    await listen(port);
  } catch {
    throw new Error("Antigravity OAuth callback server failed to bind");
  }
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("OAuth callback server failed to bind");
  port = addr.port;
  if (!envRedirect) redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;

  const url = buildAuthorizeUrl({
    clientId: opts.clientId,
    redirectUri,
    state,
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
