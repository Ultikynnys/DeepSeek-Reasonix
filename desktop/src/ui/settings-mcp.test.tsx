// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpExtensionStatus, McpSpecInfo } from "../protocol";
import { PageMCP } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

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
      mode: "extension",
      hasExtensionArg: true,
      tokenPrefix: undefined,
      args: ["-y", "@playwright/mcp", "--extension"],
    },
  };
}

function renderCard(
  specs: McpSpecInfo[],
  status: McpExtensionStatus | null = extensionStatus(),
  extensionCheck: Parameters<typeof PageMCP>[0]["extensionCheck"] = null,
  onConfigureExtension = vi.fn(),
  onInstallBrowser = vi.fn(),
  browserInstall: Parameters<typeof PageMCP>[0]["browserInstall"] = null,
) {
  return render(
    <PageMCP
      specs={specs}
      bridged
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onToggleServer={vi.fn()}
      onToggleTool={vi.fn()}
      extensionStatus={status}
      extensionCheck={extensionCheck}
      browserInstall={browserInstall}
      onRequestExtensionStatus={vi.fn()}
      onConfigureExtension={onConfigureExtension}
      onCheckExtension={vi.fn()}
      onInstallBrowser={onInstallBrowser}
    />,
  );
}

describe("PageMCP — playwright connection status", () => {
  it("shows a saved token's redacted identifier in the password field", () => {
    const status = extensionStatus();
    status.server.tokenPrefix = "K3MM1p…6VE";
    renderCard([spec()], status);
    const input = screen.getByPlaceholderText("K3MM1p…6VE") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(screen.getByText(/token saved/)).toBeTruthy();
  });

  it("opens the extension listing through the system URL opener", async () => {
    renderCard([spec()]);
    fireEvent.click(screen.getByRole("button", { name: "Open extension listing" }));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(extensionStatus().storeUrl);
    });
  });

  it("configures each managed browser explicitly", () => {
    const status = extensionStatus();
    status.server.mode = "firefox";
    status.server.hasExtensionArg = false;
    status.server.args = ["-y", "@playwright/mcp", "--browser=firefox"];
    const onConfigure = vi.fn();
    renderCard([spec()], status, null, onConfigure);
    expect(screen.queryByRole("button", { name: "Open extension listing" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Browser connection"), { target: { value: "webkit" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure server" }));
    expect(onConfigure).toHaveBeenCalledWith("webkit", undefined, undefined);
  });

  it("offers the managed Firefox installer and dispatches it", () => {
    const status = extensionStatus();
    status.server.mode = "firefox";
    status.server.hasExtensionArg = false;
    const onInstall = vi.fn();
    renderCard([spec()], status, null, vi.fn(), onInstall);
    fireEvent.click(screen.getByRole("button", { name: "Install firefox" }));
    expect(onInstall).toHaveBeenCalledWith("firefox");
  });

  it("shows managed-browser installation progress and results", () => {
    const status = extensionStatus();
    status.server.mode = "firefox";
    status.server.hasExtensionArg = false;
    renderCard(
      [spec()],
      status,
      null,
      vi.fn(),
      vi.fn(),
      { phase: "running", browser: "firefox" },
    );
    expect(
      (screen.getByRole("button", { name: "Installing browser…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    renderCard(
      [spec()],
      status,
      null,
      vi.fn(),
      vi.fn(),
      { phase: "done", browser: "firefox", ok: true, reason: null },
    );
    expect(screen.getByText(/firefox installed/)).toBeTruthy();
  });

  it("passes a CDP endpoint for other Chromium browsers", () => {
    const onConfigure = vi.fn();
    renderCard([spec()], extensionStatus(), null, onConfigure);
    fireEvent.change(screen.getByLabelText("Browser connection"), { target: { value: "cdp" } });
    fireEvent.change(screen.getByLabelText("Chromium CDP endpoint"), {
      target: { value: "http://localhost:9222" },
    });
    expect(screen.queryByText(/Install cdp/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure server" }));
    expect(onConfigure).toHaveBeenCalledWith("cdp", undefined, "http://localhost:9222");
  });

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

  it("shows the running phase while the relay probe is in flight", () => {
    renderCard([spec()], extensionStatus(), { phase: "running" });
    expect(screen.getByText(/testing relay/)).toBeTruthy();
  });

  it("shows the successful check verdict with elapsed time", () => {
    renderCard([spec()], extensionStatus(), {
      phase: "done",
      ok: true,
      reason: null,
      elapsedMs: 1400,
    });
    expect(screen.getByText(/token works — browser attached in 1400 ms/)).toBeTruthy();
  });

  it("shows the failed check verdict with the reason", () => {
    renderCard([spec()], extensionStatus(), {
      phase: "done",
      ok: false,
      reason: "no browser responded within 25s — the stored token is likely wrong",
      elapsedMs: 25000,
    });
    expect(screen.getByText(/✗ no browser responded/)).toBeTruthy();
  });
});
