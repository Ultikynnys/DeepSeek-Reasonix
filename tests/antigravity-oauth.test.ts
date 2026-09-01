import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  antigravityAccount,
  buildAuthorizeUrl,
  exchangeAntigravityCode,
  fetchAntigravityModels,
  fetchAntigravityQuota,
  onboardAntigravity,
  parseAntigravityPlan,
  refreshAntigravityToken,
  resolveAntigravityToken,
  resolveGeminiAuth,
  signOutAntigravity,
} from "../src/antigravity-oauth.js";
import { readConfig, saveAntigravityOAuth } from "../src/config.js";

const ENV_KEYS = [
  "ANTIGRAVITY_OAUTH_SCOPE",
  "ANTIGRAVITY_OAUTH_REDIRECT_URI",
  "ANTIGRAVITY_AUTH_URL",
  "ANTIGRAVITY_TOKEN_URL",
  "ANTIGRAVITY_USERINFO_URL",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("antigravity-oauth", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "antigravity-oauth-"));
    path = join(dir, "config.json");
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of originalEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("buildAuthorizeUrl carries client_id, offline access, and the redirect", () => {
    const url = buildAuthorizeUrl({
      clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
      redirectUri: "http://localhost:50510/auth/callback",
      state: "state-abc",
      codeChallenge: "challenge-abc",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:50510/auth/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("scope")).toContain("cloud-platform");
    expect(parsed.searchParams.get("scope")).toContain("userinfo.email");
    expect(parsed.searchParams.get("scope")).toContain("aicode");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchangeAntigravityCode posts the authorization_code grant and returns creds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      );
    const creds = await exchangeAntigravityCode({
      redirectUri: "http://localhost:50510/auth/callback",
      code: "code-123",
      codeVerifier: "verifier-123",
    });
    expect(ANTIGRAVITY_OAUTH_CLIENT_ID).toBe(
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    );
    expect(creds.accessToken).toBe("at");
    expect(creds.refreshToken).toBe("rt");
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
    expect(body.get("client_secret")).toBe(ANTIGRAVITY_OAUTH_CLIENT_SECRET);
    expect(body.get("code")).toBe("code-123");
    expect(body.get("code_verifier")).toBe("verifier-123");
  });

  it("refreshAntigravityToken posts the refresh_token grant and keeps the refresh token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "at-new", expires_in: 3600 }),
    );
    const creds = await refreshAntigravityToken("rt-old");
    expect(creds.accessToken).toBe("at-new");
    expect(creds.refreshToken).toBe("rt-old");
  });

  it("resolveAntigravityToken returns a fresh token without any fetch", async () => {
    saveAntigravityOAuth(
      {
        accessToken: "at-fresh",
        refreshToken: "rt",
        clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
        expiresAt: Date.now() + 10 * 60_000,
      },
      path,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await resolveAntigravityToken(path)).toBe("at-fresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolveAntigravityToken refreshes an expired token and persists the new pair", async () => {
    saveAntigravityOAuth(
      {
        accessToken: "at-expired",
        refreshToken: "rt",
        clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
        expiresAt: Date.now() - 1000,
      },
      path,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "at-new", expires_in: 3600 }),
    );
    expect(await resolveAntigravityToken(path)).toBe("at-new");
    const stored = readConfig(path).antigravityOAuth;
    expect(stored?.accessToken).toBe("at-new");
    expect(stored?.refreshToken).toBe("rt");
  });

  it("resolveAntigravityToken clears obsolete credentials and requires sign-in", async () => {
    saveAntigravityOAuth(
      { accessToken: "legacy", refreshToken: "rt", expiresAt: Date.now() + 60_000 },
      path,
    );

    await expect(resolveAntigravityToken(path)).rejects.toThrow("obsolete client");
    expect(readConfig(path).antigravityOAuth).toBeUndefined();
  });

  it("resolveAntigravityToken surfaces refresh failures", async () => {
    saveAntigravityOAuth(
      {
        accessToken: "expired",
        refreshToken: "revoked",
        clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
        expiresAt: Date.now() - 1,
      },
      path,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_grant", error_description: "Token revoked" }, 400),
    );

    await expect(resolveAntigravityToken(path)).rejects.toThrow(
      "Antigravity OAuth refresh failed: OAuth token exchange failed (400): Token revoked",
    );
  });

  it("resolveAntigravityToken returns undefined without creds", async () => {
    expect(await resolveAntigravityToken(path)).toBeUndefined();
  });

  it("signOutAntigravity clears stored creds", async () => {
    saveAntigravityOAuth(
      { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 60_000 },
      path,
    );
    await signOutAntigravity(path);
    expect(readConfig(path).antigravityOAuth).toBeUndefined();
  });

  it("antigravityAccount returns the userinfo email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ email: "u@example.com" }));
    expect(await antigravityAccount("at")).toBe("u@example.com");
  });

  it("onboardAntigravity discovers an existing project with exact client metadata", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ cloudaicompanionProject: "project-123" }));

    await expect(onboardAntigravity("at")).resolves.toBe("project-123");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer at",
      "user-agent": "antigravity",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "WINDOWS_AMD64",
        pluginType: "GEMINI",
        ideName: "antigravity",
      },
      mode: "FULL_ELIGIBILITY_CHECK",
    });
  });

  it("onboardAntigravity accepts the object project response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ cloudaicompanionProject: { id: "object-project" } }),
    );

    await expect(onboardAntigravity("at")).resolves.toBe("object-project");
  });

  it("onboardAntigravity provisions and polls the default free tier", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ name: "operations/setup-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          done: true,
          response: { cloudaicompanionProject: { id: "managed-project" } },
        }),
      );
    vi.useFakeTimers();

    const projectPromise = onboardAntigravity("at");
    await vi.runAllTimersAsync();
    await expect(projectPromise).resolves.toBe("managed-project");
    vi.useRealTimers();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
    );
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      tierId: "free-tier",
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "WINDOWS_AMD64",
        pluginType: "GEMINI",
        ideName: "antigravity",
      },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal/operations/setup-1",
    );
  });

  it("onboardAntigravity rejects invalid operation names", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ name: "operations/../secrets" }));
    vi.useFakeTimers();

    const rejection = expect(onboardAntigravity("at")).rejects.toThrow("invalid operation name");
    await vi.runAllTimersAsync();
    await rejection;
    vi.useRealTimers();
  });

  it("onboardAntigravity reports ineligibility reasons", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ineligibleTiers: [{ reasonMessage: "Account is not eligible" }] }),
    );

    await expect(onboardAntigravity("at")).rejects.toThrow("Account is not eligible");
  });

  it("fetchAntigravityModels returns unique model ids from quota buckets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        buckets: [
          { modelId: "gemini-3.1-pro-high" },
          { modelId: "claude-sonnet-4-6-thinking" },
          { modelId: "gemini-3.1-pro-high" },
        ],
      }),
    );

    await expect(fetchAntigravityModels("at", "project-123")).resolves.toEqual([
      { id: "claude-sonnet-4-6-thinking", displayName: "claude-sonnet-4-6-thinking" },
      { id: "gemini-3.1-pro-high", displayName: "gemini-3.1-pro-high" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      project: "project-123",
    });
  });

  it("onboardAntigravity surfaces authorization failures without endpoint fallback", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "denied" }, 403));

    await expect(onboardAntigravity("at")).rejects.toThrow("loadCodeAssist failed (403)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parseAntigravityPlan maps currentTier to a displayable plan", () => {
    expect(parseAntigravityPlan(null)).toBeNull();
    expect(parseAntigravityPlan({ id: "free-tier", name: "Antigravity" })).toEqual({
      tierId: "free-tier",
      name: "Antigravity",
    });
    expect(
      parseAntigravityPlan({
        id: "free-tier",
        name: "Antigravity",
        upgradeSubscriptionText: "Upgrade to get 1,500/day",
        upgradeSubscriptionType: "GOOGLE_ONE",
        upgradeSubscriptionUri: "https://one.google.com/ai",
      }),
    ).toEqual({
      tierId: "free-tier",
      name: "Antigravity",
      upgradeText: "Upgrade to get 1,500/day",
      upgradeType: "GOOGLE_ONE",
      upgradeUri: "https://one.google.com/ai",
    });
  });

  it("fetchAntigravityQuota returns plan + per-model usedFraction, dropping vertex buckets", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ currentTier: { id: "free-tier", name: "Antigravity" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          buckets: [
            {
              modelId: "gemini-2.5-pro",
              remainingFraction: 0.8,
              resetTime: "2026-09-01T13:37:06Z",
            },
            { modelId: "gemini-2.5-pro_vertex", remainingFraction: 0.8 },
            { modelId: "chat_20706", remainingFraction: 1 },
          ],
        }),
      );

    const quota = await fetchAntigravityQuota("at", "project-123");
    expect(quota.plan).toEqual({ tierId: "free-tier", name: "Antigravity" });
    expect(quota.windows).toEqual([
      {
        modelId: "gemini-2.5-pro",
        usedFraction: 0.2,
        resetTime: "2026-09-01T13:37:06Z",
      },
      { modelId: "chat_20706", usedFraction: 0 },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    );
  });

  it("resolveGeminiAuth returns null when no token is present", async () => {
    expect(await resolveGeminiAuth(path)).toBeNull();
  });

  it("resolveGeminiAuth returns accessToken and projectId when present", async () => {
    saveAntigravityOAuth(
      {
        clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
        accessToken: "at-valid",
        refreshToken: "rt-valid",
        expiresAt: Date.now() + 3600_000,
        projectId: "proj-abc",
        models: ["gemini-3.7-flash-tiered"],
      },
      path,
    );
    const auth = await resolveGeminiAuth(path);
    expect(auth).toEqual({ accessToken: "at-valid", projectId: "proj-abc" });
  });
});
