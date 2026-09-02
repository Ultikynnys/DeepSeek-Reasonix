// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings, UsageStats } from "../App";
import type { AntigravityQuota, CodexQuota, ModelEndpointInfo, OllamaQuota } from "../protocol";
import { THEME, THEME_STYLES } from "../theme";
import { StatusBar } from "./statusbar";

/** Mirrors the daemon's `modelEndpointFor` for the ids used in these tests —
 *  the statusbar consumes the daemon-resolved provider, never the model name.
 *  Unmapped ids intentionally resolve to the default family: that is the
 *  "name doesn't imply provider" contract under test. */
function endpointFor(model: string): ModelEndpointInfo {
  if (model.startsWith("ollama/"))
    return { provider: "ollama", baseUrl: "http://localhost:11434/v1" };
  if (model === "gpt-5.6-sol" || model === "gpt-5.6-terra")
    return { provider: "openai", baseUrl: "https://api.openai.com/v1" };
  // gpt-4o-custom here stands in for a custom id the user mapped to the
  // OpenAI provider via the `models` config (the daemon resolved it).
  if (model === "gpt-4o-custom")
    return { provider: "openai", baseUrl: "https://api.openai.com/v1" };
  if (model === "gpt-oss-120b-medium" || model === "gemini-3.6-flash" || model === "gemini-3.7-flash")
    return { provider: "gemini", baseUrl: "https://daily-cloudcode-pa.googleapis.com" };
  return { provider: "deepseek", baseUrl: "https://api.deepseek.com" };
}

function renderBar(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  const settings = {
    model: "deepseek-v4-flash",
    ...(overrides.settings as Partial<Settings> | undefined),
  } as Settings;
  // Tests that don't stub modelEndpoint get the daemon-plausible resolution
  // for their model, exactly as a live $settings event would carry it.
  if (!settings.modelEndpoint) settings.modelEndpoint = endpointFor(settings.model);
  const props: Parameters<typeof StatusBar>[0] = {
    balance: null,
    codexQuota: null,
    ollamaQuota: null,
    antigravityQuota: null,
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
    ...overrides,
    // The merged settings (with the resolved endpoint) win over the raw
    // override copy so the endpoint injection is never clobbered.
    settings,
  };
  return render(<StatusBar {...props} />);
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

const ANTIGRAVITY_QUOTA: AntigravityQuota = {
  plan: { tierId: "free-tier", name: "Antigravity" },
  windows: [{ modelId: "gemini-3.6-flash", usedFraction: 0.1, resetTime: "2026-09-01T13:37:06Z" }],
  turnUsedPct: 0.4,
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

  it("hides the peak/off-peak chip on OpenAI (gpt-*) tabs — it only applies to DeepSeek", () => {
    renderBar({ settings: { model: "gpt-5.6-sol" } as Settings });
    expect(screen.queryByText(/off-peak|peak/)).toBeNull();
    expect(screen.queryByText(/1x|2x/)).toBeNull();
  });

  it("hides the peak/off-peak chip on Ollama tabs", () => {
    renderBar({ settings: { model: "ollama/llama3.1:latest" } as Settings });
    expect(screen.queryByText(/off-peak|peak/)).toBeNull();
    expect(screen.queryByText(/1x|2x/)).toBeNull();
  });

  it("hides the peak/off-peak chip on Antigravity (Gemini) tabs", () => {
    renderBar({ settings: { model: "gemini-3.6-flash" } as Settings });
    expect(screen.queryByText(/off-peak|peak/)).toBeNull();
    expect(screen.queryByText(/1x|2x/)).toBeNull();
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

  it("renders quota chips (not balance) when the daemon resolves a custom id to OpenAI", () => {
    // gpt-4o-custom is not in any catalog — the daemon only reports it as
    // OpenAI because the user mapped it via the `models` config.
    renderBar({
      settings: { model: "gpt-4o-custom" } as Settings,
      codexQuota: GPT_QUOTA,
    });
    expect(screen.getByText(/58%\s*left/)).toBeTruthy();
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
  });

  it("renders the DeepSeek balance for a gpt-* shaped id the daemon did NOT resolve to OpenAI", () => {
    // The name alone proves nothing: an unmapped custom id resolves to the
    // default family, so the bar shows the DeepSeek chips, never codex.
    renderBar({
      settings: {
        model: "gpt-4o-custom",
        modelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
      } as Settings,
      codexQuota: GPT_QUOTA,
    });
    expect(screen.getByText("balance")).toBeTruthy();
    expect(screen.queryByText(/58%\s*left/)).toBeNull();
    expect(screen.queryByText("codex")).toBeNull();
  });

  it("treats gpt-oss-* (Antigravity-served) models as Antigravity tabs, never OpenAI", () => {
    renderBar({
      settings: { model: "gpt-oss-120b-medium" } as Settings,
      codexQuota: GPT_QUOTA,
      antigravityQuota: {
        ...ANTIGRAVITY_QUOTA,
        windows: [
          { modelId: "gpt-oss-120b-medium", usedFraction: 0.1, resetTime: "2026-09-01T13:37:06Z" },
        ],
      },
    });
    // The Antigravity quota chips render — plan name + window %.
    expect(screen.getByText(/90%\s*left/)).toBeTruthy();
    expect(screen.getByText("Antigravity")).toBeTruthy();
    expect(screen.getByText(/0\.4%/)).toBeTruthy();
    // The OpenAI codex quota never leaks onto the tab despite the gpt- prefix.
    expect(screen.queryByText(/58%\s*left/)).toBeNull();
    expect(screen.queryByText("codex")).toBeNull();
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/\$ 0\./)).toBeNull();
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

  it("shows only quota percentages for an Antigravity tab", () => {
    renderBar({
      settings: { model: "gemini-3.6-flash" } as Settings,
      antigravityQuota: ANTIGRAVITY_QUOTA,
      usage: { totalCostUsd: 1.5, lastCallCostUsd: 0.25 } as unknown as UsageStats,
    });
    expect(screen.getByText(/90%\s*left/)).toBeTruthy();
    expect(screen.getByText("Antigravity")).toBeTruthy();
    expect(screen.getByText(/0\.4%/)).toBeTruthy();
    expect(screen.queryByText("balance")).toBeNull();
    expect(screen.queryByText(/This session cost/)).toBeNull();
    expect(screen.queryByText(/\$ 0\./)).toBeNull();
  });

  it("shows an em dash for the Antigravity chip when no quota data exists", () => {
    renderBar({
      settings: { model: "gemini-3.7-flash" } as Settings,
      antigravityQuota: null,
    });
    expect(screen.getByText("plan usage")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTitle(/sign in to Google Antigravity/)).toBeTruthy();
    expect(screen.queryByText("balance")).toBeNull();
  });
});
