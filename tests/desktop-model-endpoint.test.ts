/** #1529 — the status bar's API chip is per tab and flips between DeepSeek
 *  and OpenAI with the tab's current model. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelEndpointFor } from "../src/cli/commands/desktop.js";
import { writeConfig } from "../src/config.js";

const ENV_NAMES = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_API_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

describe("desktop modelEndpointFor (#1529)", () => {
  let dir: string;
  let path: string;
  const originalEnv: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-endpoint-"));
    path = join(dir, "config.json");
    for (const name of ENV_NAMES) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      delete originalEnv[name];
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("deepseek model with nothing configured reports the client's default endpoint", () => {
    expect(modelEndpointFor("deepseek-v4-flash", path)).toEqual({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
    });
  });

  it("deepseek model follows a custom config baseUrl", () => {
    writeConfig({ baseUrl: "https://gateway.example.com/v1" }, path);
    expect(modelEndpointFor("deepseek-v4-flash", path)).toEqual({
      provider: "deepseek",
      baseUrl: "https://gateway.example.com/v1",
    });
  });

  it("gpt model with nothing configured reports the OpenAI endpoint and no auth", () => {
    expect(modelEndpointFor("gpt-5.6-sol", path)).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      openaiAuth: "none",
    });
  });

  it("gpt model with a static OPENAI_API_KEY reports apiKey auth", () => {
    process.env.OPENAI_API_KEY = "sk-openai-1234567890";
    expect(modelEndpointFor("gpt-5.6-sol", path)).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      openaiAuth: "apiKey",
    });
  });

  it("gpt model with OAuth creds reports oauth auth and the masked account", () => {
    writeConfig(
      {
        openaiOAuth: {
          accessToken: "at-123",
          refreshToken: "rt-123",
          expiresAt: Date.now() + 60_000,
          account: "u@example.com",
        },
      },
      path,
    );
    expect(modelEndpointFor("gpt-5.6-sol", path)).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      openaiAuth: "oauth",
      oauthAccount: "u@example.com",
    });
  });

  it("oauth wins over a static key when both are present", () => {
    process.env.OPENAI_API_KEY = "sk-openai-1234567890";
    writeConfig(
      {
        openaiOAuth: {
          accessToken: "at-123",
          refreshToken: "rt-123",
          expiresAt: Date.now() + 60_000,
          account: "u@example.com",
        },
      },
      path,
    );
    expect(modelEndpointFor("gpt-5.6-sol", path).openaiAuth).toBe("oauth");
  });

  it("gpt model follows OPENAI_BASE_URL (env owns the key tuple)", () => {
    process.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
    process.env.OPENAI_API_KEY = "sk-proxy-1234567890";
    expect(modelEndpointFor("gpt-5.6-terra", path)).toEqual({
      provider: "openai",
      baseUrl: "https://openai-proxy.example.com/v1",
      openaiAuth: "apiKey",
    });
  });

  it("gpt model follows a custom config baseUrl (gateway key from config)", () => {
    writeConfig(
      { baseUrl: "https://gateway.example.com/v1", openaiApiKey: "sk-gw-1234567890" },
      path,
    );
    expect(modelEndpointFor("gpt-5.6-luna", path)).toEqual({
      provider: "openai",
      baseUrl: "https://gateway.example.com/v1",
      openaiAuth: "apiKey",
    });
  });
});
