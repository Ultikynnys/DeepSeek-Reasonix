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
  outlookMailAuth: Parameters<typeof PageMCP>[0]["outlookMailAuth"] = null,
  onConnectOutlookMail = vi.fn(),
  onRequestOutlookMailStatus = vi.fn(),
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
      outlookMailAuth={outlookMailAuth}
      onRequestOutlookMailStatus={onRequestOutlookMailStatus}
      onConfigureOutlookMail={vi.fn()}
      onConnectOutlookMail={onConnectOutlookMail}
      onCancelOutlookMail={vi.fn()}
      onSignOutOutlookMail={vi.fn()}
    />,
  );
}

describe("PageMCP: Outlook Mail", () => {
  it("offers first-class configuration without exposing credentials", () => {
    renderCard([]);
    expect(screen.getByRole("button", { name: "Configure Outlook Mail" })).toBeTruthy();
    expect(screen.getByText(/OAuth tokens stay in the local MCP server/)).toBeTruthy();
  });

  it("shows the Microsoft device code and opens the system browser from the card", async () => {
    renderCard([], extensionStatus(), null, vi.fn(), vi.fn(), null, {
      configured: true,
      phase: "device-code",
      verificationUrl: "https://microsoft.com/devicelogin",
      userCode: "ABCD-EFGH",
      message: "Enter the code",
    });
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Microsoft sign-in" }));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://microsoft.com/devicelogin");
    });
  });

  it("connects a configured personal account from the UI", () => {
    const connect = vi.fn();
    renderCard(
      [],
      extensionStatus(),
      null,
      vi.fn(),
      vi.fn(),
      null,
      { configured: true, phase: "disconnected" },
      connect,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Microsoft account" }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it("tests an existing connection without starting OAuth", () => {
    const connect = vi.fn();
    const testConnection = vi.fn();
    renderCard(
      [],
      extensionStatus(),
      null,
      vi.fn(),
      vi.fn(),
      null,
      { configured: true, phase: "connected", account: "ada@outlook.com" },
      connect,
      testConnection,
    );
    testConnection.mockClear(); // Ignore the card's initial status refresh.
    const buttons = screen.getAllByRole("button", { name: "Test connection" });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(testConnection).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });

  it("shows disabled progress while testing the connection", () => {
    renderCard([], extensionStatus(), null, vi.fn(), vi.fn(), null, {
      configured: true,
      phase: "checking",
    });
    const button = screen.getByRole("button", { name: "Testing connection…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

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

  it("opens the extension listing in the selected browser", async () => {
    renderCard([spec()]);
    fireEvent.click(screen.getByRole("button", { name: "Open extension listing" }));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(extensionStatus().storeUrl, "chrome.exe");
    });
  });

  it("opens the extension listing in Edge when Edge is selected", async () => {
    renderCard([spec()]);
    fireEvent.change(screen.getByLabelText("Extension browser"), { target: { value: "msedge" } });
    fireEvent.click(screen.getByRole("button", { name: "Open extension listing" }));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(extensionStatus().storeUrl, "msedge.exe");
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
    expect(onConfigure).toHaveBeenCalledWith("webkit", undefined, undefined, undefined);
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
    expect(screen.getByText("Preparing browser download…")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Browser download progress" })).toBeTruthy();
    cleanup();
    renderCard(
      [spec()],
      status,
      null,
      vi.fn(),
      vi.fn(),
      {
        phase: "running",
        browser: "firefox",
        downloadedBytes: 50 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024,
        percent: 50,
        bytesPerSecond: 2 * 1024 * 1024,
      },
    );
    expect(screen.getByText("50.0 MB / 100 MB · 50%")).toBeTruthy();
    expect(screen.getByText("2.0 MB/s")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Browser download progress" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("50");
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
    expect(onConfigure).toHaveBeenCalledWith("cdp", undefined, "http://localhost:9222", undefined);
  });

  it("offers a Chrome/Edge picker for extension mode and forwards the choice", () => {
    const onConfigure = vi.fn();
    renderCard([spec()], extensionStatus(), null, onConfigure);
    fireEvent.change(screen.getByLabelText("Extension browser"), { target: { value: "msedge" } });
    fireEvent.click(screen.getByRole("button", { name: "Reconfigure server" }));
    expect(onConfigure).toHaveBeenCalledWith("extension", undefined, undefined, "msedge");
  });

  it("hides the Remove button for a built-in server", () => {
    renderCard([spec({ builtin: true })]);
    expect(screen.getByText(/built-in/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("keeps the Remove button for a user-added server", () => {
    renderCard([spec()]);
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.queryByText(/built-in/)).toBeNull();
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
