import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  antigravityAccount,
  antigravityVersion,
  buildAuthorizeUrl,
  exchangeAntigravityCode,
  fetchAntigravityModels,
  onboardAntigravity,
  refreshAntigravityToken,
  resolveAntigravityToken,
  signOutAntigravity,
} from "../src/antigravity-oauth.js";
import { readConfig, saveAntigravityOAuth } from "../src/config.js";

const ENV_KEYS = [
  "ANTIGRAVITY_OAUTH_SCOPE",
  "ANTIGRAVITY_OAUTH_REDIRECT_URI",
  "ANTIGRAVITY_AUTH_URL",
  "ANTIGRAVITY_TOKEN_URL",
  "ANTIGRAVITY_USERINFO_URL",
  "ANTIGRAVITY_VERSION",
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
    process.env.ANTIGRAVITY_VERSION = "2.9.1";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of originalEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("antigravityVersion validates an explicit version override", async () => {
    process.env.ANTIGRAVITY_VERSION = "not-a-version";
    await expect(antigravityVersion()).rejects.toThrow("must be a semantic version");
  });

  it("buildAuthorizeUrl carries client_id, offline access, and the redirect", () => {
    const url = buildAuthorizeUrl({
      clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
      redirectUri: "http://localhost:51121/oauth-callback",
      state: "state-abc",
      codeChallenge: "challenge-abc",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("scope")).toContain("cloud-platform");
    expect(parsed.searchParams.get("scope")).toContain("cclog");
    expect(parsed.searchParams.get("scope")).toContain("experimentsandconfigs");
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
      redirectUri: "http://localhost:51121/oauth-callback",
      code: "code-123",
      codeVerifier: "verifier-123",
    });
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

  it("resolveAntigravityToken clears legacy custom-client credentials", async () => {
    saveAntigravityOAuth(
      { accessToken: "legacy", refreshToken: "rt", expiresAt: Date.now() + 60_000 },
      path,
    );

    await expect(resolveAntigravityToken(path)).resolves.toBeUndefined();
    expect(readConfig(path).antigravityOAuth).toBeUndefined();
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

  it("onboardAntigravity discovers the project with Antigravity metadata", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ cloudaicompanionProject: "project-123" }));

    await expect(onboardAntigravity("at")).resolves.toBe("project-123");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer at",
      "user-agent": expect.stringContaining("antigravity/hub/2.9.1"),
      "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      metadata: expect.objectContaining({ ideType: "ANTIGRAVITY", pluginType: "GEMINI" }),
    });
  });

  it("onboardAntigravity accepts the object project response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ cloudaicompanionProject: { id: "object-project" } }),
    );

    await expect(onboardAntigravity("at")).resolves.toBe("object-project");
  });

  it("onboardAntigravity rejects discovery misses instead of borrowing a shared project", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({}));

    await expect(onboardAntigravity("at")).rejects.toThrow(
      "did not return a companion project for this account",
    );
  });

  it("fetchAntigravityModels returns the account model catalog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        models: {
          "gemini-3.1-pro-high": {
            displayName: "Gemini 3.1 Pro High",
            maxTokens: 1_000_000,
            maxOutputTokens: 65_536,
          },
          "claude-sonnet-4-6-thinking": { displayName: "Claude Sonnet 4.6 (Thinking)" },
        },
      }),
    );

    await expect(fetchAntigravityModels("at", "project-123")).resolves.toEqual([
      {
        id: "gemini-3.1-pro-high",
        displayName: "Gemini 3.1 Pro High",
        maxTokens: 1_000_000,
        maxOutputTokens: 65_536,
      },
      {
        id: "claude-sonnet-4-6-thinking",
        displayName: "Claude Sonnet 4.6 (Thinking)",
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      project: "project-123",
    });
  });

  it("fetchAntigravityModels surfaces the Code Assist license classification", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { details: [{ reason: "SUBSCRIPTION_REQUIRED" }] } }, 403),
    );

    await expect(fetchAntigravityModels("at", "project-123")).rejects.toThrow(
      /licensed Gemini Code Assist access.*#3501/i,
    );
  });

  it("onboardAntigravity surfaces authorization failures instead of using fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "denied" }, 403));

    await expect(onboardAntigravity("at")).rejects.toThrow(
      "Antigravity project discovery failed (403)",
    );
  });
});
