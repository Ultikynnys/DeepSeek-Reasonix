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

  it("falls back to the balance display when quota data is missing", () => {
    renderBar({
      settings: { model: "gpt-5.6-sol" } as Settings,
      codexQuota: null,
    });
    expect(screen.getByText("balance")).toBeTruthy();
    expect(screen.queryByText("codex")).toBeNull();
  });
});
