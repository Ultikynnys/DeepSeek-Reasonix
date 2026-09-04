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
        workspace: "/repo",
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
        workspace: "/repo",
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

  it("triggers onCompact when clicking the compact button in token header", () => {
    const onCompact = vi.fn();
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
        onCompact={onCompact}
      />,
    );

    const btn = screen.getByTitle("Force context compaction (fold older turns into a summary)");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("renders custom approval rules and allows removing them", () => {
    const onRemoveRule = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          shellAllowed: ["git status", "cargo test"],
          pathAllowed: ["/opt/sdk"],
        }}
        usage={usage}
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
        onRemoveRule={onRemoveRule}
      />,
    );

    // Switch to Rules tab
    fireEvent.click(screen.getByText("Rules"));

    expect(screen.getByText("git status")).toBeTruthy();
    expect(screen.getByText("cargo test")).toBeTruthy();
    expect(screen.getByText("/opt/sdk")).toBeTruthy();

    const removeBtn = screen.getByRole("button", { name: "Remove rule: git status" });
    fireEvent.click(removeBtn);
    expect(onRemoveRule).toHaveBeenCalledWith("shell", "git status");
  });

  it("allows adding a new rule via the form", () => {
    const onAddRule = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
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
        onAddRule={onAddRule}
      />,
    );

    // Switch to Rules tab
    fireEvent.click(screen.getByText("Rules"));

    const input = screen.getByRole("textbox", { name: "Rule pattern" });
    fireEvent.change(input, { target: { value: "npm run build" } });

    const addBtn = screen.getByRole("button", { name: "Add Rule" });
    fireEvent.click(addBtn);

    expect(onAddRule).toHaveBeenCalledWith("shell", "npm run build");
  });

  it("renders context window slider in the Tools tab and commits updates", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{ ...settings, contextTokens: 500_000 }}
        usage={usage}
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
        onSaveSettings={onSaveSettings}
      />,
    );

    // Switch to Tools tab
    fireEvent.click(screen.getByText("Tools"));

    const slider = screen.getByRole("slider", { name: "Context window" });
    expect(slider).toBeTruthy();
    expect(slider.getAttribute("min")).toBe("128000");
    expect(slider.getAttribute("max")).toBe("1000000");
    expect((slider as HTMLInputElement).value).toBe("500000");
    expect(screen.getByText("500K (500,000)")).toBeTruthy();

    // Adjust the slider and release
    fireEvent.change(slider, { target: { value: "750000" } });
    fireEvent.pointerUp(slider);
    expect(onSaveSettings).toHaveBeenCalledWith({ contextTokens: 750_000 });

    // Click reset button
    const resetBtn = screen.getByTitle("Reset to model default");
    expect(resetBtn).toBeTruthy();
    fireEvent.click(resetBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ contextTokens: null });
  });
});
