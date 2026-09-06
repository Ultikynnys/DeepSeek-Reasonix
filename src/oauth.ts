/** OpenAI website-account OAuth (PKCE) — browser sign-in powers gpt-5.6
 *  requests; client_id / endpoints env-overridable. */

import {
  type OpenAIOAuthCreds,
  clearOpenAIOAuth,
  defaultConfigPath,
  readConfig,
  saveOpenAIOAuth,
} from "./config.js";
import {
  type LocalhostOAuthFlow,
  type TokenResponse,
  beginLocalhostOAuthFlow,
  envOr,
  fetchUserEmail,
  isTokenFresh,
  makePkcePair,
  postTokenForm,
} from "./oauth-shared.js";

export const OPENAI_DEFAULT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_DEFAULT_REVOKE_URL = "https://auth.openai.com/oauth/revoke";
export const OPENAI_DEFAULT_USERINFO_URL = "https://auth.openai.com/oauth/userinfo";
/** Current Codex CLI OAuth client — the old ChatGPT desktop client id
 *  (DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD) was revoked by OpenAI: invalid_client /
 *  "This app is unavailable", reproduced live 2026-08. Env-overridable. */
export const OPENAI_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DEFAULT_SCOPE = "openid profile email offline_access";
/** Callback port the Codex client allowlists (mirrors the Codex CLI / opencode). */
const OAUTH_CALLBACK_PORT = 1455;
const OAUTH_CALLBACK_PATH = "/auth/callback";

export function openAIAuthorizeUrl(): string {
  return envOr(OPENAI_DEFAULT_AUTHORIZE_URL, "OPENAI_AUTH_URL");
}

export function openAITokenUrl(): string {
  return envOr(OPENAI_DEFAULT_TOKEN_URL, "OPENAI_TOKEN_URL");
}

export function openAIRevokeUrl(): string {
  return envOr(OPENAI_DEFAULT_REVOKE_URL, "OPENAI_REVOKE_URL");
}

export function openAIUserinfoUrl(): string {
  return envOr(OPENAI_DEFAULT_USERINFO_URL, "OPENAI_USERINFO_URL");
}

export function openAIClientId(): string {
  return envOr(OPENAI_DEFAULT_CLIENT_ID, "OPENAI_OAUTH_CLIENT_ID");
}

/** RFC 7636 PKCE pair — verifier is 64 random bytes, challenge is S256. */
export function pkcePair(): { verifier: string; challenge: string } {
  return makePkcePair(64);
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
  audience?: string;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    state: p.state,
    scope: p.scope ?? envOr(DEFAULT_SCOPE, "OPENAI_OAUTH_SCOPE"),
    // Matches the Codex CLI flow (opencode): simplified consent, and orgs in
    // the id_token so the account id survives without a userinfo round-trip.
    codex_cli_simplified_flow: "true",
    id_token_add_organizations: "true",
    originator: "reasonix",
  });
  const audience = p.audience ?? process.env.OPENAI_OAUTH_AUDIENCE?.trim();
  if (audience) q.set("audience", audience);
  return `${openAIAuthorizeUrl()}?${q.toString()}`;
}

/** OpenAI account id from JWT claims (id_token or access_token) — the Codex
 *  family tokens carry chatgpt_account_id / organizations instead of email. */
export function accountFromIdToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      chatgpt_account_id?: string;
      organizations?: Array<{ id?: string }>;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return (
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id
    );
  } catch {
    return undefined;
  }
}

function toCreds(parsed: TokenResponse, fallbackRefresh: string): OpenAIOAuthCreds {
  return {
    accessToken: parsed.access_token as string,
    refreshToken: parsed.refresh_token ?? fallbackRefresh,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : Date.now() + 10 * 60_000,
    account: accountFromIdToken(parsed.id_token) ?? accountFromIdToken(parsed.access_token),
  };
}

export async function exchangeOAuthCode(opts: {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<OpenAIOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  return toCreds(await postTokenForm(openAITokenUrl(), body), "");
}

export async function refreshOAuthToken(
  refreshToken: string,
  clientId: string,
): Promise<OpenAIOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  return toCreds(await postTokenForm(openAITokenUrl(), body), refreshToken);
}

