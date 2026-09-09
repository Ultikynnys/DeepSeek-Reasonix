// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpExtensionStatus, McpSpecInfo } from "../protocol";
import { PageMCP } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

function spec(overrides: Partial<McpSpecInfo> = {}): McpSpecInfo {
  return {
    raw: "playwright=npx -y @playwright/mcp --extension",
    name: "playwright",
    transport: "stdio",
    summary: "browser automation via accessibility snapshots",
    status: "connected",
    toolCount: 24,
    disabled: false,
    ...overrides,
  };
}

function extensionStatus(): McpExtensionStatus {
  return {
    storeUrl: "https://chromewebstore.google.com/detail/playwright-extension",
    bundled: { present: false, path: null, version: null },
    server: {
      configured: true,
      hasExtensionArg: true,
      profileDirName: null,
      hasToken: false,
      args: ["-y", "@playwright/mcp", "--extension"],
    },
  };
}

function renderCard(specs: McpSpecInfo[], status: McpExtensionStatus | null = extensionStatus()) {
  return render(
    <PageMCP
      specs={specs}
      bridged
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onToggleServer={vi.fn()}
      onToggleTool={vi.fn()}
      extensionStatus={status}
      onRequestExtensionStatus={vi.fn()}
      onConfigureExtension={vi.fn()}
    />,
  );
}

describe("PageMCP — playwright connection status", () => {
  it("shows live connection state with the tool count when bridged", () => {
    renderCard([spec()]);
    expect(screen.getByText(/server connected · 24 tools live/)).toBeTruthy();
  });

  it("shows the failure reason when the bridge failed", () => {
    renderCard([spec({ status: "failed", toolCount: 0, statusReason: "spawn crashed" })]);
    expect(screen.getByText(/server failed — spawn crashed/)).toBeTruthy();
    expect(screen.queryByText(/tools live/)).toBeNull();
  });

  it("shows idle text when configured but not bridged yet", () => {
    renderCard([spec({ status: "configured", toolCount: 0 })]);
    expect(screen.getByText(/configured but not bridged yet/)).toBeTruthy();
  });

  it("shows the disabled state for a toggled-off server", () => {
    renderCard([spec({ status: "disabled", disabled: true, toolCount: 0 })]);
    expect(screen.getByText(/server disabled — enable it to bridge/)).toBeTruthy();
  });

  it("shows no connection line when no playwright spec exists", () => {
    renderCard([]);
    expect(screen.queryByText(/server connected/)).toBeNull();
    expect(screen.queryByText(/not bridged yet/)).toBeNull();
  });
});