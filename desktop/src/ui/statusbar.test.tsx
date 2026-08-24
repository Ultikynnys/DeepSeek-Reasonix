// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings, UsageStats } from "../App";
import type { CodexQuota, OllamaQuota } from "../protocol";
import { THEME, THEME_STYLES } from "../theme";
import { StatusBar } from "./statusbar";

function renderBar(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  const props: Parameters<typeof StatusBar>[0] = {
    settings: { model: "deepseek-v4-flash" } as Settings,
    balance: null,
    codexQuota: null,
    ollamaQuota: null,
    usage: { totalCostUsd: 0, lastCallCostUsd: 0 } as unknown as UsageStats,
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
  plan: "plus",
  fiveHour: { windowMinutes: 300, usedPercent: 50, remainingPercent: 50, resetsAt: null },
  weekly: { windowMinutes: 10080, usedPercent: 42, remainingPercent: 58, resetsAt: null },
  turnUsedPct: 2.5,
  fetchedAt: 0,
};

const OLLAMA_QUOTA: OllamaQuota = {
  session: { usagePct: 25, remainingPct: 75 },
  weekly: { usagePct: 12.5, remainingPct: 87.5 },
  turnUsedPct: 0.1,
  fetchedAt: 0,
};

describe("StatusBar quota display", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the balance and $ turn cost for DeepSeek tabs", () => {
    renderBar({
      usage: { totalCostUsd: 1.5, lastCallCostUsd: 0.25 } as unknown as UsageStats,
    });
    expect(screen.getByText("balance")).toBeTruthy();
    expect(screen.getByText("this turn")).toBeTruthy();
    // "this turn" reflects the latest model call's cost; the session total is
    // a distinct chip — regression guard for the malformed-turn-cost bug.
    expect(screen.getByText(/This session cost/)).toBeTruthy();
    expect(screen.getByText(/\$ 0\.2500/)).toBeTruthy();
    expect(screen.getByText(/\$ 1\.5000/)).toBeTruthy();
    expect(screen.queryByText("codex")).toBeNull();
    expect(screen.queryByText(/left/)).toBeNull();
  });

  it("hides the this-turn cost chip when statusBar.showTurnCost is off", () => {
    renderBar({
      settings: { model: "deepseek-v4-flash", statusBar: { showTurnCost: false } } as Settings,
    });
    expect(screen.queryByText("this turn")).toBeNull();
  });

  it("hides the session-cost chip when statusBar.showSessionCost is off", () => {
    renderBar({
      settings: { model: "deepseek-v4-flash", statusBar: { showSessionCost: false } } as Settings,
    });
    expect(screen.queryByText(/This session cost/)).toBeNull();
  });

  it("shows the current rate period (off-peak or peak) with its price multiplier", () => {
    renderBar();
    // Wall-clock dependent — either label and multiplier may be current.
    expect(screen.getByText(/off-peak|peak/)).toBeTruthy();
    expect(screen.getByText(/1x|2x/)).toBeTruthy();
  });

  it("shows weekly quota % left + plan and this-turn % for gpt-5.6 tabs", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: GPT_QUOTA,
    });
    expect(screen.getByText(/58%\s*left/)).toBeTruthy();
    expect(screen.getByText("plus")).toBeTruthy();
    expect(screen.getByText(/2\.5%/)).toBeTruthy();
    // Balance and $ amounts are replaced by the pure quota numbers.
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
  });

  it("shows an em dash until a second quota measurement exists", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: { ...GPT_QUOTA, turnUsedPct: null },
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
    // No data → the chip hints at the in-app ChatGPT sign-in (no codex CLI).
    expect(screen.getByTitle(/sign in with ChatGPT/)).toBeTruthy();
  });

  it("shows the no-data hint regardless of auth state — the reason string carries the diagnosis", () => {
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
    expect(screen.getByTitle(/sign in with ChatGPT/)).toBeTruthy();
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

  it("falls back to the ChatGPT label when the plan is unknown", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: {
        plan: null,
        fiveHour: null,
        weekly: { windowMinutes: 10080, usedPercent: 75, remainingPercent: 25, resetsAt: null },
        fetchedAt: 0,
      },
    });
    expect(screen.getByText(/25%\s*left/)).toBeTruthy();
    expect(screen.getByText("ChatGPT")).toBeTruthy();
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
      codexQuotaReason: "no OAuth token",
    });
    expect(screen.getByTitle(/sign in with ChatGPT/)).toBeTruthy();
    expect(screen.getByTitle(/no OAuth token/)).toBeTruthy();
  });

  it("shows weekly % left + plan + this-turn % for ollama tabs", () => {
    renderBar({
      settings: { model: "ollama/gpt-oss:20b" } as Settings,
      ollamaQuota: OLLAMA_QUOTA,
      ollamaPlan: "free",
    });
    expect(screen.getByText(/88%\s*left/)).toBeTruthy();
    expect(screen.getByText("free")).toBeTruthy();
    expect(screen.getByText(/0\.1%/)).toBeTruthy();
    // Balance and $ amounts are replaced by the pure usage numbers.
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
  });

  it("shows an em dash for this turn until a second Ollama measurement exists", () => {
    renderBar({
      settings: { model: "ollama/gpt-oss:20b" } as Settings,
      ollamaQuota: { ...OLLAMA_QUOTA, turnUsedPct: null },
    });
    expect(screen.getByText(/88%\s*left/)).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("keeps the quota chips for ollama tabs when usage data is missing — never the DeepSeek balance", () => {
    renderBar({
      settings: { model: "ollama/gpt-oss:20b" } as Settings,
      ollamaQuota: null,
    });
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("plan usage")).toBeTruthy();
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
    expect(screen.getByTitle(/set an API key/)).toBeTruthy();
  });

  it("surfaces the Ollama usage fetch failure reason in the chip tooltip", () => {
    renderBar({
      settings: { model: "ollama/gpt-oss:20b" } as Settings,
      ollamaQuota: null,
      ollamaQuotaReason: "usage-unavailable",
    });
    expect(screen.getByTitle(/usage-unavailable/)).toBeTruthy();
  });
});