/** Best-effort revocation — local state clears regardless of upstream result. */
export async function revokeOAuthToken(token: string, clientId: string): Promise<void> {
  try {
    const body = new URLSearchParams({
      token,
      client_id: clientId,
      token_type_hint: "access_token",
    });
    await fetch(openAIRevokeUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    /* offline or refused — nothing to do */
  }
}

/** Account email from userinfo, for the settings card. Undefined on failure. */
export async function oauthAccount(accessToken: string): Promise<string | undefined> {
  return fetchUserEmail(openAIUserinfoUrl(), accessToken);
}

let refreshInFlight: Promise<string | undefined> | null = null;

/** A usable OpenAI access token — refreshes from the stored refresh token
 *  when expired or within 5 min of expiry. Undefined when no OAuth creds
 *  exist or refresh fails (callers fall back to their static key). */
export async function resolveOpenAIToken(
  path: string = defaultConfigPath(),
): Promise<string | undefined> {
  const creds = readConfig(path).openaiOAuth;
  if (!creds?.accessToken) return undefined;
  if (isTokenFresh(creds.expiresAt, creds.refreshToken)) return creds.accessToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next = await refreshOAuthToken(creds.refreshToken, openAIClientId());
      saveOpenAIOAuth(next, path);
      return next.accessToken;
    } catch (err) {
      console.warn(`reasonix: OpenAI OAuth refresh failed — ${(err as Error).message}`);
      return undefined;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export interface OAuthFlow extends LocalhostOAuthFlow<OpenAIOAuthCreds> {}

function redirectPort(uri: string): number {
  try {
    const parsed = new URL(uri);
    return parsed.port ? Number(parsed.port) : OAUTH_CALLBACK_PORT;
  } catch {
    return OAUTH_CALLBACK_PORT;
  }
}

/** Starts the browser OAuth dance: PKCE + state, a one-shot localhost
 *  callback server on the Codex client's allowlisted port, and the authorize
 *  URL. `done` rejects on error, cancel, or the 10-minute timeout. */
export async function beginOAuthFlow(
  opts: { timeoutMs?: number } = {},
): Promise<LocalhostOAuthFlow<OpenAIOAuthCreds>> {
  const { verifier, challenge } = pkcePair();
  const envRedirect = process.env.OPENAI_OAUTH_REDIRECT_URI?.trim();
  const port = envRedirect ? redirectPort(envRedirect) : OAUTH_CALLBACK_PORT;
  const redirectUri = envRedirect ?? `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
  return beginLocalhostOAuthFlow<OpenAIOAuthCreds>({
    callbackPath: OAUTH_CALLBACK_PATH,
    redirectUri,
    port,
    timeoutMs: opts.timeoutMs,
    successTitle: "Signed in",
    successHeading: "Signed in to OpenAI",
    stateMismatchMessage: "State mismatch — this sign-in attempt is invalid. Retry from Reasonix.",
    allowPortFallback: true,
    redirectUriForPort: envRedirect
      ? undefined
      : (p) => `http://localhost:${p}${OAUTH_CALLBACK_PATH}`,
    buildUrl: (uri, state) =>
      buildAuthorizeUrl({
        clientId: openAIClientId(),
        redirectUri: uri,
        state,
        codeChallenge: challenge,
      }),
    exchange: (code, uri) =>
      exchangeOAuthCode({ clientId: openAIClientId(), redirectUri: uri, code, verifier }),
    timeoutMessage: "OAuth sign-in timed out — retry from settings",
  });
}

/** Convenience for sign-out: revoke (best-effort) then wipe local creds. */
export async function signOutOpenAI(path: string = defaultConfigPath()): Promise<void> {
  const creds = readConfig(path).openaiOAuth;
  if (creds?.accessToken) await revokeOAuthToken(creds.accessToken, openAIClientId());
  clearOpenAIOAuth(path);
}
