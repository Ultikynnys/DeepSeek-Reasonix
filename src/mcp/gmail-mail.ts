import {
  type GmailOAuthCreds,
  clearGmailOAuth,
  defaultConfigPath,
  readConfig,
  saveGmailOAuth,
} from "../config.js";
import {
  type LocalhostOAuthFlow,
  type TokenResponse,
  beginLocalhostOAuthFlow,
  fetchUserEmail,
  isTokenFresh,
  makePkcePair,
  postTokenForm,
} from "../oauth-shared.js";
import type { McpServerSpec } from "./spec.js";

export const GMAIL_MAIL_SERVER_NAME = "gmail_mail";
export const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const GMAIL_OAUTH_CALLBACK_PATH = "/oauth/gmail/callback";
export const GMAIL_OAUTH_CALLBACK_PORT = 50511;
export const GMAIL_OAUTH_REDIRECT_URI = `http://localhost:${GMAIL_OAUTH_CALLBACK_PORT}${GMAIL_OAUTH_CALLBACK_PATH}`;
export const GMAIL_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export function isGmailMailSpec(spec: McpServerSpec): boolean {
  return (
    spec.transport === "streamable-http" &&
    spec.name === GMAIL_MAIL_SERVER_NAME &&
    spec.url === GMAIL_MCP_URL
  );
}

export function buildGmailAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const query = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    state: opts.state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GMAIL_AUTHORIZE_URL}?${query.toString()}`;
}

function tokenCreds(
  parsed: TokenResponse,
  configured: GmailOAuthCreds,
  fallbackRefresh?: string,
): GmailOAuthCreds {
  return {
    ...configured,
    accessToken: parsed.access_token as string,
    refreshToken: parsed.refresh_token ?? fallbackRefresh,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };
}

async function exchangeGmailCode(opts: {
  configured: GmailOAuthCreds;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GmailOAuthCreds> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.configured.clientId,
    client_secret: opts.configured.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return tokenCreds(await postTokenForm(GMAIL_TOKEN_URL, body), opts.configured);
}

async function refreshGmailToken(creds: GmailOAuthCreds): Promise<GmailOAuthCreds> {
  if (!creds.refreshToken) throw new Error("Gmail OAuth refresh token is missing; sign in again");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
  return tokenCreds(await postTokenForm(GMAIL_TOKEN_URL, body), creds, creds.refreshToken);
}

let refreshInFlight: Promise<string> | null = null;

export async function resolveGmailToken(path: string = defaultConfigPath()): Promise<string> {
  const creds = readConfig(path).gmailOAuth;
  if (!creds?.clientId || !creds.clientSecret) {
    throw new Error("Gmail OAuth client ID and client secret are not configured");
  }
  if (!creds.accessToken || !creds.expiresAt) throw new Error("Gmail is not signed in");
  if (isTokenFresh(creds.expiresAt, creds.refreshToken)) return creds.accessToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const refreshed = await refreshGmailToken(creds);
      saveGmailOAuth(refreshed, path);
      return refreshed.accessToken as string;
    } catch (error) {
      throw new Error(`Gmail OAuth refresh failed: ${(error as Error).message}`, { cause: error });
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function beginGmailOAuthFlow(
  path: string = defaultConfigPath(),
): Promise<LocalhostOAuthFlow<GmailOAuthCreds>> {
  const configured = readConfig(path).gmailOAuth;
  if (!configured?.clientId || !configured.clientSecret) {
    throw new Error("Save a Gmail OAuth client ID and client secret before connecting");
  }
  const { verifier: codeVerifier, challenge: codeChallenge } = makePkcePair(32);
  return beginLocalhostOAuthFlow<GmailOAuthCreds>({
    callbackPath: GMAIL_OAUTH_CALLBACK_PATH,
    redirectUri: GMAIL_OAUTH_REDIRECT_URI,
    port: GMAIL_OAUTH_CALLBACK_PORT,
    host: "localhost",
    successTitle: "Gmail connected",
    successHeading: "Signed in to Gmail",
    stateMismatchMessage: "State mismatch. Retry Gmail sign-in from Reasonix settings.",
    allowPortFallback: false,
    bindErrorMessage: `Gmail OAuth callback server failed to bind port ${GMAIL_OAUTH_CALLBACK_PORT}`,
    buildUrl: (redirectUri, state) =>
      buildGmailAuthorizeUrl({
        clientId: configured.clientId,
        redirectUri,
        state,
        codeChallenge,
      }),
    exchange: async (code, redirectUri) => {
      const creds = await exchangeGmailCode({ configured, code, codeVerifier, redirectUri });
      const account = await fetchUserEmail(GMAIL_USERINFO_URL, creds.accessToken as string);
      return { ...creds, ...(account ? { account } : {}) };
    },
    timeoutMessage: "Gmail OAuth sign-in timed out. Retry from settings.",
  });
}

export function signOutGmail(path: string = defaultConfigPath()): void {
  const configured = readConfig(path).gmailOAuth;
  if (!configured) return;
  saveGmailOAuth({ clientId: configured.clientId, clientSecret: configured.clientSecret }, path);
}

export function forgetGmail(path: string = defaultConfigPath()): void {
  clearGmailOAuth(path);
}
