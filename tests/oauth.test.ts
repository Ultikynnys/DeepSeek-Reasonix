import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, saveOpenAIOAuth } from "../src/config.js";
import {
  beginOAuthFlow,
  buildAuthorizeUrl,
  exchangeOAuthCode,
  fetchCodexQuota,
  oauthAccount,
  openAIClientId,
  pkcePair,
  refreshOAuthToken,
  resolveOpenAIToken,
  revokeOAuthToken,
  signOutOpenAI,
} from "../src/oauth.js";

const ENV_KEYS = [
  "OPENAI_OAUTH_CLIENT_ID",
  "OPENAI_OAUTH_SCOPE",
  "OPENAI_OAUTH_AUDIENCE",
  "OPENAI_OAUTH_REDIRECT_URI",
  "OPENAI_AUTH_URL",
  "OPENAI_TOKEN_URL",
  "OPENAI_REVOKE_URL",
  "OPENAI_USERINFO_URL",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Real HTTP GET against the localhost callback server (fetch is mocked in these tests). */
function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpRequest(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
}

describe("oauth", () => {
  let dir: string;
  let cfgPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-oauth-test-"));
    cfgPath = join(dir, "config.json");
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of originalEnv) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("pkcePair produces an S256 challenge of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest().toString("base64url"));
    // Two calls never collide.
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  it("buildAuthorizeUrl carries PKCE + state + default scope", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid-1",
        redirectUri: "http://127.0.0.1:9999/callback",
        state: "st-1",
        codeChallenge: "ch-1",
      }),
    );
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("ch-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("buildAuthorizeUrl honors OPENAI_OAUTH_AUDIENCE and env-overridden endpoints", () => {
    process.env.OPENAI_OAUTH_AUDIENCE = "https://api.openai.com/v1";
    process.env.OPENAI_AUTH_URL = "https://auth.example.test/authorize";
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://127.0.0.1:1/cb",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.searchParams.get("audience")).toBe("https://api.openai.com/v1");
    expect(url.origin).toBe("https://auth.example.test");
  });

  it("exchangeOAuthCode posts the code + verifier and builds creds", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 900 }),
    );
    const creds = await exchangeOAuthCode({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:1/cb",
      code: "code-1",
      verifier: "ver-1",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:1/cb");
    expect(body.get("code_verifier")).toBe("ver-1");
    expect(creds.accessToken).toBe("at-1");
    expect(creds.refreshToken).toBe("rt-1");
    const elapsed = creds.expiresAt - Date.now();
    expect(elapsed).toBeGreaterThan(899_000);
    expect(elapsed).toBeLessThanOrEqual(901_000);
  });

  it("exchangeOAuthCode surfaces upstream errors verbatim", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant", error_description: "bad code" }, 400),
    );
    await expect(
      exchangeOAuthCode({
        clientId: "cid",
        redirectUri: "http://127.0.0.1:1/cb",
        code: "bad",
        verifier: "v",
      }),
    ).rejects.toThrow(/bad code/);
  });

  it("refreshOAuthToken keeps the existing refresh token when the response omits one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at-2", expires_in: 600 }));
    const creds = await refreshOAuthToken("rt-old", "cid");
    const body = new URLSearchParams(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1]!.body),
    );
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old");
    expect(creds.refreshToken).toBe("rt-old");
    expect(creds.accessToken).toBe("at-2");
  });

  it("resolveOpenAIToken returns a fresh token without any fetch", async () => {
    saveOpenAIOAuth(
      { accessToken: "at-fresh", refreshToken: "rt", expiresAt: Date.now() + 10 * 60_000 },
      cfgPath,
    );
    expect(await resolveOpenAIToken(cfgPath)).toBe("at-fresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolveOpenAIToken refreshes an expired token and persists the new pair", async () => {
    saveOpenAIOAuth(
      { accessToken: "at-expired", refreshToken: "rt", expiresAt: Date.now() - 1000 },
      cfgPath,
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 300 }),
    );
    expect(await resolveOpenAIToken(cfgPath)).toBe("at-new");
    const stored = readConfig(cfgPath).openaiOAuth;
    expect(stored?.accessToken).toBe("at-new");
    expect(stored?.refreshToken).toBe("rt-new");
  });

  it("resolveOpenAIToken returns undefined when refresh fails", async () => {
    saveOpenAIOAuth(
      { accessToken: "at-expired", refreshToken: "rt", expiresAt: Date.now() - 1000 },
      cfgPath,
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, 400));
    expect(await resolveOpenAIToken(cfgPath)).toBeUndefined();
    // Old creds stay in place for a later retry.
    expect(readConfig(cfgPath).openaiOAuth?.accessToken).toBe("at-expired");
  });

  it("resolveOpenAIToken returns undefined without creds", async () => {
    expect(await resolveOpenAIToken(cfgPath)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokeOAuthToken posts the token; network failures are swallowed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    await revokeOAuthToken("tok", "cid");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/revoke");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("token")).toBe("tok");
    expect(body.get("client_id")).toBe("cid");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(revokeOAuthToken("tok2", "cid")).resolves.toBeUndefined();
  });

  it("oauthAccount returns the email from userinfo", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: "u@example.com" }));
    expect(await oauthAccount("at")).toBe("u@example.com");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/userinfo");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer at");
  });

  it("oauthAccount is undefined on non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    expect(await oauthAccount("at")).toBeUndefined();
  });

  describe("beginOAuthFlow (real localhost callback server)", () => {
    it("resolves done after a valid callback round-trip", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/oauth/token")) {
          return jsonResponse({
            access_token: "at-flow",
            refresh_token: "rt-flow",
            expires_in: 900,
          });
        }
        return jsonResponse({}, 404);
      });
      const flow = await beginOAuthFlow({ timeoutMs: 5_000 });
      const parsed = new URL(flow.url);
      const state = parsed.searchParams.get("state")!;
      const redirect = parsed.searchParams.get("redirect_uri")!;
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(parsed.searchParams.get("code_challenge")).toBeTruthy();

      const res = await httpGet(`${redirect}?code=code-flow&state=${state}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("Signed in");

      const creds = await flow.done;
      expect(creds.accessToken).toBe("at-flow");
      expect(creds.refreshToken).toBe("rt-flow");
      // The server closed after the callback.
      await expect(httpGet(redirect)).rejects.toThrow();
    });

    it("rejects on state mismatch", async () => {
      const flow = await beginOAuthFlow({ timeoutMs: 5_000 });
      const redirect = new URL(flow.url).searchParams.get("redirect_uri")!;
      const rejection = expect(flow.done).rejects.toThrow(/state mismatch/i);
      const res = await httpGet(`${redirect}?code=x&state=wrong-state`);
      expect(res.status).toBe(400);
      await rejection;
    });

    it("rejects with the upstream error description", async () => {
      const flow = await beginOAuthFlow({ timeoutMs: 5_000 });
      const redirect = new URL(flow.url).searchParams.get("redirect_uri")!;
      const rejection = expect(flow.done).rejects.toThrow(/User declined/);
      const res = await httpGet(
        `${redirect}?error=access_denied&error_description=User%20declined`,
      );
      expect(res.status).toBe(400);
      await rejection;
    });

    it("cancel() rejects done and closes the server", async () => {
      const flow = await beginOAuthFlow({ timeoutMs: 5_000 });
      const redirect = new URL(flow.url).searchParams.get("redirect_uri")!;
      const rejection = expect(flow.done).rejects.toThrow(/cancelled/);
      flow.cancel();
      await rejection;
      await expect(httpGet(redirect)).rejects.toThrow();
    });
  });

  it("signOutOpenAI revokes then clears stored creds", async () => {
    saveOpenAIOAuth(
      { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 60_000 },
      cfgPath,
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    await signOutOpenAI(cfgPath);
    expect(readConfig(cfgPath).openaiOAuth).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/revoke");
    expect(new URLSearchParams(String(init.body)).get("token")).toBe("at");
  });

  it("signOutOpenAI clears creds even when revocation is offline", async () => {
    saveOpenAIOAuth(
      { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 60_000 },
      cfgPath,
    );
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await signOutOpenAI(cfgPath);
    expect(readConfig(cfgPath).openaiOAuth).toBeUndefined();
  });

  it("openAIClientId defaults to the community client, overridable via env", () => {
    expect(openAIClientId()).toBe("DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD");
    process.env.OPENAI_OAUTH_CLIENT_ID = "registered-cid";
    expect(openAIClientId()).toBe("registered-cid");
  });

  describe("fetchCodexQuota", () => {
    /** Creds far from expiry — the refresh path would otherwise consume the fetch mock. */
    const creds = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 };

    it("parses the nested weekly_quota_usage/limit shape with amounts and currency", async () => {
      saveOpenAIOAuth(creds, cfgPath);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          weekly_quota_usage: { amount: 42, currency: "credits" },
          weekly_quota_limit: { amount: 100, currency: "credits" },
        }),
      );
      const q = await fetchCodexQuota(cfgPath);
      expect(q).not.toBeNull();
      expect(q!.used).toBe(42);
      expect(q!.limit).toBe(100);
      expect(q!.usedPct).toBe(42);
      expect(q!.currency).toBe("credits");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://chatgpt.com/backend-api/codex/quota");
      expect((init.headers as Record<string, string>)["OAI-Product-Sku"]).toBe("codex");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer at-1");
    });

    it("parses the flat numeric used/limit shape and string amounts inside objects", async () => {
      saveOpenAIOAuth(creds, cfgPath);
      fetchMock.mockResolvedValueOnce(jsonResponse({ used: 12.5, limit: 50 }));
      const flat = await fetchCodexQuota(cfgPath);
      expect(flat!.used).toBe(12.5);
      expect(flat!.limit).toBe(50);
      expect(flat!.usedPct).toBe(25);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          quota_usage: { amount: "30" },
          quota_limit: { amount: 200 },
        }),
      );
      const nested = await fetchCodexQuota(cfgPath);
      expect(nested!.used).toBe(30);
      expect(nested!.limit).toBe(200);
      expect(nested!.usedPct).toBe(15);
    });

    it("returns null without OAuth creds and never fetches", async () => {
      expect(await fetchCodexQuota(cfgPath)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns null on rejection, malformed payloads, and non-positive limits", async () => {
      saveOpenAIOAuth(creds, cfgPath);
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 401));
      expect(await fetchCodexQuota(cfgPath)).toBeNull();
      fetchMock.mockResolvedValueOnce(jsonResponse({ whatever: true }));
      expect(await fetchCodexQuota(cfgPath)).toBeNull();
      fetchMock.mockResolvedValueOnce(jsonResponse({ used: 10, limit: 0 }));
      expect(await fetchCodexQuota(cfgPath)).toBeNull();
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await fetchCodexQuota(cfgPath)).toBeNull();
    });
  });
});
