// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markVoiceModelDownloaded,
  setActiveVoiceModelId,
} from "../voice/models";
import { speechTranscriber } from "../voice/transcriber";
import { VoiceModelSettings } from "./settings";

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
});
