// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  maxIterPerTurn: 50,
  maxIterPerTurnOverride: null,
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
        settings={{
          ...settings,
          contextTokens: 500_000,
          maxIterPerTurn: 75,
          maxIterPerTurnOverride: 75,
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

    const iterationSlider = screen.getByRole("slider", { name: "Max iterations" });
    expect(iterationSlider.getAttribute("min")).toBe("50");
    expect(iterationSlider.getAttribute("max")).toBe("100");
    expect(iterationSlider.getAttribute("step")).toBe("1");
    expect((iterationSlider as HTMLInputElement).value).toBe("75");
    expect(screen.getByText("75 iters")).toBeTruthy();

    fireEvent.change(iterationSlider, { target: { value: "90" } });
    fireEvent.pointerUp(iterationSlider);
    expect(onSaveSettings).toHaveBeenCalledWith({ maxIterPerTurn: 90 });

    const iterationReset = screen.getByTitle("Reset to environment or default (50)");
    fireEvent.click(iterationReset);
    expect(onSaveSettings).toHaveBeenCalledWith({ maxIterPerTurn: null });
  });

  it("hides Ollama generation controls when neither endpoint is Ollama", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
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
      />,
    );
    fireEvent.click(screen.getByText("Tools"));
    expect(screen.queryByTestId("ollama-generation-settings")).toBeNull();
  });

  it("shows Ollama generation controls when the main model endpoint is Ollama", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          ollamaGeneration: {
            temperature: 0.5,
            topP: 0.9,
            topK: 40,
            minP: 0.05,
            seed: 42,
            keepAlive: "30m",
            repeatPenalty: 1.3,
            frequencyPenalty: 0.5,
            presencePenalty: 0.4,
            repeatLastN: 128,
          },
          ollamaGenerationOverrides: { temperature: 0.5, seed: 42 },
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
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Tools"));

    const section = screen.getByTestId("ollama-generation-settings");
    expect(section).toBeTruthy();

    // Placed after Max iterations, before MCP servers.
    const maxIter = screen.getByRole("slider", { name: "Max iterations" });
    const mcp = screen.getByText("MCP servers");
    expect(
      maxIter.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      section.compareDocumentPosition(mcp) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Commit a temperature edit on blur.
    const temp = screen.getByRole("spinbutton", { name: "Temperature" });
    fireEvent.change(temp, { target: { value: "0.7" } });
    fireEvent.blur(temp);
    expect(onSaveSettings).toHaveBeenCalledWith({ ollamaGeneration: { temperature: 0.7 } });

    // Reset an overridden field, scoped to the temperature row.
    const tempRow = temp.closest("label") as HTMLElement;
    const reset = within(tempRow).getByTitle(
      "Reset to environment, Reasonix default, or model default",
    );
    fireEvent.click(reset);
    expect(onSaveSettings).toHaveBeenCalledWith({ ollamaGeneration: { temperature: null } });
  });

  it("saves a sampling value immediately on change, without waiting for blur", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          ollamaGeneration: { temperature: 0.5, keepAlive: "30m" },
          ollamaGenerationOverrides: {},
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
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Tools"));

    vi.useFakeTimers();
    try {
      const temp = screen.getByRole("spinbutton", { name: "Temperature" });
      // Change without blurring — the value should persist on its own.
      fireEvent.change(temp, { target: { value: "0.7" } });
      vi.advanceTimersByTime(200);
      expect(onSaveSettings).toHaveBeenCalledWith({ ollamaGeneration: { temperature: 0.7 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders 5 Ollama sampling preset buttons and applies presets on click", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          ollamaGeneration: {
            temperature: 0.2,
            topP: 0.9,
            topK: 40,
            keepAlive: "30m",
          },
          ollamaGenerationOverrides: {
            temperature: 0.2,
            topP: 0.9,
            topK: 40,
          },
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
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Tools"));

    const defaultBtn = screen.getByRole("button", { name: "Default" });
    const codingBtn = screen.getByRole("button", { name: "Coding" });
    const balancedBtn = screen.getByRole("button", { name: "Balanced" });
    const creativeBtn = screen.getByRole("button", { name: "Creative" });
    const antiLoopBtn = screen.getByRole("button", { name: "Anti-loop" });

    expect(defaultBtn).toBeTruthy();
    expect(codingBtn).toBeTruthy();
    expect(balancedBtn).toBeTruthy();
    expect(creativeBtn).toBeTruthy();
    expect(antiLoopBtn).toBeTruthy();

    // With temperature 0.2, topP 0.9, topK 40 and others null, Coding is active
    expect(codingBtn.getAttribute("data-active")).toBe("true");
    expect(defaultBtn.getAttribute("data-active")).toBeNull();

    // Clicking Balanced applies the balanced preset
    fireEvent.click(balancedBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({
      ollamaGeneration: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        seed: null,
        repeatPenalty: null,
        repeatLastN: null,
        frequencyPenalty: null,
        presencePenalty: null,
      },
    });

    // Clicking Default clears all overrides to model defaults
    fireEvent.click(defaultBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({
      ollamaGeneration: {
        temperature: null,
        topP: null,
        topK: null,
        minP: null,
        seed: null,
        repeatPenalty: null,
        repeatLastN: null,
        frequencyPenalty: null,
        presencePenalty: null,
      },
    });
  });

  it("shows Ollama generation controls when only the subagent endpoint is Ollama", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          subagentModelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
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
      />,
    );
    fireEvent.click(screen.getByText("Tools"));
    expect(screen.getByTestId("ollama-generation-settings")).toBeTruthy();
  });

  it("renders Auto-compaction toggle in Tools section and updates setting", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{ ...settings, disableAutoCompaction: false }}
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
    fireEvent.click(screen.getByText("Tools"));

    expect(screen.getByText("Auto-compaction")).toBeTruthy();
    const enabledBtn = screen.getByRole("button", { name: "Enabled" });
    const disabledBtn = screen.getByRole("button", { name: "Disabled" });

    expect(enabledBtn.getAttribute("data-on")).toBe("true");
    expect(disabledBtn.getAttribute("data-on")).toBe("false");

    fireEvent.click(disabledBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ disableAutoCompaction: true });
  });

  it("displays auto-compaction disabled indicator in context meter legend when active", () => {
    render(
      <ContextPanel
        settings={{ ...settings, disableAutoCompaction: true }}
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
      />,
    );

    expect(screen.getByText("auto-compaction disabled")).toBeTruthy();
  });
});
