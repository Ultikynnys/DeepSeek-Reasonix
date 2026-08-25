import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  antigravityAccount,
  buildAuthorizeUrl,
  exchangeAntigravityCode,
  onboardAntigravity,
  refreshAntigravityToken,
  resolveAntigravityToken,
  signOutAntigravity,
} from "../src/antigravity-oauth.js";
import { readConfig, saveAntigravityOAuth } from "../src/config.js";

const TEST_CLIENT_ID = "test-client-id";
const TEST_CLIENT_SECRET = "test-client-secret";

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
      clientId: TEST_CLIENT_ID,
      redirectUri: "http://localhost:1234/oauth2callback",
      state: "state-abc",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1234/oauth2callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("scope")).toContain("cloud-platform");
  });

  it("exchangeAntigravityCode posts the authorization_code grant and returns creds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      );
    const creds = await exchangeAntigravityCode({
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "http://localhost:1/oauth2callback",
      code: "code-123",
    });
    expect(creds.accessToken).toBe("at");
    expect(creds.refreshToken).toBe("rt");
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("code")).toBe("code-123");
  });

  it("refreshAntigravityToken posts the refresh_token grant and keeps the refresh token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "at-new", expires_in: 3600 }),
    );
    const creds = await refreshAntigravityToken("rt-old", "cid", "secret");
    expect(creds.accessToken).toBe("at-new");
    expect(creds.refreshToken).toBe("rt-old");
  });

  it("resolveAntigravityToken returns a fresh token without any fetch", async () => {
    saveAntigravityOAuth(
      { accessToken: "at-fresh", refreshToken: "rt", expiresAt: Date.now() + 10 * 60_000 },
      path,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await resolveAntigravityToken(path, TEST_CLIENT_ID, TEST_CLIENT_SECRET)).toBe(
      "at-fresh",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolveAntigravityToken refreshes an expired token and persists the new pair", async () => {
    saveAntigravityOAuth(
      { accessToken: "at-expired", refreshToken: "rt", expiresAt: Date.now() - 1000 },
      path,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "at-new", expires_in: 3600 }),
    );
    expect(await resolveAntigravityToken(path, TEST_CLIENT_ID, TEST_CLIENT_SECRET)).toBe("at-new");
    const stored = readConfig(path).antigravityOAuth;
    expect(stored?.accessToken).toBe("at-new");
    expect(stored?.refreshToken).toBe("rt");
  });

  it("resolveAntigravityToken returns undefined without creds", async () => {
    expect(await resolveAntigravityToken(path, TEST_CLIENT_ID, TEST_CLIENT_SECRET)).toBeUndefined();
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

  it("onboardAntigravity returns an existing companion project", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        currentTier: { id: "free-tier" },
        cloudaicompanionProject: "existing-project",
      }),
    );

    await expect(onboardAntigravity("at")).resolves.toBe("existing-project");
  });

  it("onboardAntigravity polls a pending operation for the managed project", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          allowedTiers: [{ id: "free-tier", isDefault: true }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ name: "operations/onboard-1", done: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: "operations/onboard-1",
          done: true,
          response: { cloudaicompanionProject: { id: "proj-123" } },
        }),
      );

    await expect(onboardAntigravity("at")).resolves.toBe("proj-123");
    const [loadUrl, loadInit] = fetchMock.mock.calls[0]!;
    expect(loadUrl).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(loadInit?.headers).toMatchObject({ authorization: "Bearer at" });
    expect(JSON.parse(loadInit?.body as string)).toEqual({
      metadata: expect.objectContaining({ pluginType: "GEMINI" }),
    });
    const [onboardUrl, onboardInit] = fetchMock.mock.calls[1]!;
    expect(onboardUrl).toBe("https://cloudcode-pa.googleapis.com/v1internal:onboardUser");
    expect(JSON.parse(onboardInit?.body as string)).toEqual({
      tierId: "free-tier",
      metadata: expect.objectContaining({ pluginType: "GEMINI" }),
    });
    const [operationUrl, operationInit] = fetchMock.mock.calls[2]!;
    expect(operationUrl).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal/operations/onboard-1",
    );
    expect(operationInit?.method).toBeUndefined();
  });

  it("onboardAntigravity reloads the project when the completed operation omits it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: {} }))
      .mockResolvedValueOnce(
        jsonResponse({
          currentTier: { id: "free-tier" },
          cloudaicompanionProject: "reloaded-project",
        }),
      );

    await expect(onboardAntigravity("at")).resolves.toBe("reloaded-project");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    );
  });

  it("onboardAntigravity surfaces account ineligibility", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        allowedTiers: [],
        ineligibleTiers: [{ reasonMessage: "Personal account required" }],
      }),
    );

    await expect(onboardAntigravity("at")).rejects.toThrow(
      "Antigravity account is not eligible: Personal account required",
    );
  });

  it("onboardAntigravity rejects a failed operation", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(
        jsonResponse({ done: true, error: { code: 403, message: "License unavailable" } }),
      );

    await expect(onboardAntigravity("at")).rejects.toThrow(
      "Antigravity onboarding failed (403): License unavailable",
    );
  });

  it("onboardAntigravity rejects a pending poll response without an operation name", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ name: "operations/onboard-1", done: false }))
      .mockResolvedValueOnce(jsonResponse({ done: false }));

    await expect(onboardAntigravity("at")).rejects.toThrow(
      "Antigravity onboarding returned an incomplete operation without a name",
    );
  });
});
