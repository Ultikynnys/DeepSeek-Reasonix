// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings, UsageStats } from "../App";
import type { CodexQuota } from "../protocol";
import { THEME, THEME_STYLES } from "../theme";
import { StatusBar } from "./statusbar";

function renderBar(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  const props: Parameters<typeof StatusBar>[0] = {
    settings: { model: "deepseek-v4-flash" } as Settings,
    balance: null,
    codexQuota: null,
    usage: { totalCostUsd: 0 } as unknown as UsageStats,
    busy: false,
    ready: true,
    currency: "USD",
    theme: THEME.DARK,
    themeStyle: THEME_STYLES[0]!,
    jobs: [],
    jobsOpen: false,
    onToggleJobs: () => undefined,
    onSetThemeStyle: () => undefined,
    onToggleCurrency: () => undefined,
    onOpenSettings: () => undefined,
  };
  return render(<StatusBar {...props} {...overrides} />);
}

const GPT_QUOTA: CodexQuota = {
  used: 42,
  limit: 100,
  usedPct: 42,
  currency: "credits",
  turnCost: 2.5,
  fetchedAt: 0,
};

describe("StatusBar quota display", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the balance and $ turn cost for DeepSeek tabs", () => {
    renderBar();
    expect(screen.getByText("balance")).toBeTruthy();
    expect(screen.getByText("this turn")).toBeTruthy();
    expect(screen.getByText(/\$ 0\.0000/)).toBeTruthy();
    expect(screen.queryByText("codex")).toBeNull();
    expect(screen.queryByText(/left/)).toBeNull();
  });

  it("shows weekly quota left (%, credits) and turn cost % of quota for gpt-5.6 tabs", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: GPT_QUOTA,
    });
    expect(screen.getByText(/58%\s*left/)).toBeTruthy();
    expect(screen.getByText(/58 \/ 100/)).toBeTruthy();
    expect(screen.getByText(/2\.5%/)).toBeTruthy();
    expect(screen.getByText(/2\.50 credits/)).toBeTruthy();
    // Balance and $ amounts are replaced by the pure quota numbers.
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
  });

  it("shows an em dash until a second quota measurement exists", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: { ...GPT_QUOTA, turnCost: null },
    });
    expect(screen.getByText(/58%\s*left/)).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("keeps the quota chips (em dash + retry) for gpt tabs when quota data is missing — never the DeepSeek balance", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: null,
    });
    // The codex chip and this-turn chip both render an em dash.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
    // Not signed in → the chip hints at signing in with OpenAI.
    expect(screen.getByTitle(/sign in with OpenAI/)).toBeTruthy();
  });

  it("tells signed-in gpt tabs that the quota is unavailable rather than hinting to sign in", () => {
    renderBar({
      settings: {
        model: "gpt-5.6-sol",
        modelEndpoint: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          openaiAuth: "oauth",
        },
      } as Settings,
      codexQuota: null,
    });
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTitle(/sign in with OpenAI/)).toBeNull();
    expect(screen.getByTitle(/unavailable right now/)).toBeTruthy();
  });

  it("treats any gpt-* model as an OpenAI tab (quota chips, not balance)", () => {
    renderBar({
      settings: { model: "gpt-4o-custom" } as Settings,
      codexQuota: GPT_QUOTA,
    });
    expect(screen.getByText(/58%\s*left/)).toBeTruthy();
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
  });

  it("renders percent-only quota when the backend reports no absolute used/limit (wham fallback)", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: { used: null, limit: null, usedPct: 75, currency: "credits", fetchedAt: 0 },
    });
    expect(screen.getByText(/25%\s*left/)).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.queryByText(/\/\s*100/)).toBeNull();
    expect(screen.queryByText("balance")).toBeNull();
  });

  it("shows a refresh indicator while a retry is in flight", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: null,
      codexQuotaRefreshing: true,
    });
    expect(screen.getByText("…")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
  });

  it("surfaces the fetch failure reason in the chip tooltip", () => {
    renderBar({
      settings: {
        model: "gpt-5.6-sol",
        modelEndpoint: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          openaiAuth: "oauth",
        },
      } as Settings,
      codexQuota: null,
      codexQuotaReason: "401 Unauthorized from https://chatgpt.com/backend-api/wham/usage",
    });
    expect(screen.getByTitle(/unavailable right now/)).toBeTruthy();
    expect(screen.getByTitle(/401 Unauthorized/)).toBeTruthy();
  });
});
