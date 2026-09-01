// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UsageStats } from "../App";
import { ContextPanel } from "./context-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

const usage: UsageStats = {
  totalCostUsd: 0,
  lastCallCostUsd: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  lastCallCacheHit: null,
  lastCallCacheMiss: null,
  reservedTokens: 0,
  liveLogTokens: 0,
};

const settings: Settings = {
  reasoningEffort: "high",
  editMode: "review",
  budgetUsd: null,
  workspaceDir: "/repo",
  recentWorkspaces: [],
  model: "deepseek-reasoner",
  version: "0.0.0",
};

function renderPanel(overrides: Partial<Settings> = {}) {
  return render(
    <ContextPanel
      settings={{ ...settings, ...overrides }}
      usage={usage}
      mcpSpecs={[]}
      mcpBridged={false}
      sessionFiles={[{ path: "src/new-file.ts", status: "m" }]}
      memory={[]}
      memoryDetail={null}
      memoryResult={null}
      onReadMemory={() => {}}
      onWriteMemory={() => {}}
      onDeleteMemory={() => {}}
      onExportMemories={() => {}}
      onImportMemories={() => {}}
      onDismissMemoryResult={() => {}}
    />,
  );
}

describe("ContextPanel files", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(openPath).mockReset();
  });
  afterEach(cleanup);

  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn() },
      configurable: true,
    });
  });

  it("keeps each tracked file's full path visible", () => {
    const { container } = renderPanel();

    const fileRow = container.querySelector('[data-kind="file"]');

    expect(fileRow?.textContent).toContain("src/new-file.ts");
    expect(fileRow?.getAttribute("title")).toBe("src/new-file.ts");
  });

  it("opens a tracked file from the file row action", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Open file: src/new-file.ts" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/new-file.ts",
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens the file when the file row itself is clicked", async () => {
    const { container } = renderPanel();

    fireEvent.click(container.querySelector('[data-kind="file"]')!);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/new-file.ts",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("falls back to the OS default handler when the explorer command fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("spawn explorer.exe: boom"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Open file: src/new-file.ts" }));

    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/repo/src/new-file.ts"));
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it("copying a path does not open the file", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Copy path: src/new-file.ts" }));

    await waitFor(() =>
      expect(vi.mocked(navigator.clipboard.writeText)).toHaveBeenCalledWith("src/new-file.ts"),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("right-clicking a file row opens an Open-with… menu that fires open_with_dialog", async () => {
    const { container } = renderPanel();

    fireEvent.contextMenu(container.querySelector('[data-kind="file"]')!);

    const openWith = await screen.findByRole("menuitem", { name: "Open with…" });
    expect(openWith).toBeTruthy();

    fireEvent.click(openWith);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_with_dialog", {
        path: "/repo/src/new-file.ts",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("renders live log tokens even before final usage arrives", () => {
    render(
      <ContextPanel
        settings={settings}
        usage={{ ...usage, reservedTokens: 50, liveLogTokens: 100 }}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );

    expect(screen.getByText("150 / 300,000")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });
});
