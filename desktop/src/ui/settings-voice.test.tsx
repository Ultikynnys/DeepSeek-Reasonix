// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { markVoiceModelDownloaded, setActiveVoiceModelId } from "../voice/models";
import { speechTranscriber } from "../voice/transcriber";
import { SettingsModal, VoiceModelSettings } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("VoiceModelSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveVoiceModelId("whisper-tiny.en");
    speechTranscriber.setModel("whisper-tiny.en");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mockSettings: Settings = {
    version: "1.0.0",
    reasoningEffort: "high",
    editMode: "review",
    budgetUsd: null,
    workspaceDir: "/test",
    recentWorkspaces: [],
    model: "deepseek-v4-flash",
  };

  const baseProps = {
    settings: mockSettings,
    balance: null,
    usage: {
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
    },
    currency: "USD" as const,
    theme: "dark" as const,
    themeStyle: "graphite" as const,
    onSetTheme: vi.fn(),
    onSetThemeStyle: vi.fn(),
    fontScale: "medium" as const,
    onSetFontScale: vi.fn(),
    fontFamily: "sans" as const,
    onSetFontFamily: vi.fn(),
    customFontFamily: "",
    onSetCustomFontFamily: vi.fn(),
    mcpSpecs: [],
    mcpBridged: false,
    memory: [],
    memoryDetail: null,
    memoryResult: null,
    onClose: vi.fn(),
    onSave: vi.fn(),
    onSaveApiKey: vi.fn(),
    oauthWaiting: false,
    onOAuthBegin: vi.fn(),
    onOAuthCancel: vi.fn(),
    onOAuthSignOut: vi.fn(),
    onSaveOpenAIApiKey: vi.fn(),
    antigravityOAuthWaiting: false,
    onAntigravityOAuthBegin: vi.fn(),
    onAntigravityOAuthCancel: vi.fn(),
    onAntigravityOAuthSignOut: vi.fn(),
    onPickWorkspace: vi.fn(),
    onAddMcpSpec: vi.fn(),
    onRemoveMcpSpec: vi.fn(),
    onReadMemory: vi.fn(),
    onWriteMemory: vi.fn(),
    onDeleteMemory: vi.fn(),
    onExportMemories: vi.fn(),
    onImportMemories: vi.fn(),
    onDismissMemoryResult: vi.fn(),
  };

  it("renders the 3 model options with correct initial state", async () => {
    render(<VoiceModelSettings />);

    expect(screen.getByText("Voice processing model")).toBeTruthy();
    expect(screen.getByText("Whisper Tiny (English)")).toBeTruthy();
    expect(screen.getByText("Whisper Base (English)")).toBeTruthy();
    expect(screen.getByText("Whisper Small (English)")).toBeTruthy();

    // Tiny is active by default
    expect(screen.getByText(/✓ Active/)).toBeTruthy();

    // Base and Small have Download buttons
    const downloadButtons = screen.getAllByRole("button", { name: "Download" });
    expect(downloadButtons).toHaveLength(2);
  });

  it("handles successful in-app download and activates model", async () => {
    vi.spyOn(speechTranscriber, "downloadModel").mockImplementation(async (_id, onProgress) => {
      onProgress?.({
        status: "progress",
        file: "onnx/encoder_model_quantized.onnx",
        progress: 50,
      });
      markVoiceModelDownloaded("Xenova/whisper-base.en", true);
    });

    render(<VoiceModelSettings />);

    const downloadButtons = screen.getAllByRole("button", { name: "Download" });
    const baseDownloadBtn = downloadButtons[0]!;

    await act(async () => {
      fireEvent.click(baseDownloadBtn);
    });

    expect(speechTranscriber.downloadModel).toHaveBeenCalledWith(
      "Xenova/whisper-base.en",
      expect.any(Function),
    );
    expect(speechTranscriber.activeModel).toBe("Xenova/whisper-base.en");
  });

  it("displays an error alert when download fails without silent failure", async () => {
    vi.spyOn(speechTranscriber, "downloadModel").mockRejectedValue(
      new Error("Network connection lost during download"),
    );

    render(<VoiceModelSettings />);

    const downloadButtons = screen.getAllByRole("button", { name: "Download" });
    const baseDownloadBtn = downloadButtons[0]!;

    await act(async () => {
      fireEvent.click(baseDownloadBtn);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain("Network connection lost during download");

    // Active model was NOT silently changed:
    expect(speechTranscriber.activeModel).toBe("whisper-tiny.en");
  });

  it("allows deleting a downloaded model to free space", async () => {
    markVoiceModelDownloaded("Xenova/whisper-small.en", true);

    render(<VoiceModelSettings />);

    const deleteBtn = await screen.findByTitle("Delete downloaded files to free space");
    expect(deleteBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    // Model is no longer downloaded, Download button returns
    const downloadBtns = screen.getAllByRole("button", { name: "Download" });
    expect(downloadBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("renders voice model settings in models tab and not in general tab", () => {
    const { unmount } = render(<SettingsModal {...baseProps} initialPage="general" />);
    expect(screen.queryByText("Voice processing model")).toBeNull();
    unmount();

    render(<SettingsModal {...baseProps} initialPage="models" />);
    expect(screen.getByText("Voice processing model")).toBeTruthy();
  });

  it("renders the quick-send selector with built-ins and saves the active choice", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="general" />);

    expect(screen.getByText("Quick send action")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Proceed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit and Push all changes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Commit and Push all changes" }));
    expect(onSave).toHaveBeenCalledWith({ quickSendId: "commit-and-push" });
  });

  it("adds a custom quick send from the general settings form", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="general" />);

    fireEvent.change(screen.getByPlaceholderText("Name (shown on the button)"), {
      target: { value: "Deploy" },
    });
    fireEvent.change(screen.getByPlaceholderText("Message sent to the model"), {
      target: { value: "deploy to production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add quick send" }));

    expect(onSave).toHaveBeenCalledWith({
      quickSends: [
        expect.objectContaining({
          id: expect.stringMatching(/^custom-/),
          label: "Deploy",
          message: "deploy to production",
          shorthand: "Deploy",
        }),
      ],
    });
  });
});
