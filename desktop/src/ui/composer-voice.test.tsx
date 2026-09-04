// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

let resolveTranscribe: ((res: { text: string }) => void) | null = null;

vi.mock("../voice/audio-recorder", () => {
  return {
    AudioRecorder: vi.fn().mockImplementation(() => ({
      recording: true,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue({ audioData: new Float32Array(100), durationSeconds: 1 }),
      cancel: vi.fn(),
    })),
  };
});

vi.mock("../voice/transcriber", () => {
  return {
    speechTranscriber: {
      transcribe: vi.fn().mockImplementation(() => {
        return new Promise<{ text: string }>((resolve) => {
          resolveTranscribe = resolve;
        });
      }),
    },
  };
});

afterEach(cleanup);

import { AudioRecorder } from "../voice/audio-recorder";
import { speechTranscriber } from "../voice/transcriber";
import { Composer } from "./composer";

const baseProps = {
  draft: "",
  setDraft: vi.fn(),
  onSend: vi.fn(),
  onAbort: vi.fn(),
  modelLabel: "deepseek-v4-flash",
  reasoningEffort: "high",
  onModelChange: vi.fn(),
  onEffortChange: vi.fn(),
  editMode: "review",
  onEditModeChange: vi.fn(),
  onVoiceError: vi.fn(),
  textareaRef: { current: null },
} as const;

describe("Composer Voice Input Button", () => {
  it("renders the voice input button with idle title", () => {
    render(<Composer {...baseProps} />);

    const voiceBtn = screen.getByTitle("Voice input");
    expect(voiceBtn).toBeTruthy();
    expect(voiceBtn.classList.contains("voice-btn")).toBe(true);
    expect(voiceBtn.classList.contains("recording")).toBe(false);
  });

  it("disables voice button when composer is disabled, but keeps it enabled when busy for queueing", async () => {
    const { rerender } = render(<Composer {...baseProps} disabled={true} />);
    let voiceBtn = screen.getByTitle("Voice input") as HTMLButtonElement;
    expect(voiceBtn.disabled).toBe(true);

    // When conversation is active (busy=true), voice input remains enabled so users can queue voice messages
    rerender(<Composer {...baseProps} busy={true} />);
    voiceBtn = screen.getByTitle("Voice input") as HTMLButtonElement;
    expect(voiceBtn.disabled).toBe(false);

    // Can start recording while busy
    await act(async () => {
      fireEvent.click(voiceBtn);
    });
    expect(voiceBtn.classList.contains("recording")).toBe(true);
  });

  it("reports microphone startup failures through the durable chat callback", async () => {
    const onVoiceError = vi.fn();
    vi.mocked(AudioRecorder).mockImplementationOnce(
      () =>
        ({
          recording: false,
          start: vi.fn().mockRejectedValue(new Error("name=NotAllowedError, message=Blocked")),
          stop: vi.fn(),
          cancel: vi.fn(),
        }) as unknown as AudioRecorder,
    );
    render(<Composer {...baseProps} onVoiceError={onVoiceError} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle("Voice input"));
    });

    expect(onVoiceError).toHaveBeenCalledWith(
      "Voice input failed during microphone startup: name=NotAllowedError, message=Blocked",
    );
  });

  it("reports an empty recognizer result through the durable chat callback", async () => {
    const onVoiceError = vi.fn();
    vi.mocked(speechTranscriber.transcribe).mockResolvedValueOnce({ text: "" });
    render(<Composer {...baseProps} onVoiceError={onVoiceError} />);

    const voiceButton = screen.getByTitle("Voice input");
    await act(async () => {
      fireEvent.click(voiceButton);
    });
    await act(async () => {
      fireEvent.click(voiceButton);
    });

    expect(onVoiceError).toHaveBeenCalledWith(
      "Voice input failed during recording or transcription: The speech recognizer returned no transcript.",
    );
  });

  it("shows the transcribing throbber even while the chat is busy (queueing)", async () => {
    render(<Composer {...baseProps} busy={true} />);

    const voiceBtn = screen.getByTitle("Voice input") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(voiceBtn);
    });
    await act(async () => {
      fireEvent.click(voiceBtn);
    });

    expect(voiceBtn.classList.contains("transcribing")).toBe(true);
    const throbber = voiceBtn.querySelector(".voice-throbber");
    expect(throbber).toBeTruthy();
  });

  it("shows circular throbber as processing indicator when finished talking and transcribing", async () => {
    render(<Composer {...baseProps} />);

    const voiceBtn = screen.getByTitle("Voice input") as HTMLButtonElement;
    expect(voiceBtn.querySelector(".voice-throbber")).toBeNull();

    // Start recording
    await act(async () => {
      fireEvent.click(voiceBtn);
    });

    expect(voiceBtn.classList.contains("recording")).toBe(true);

    // Stop recording (finished talking) -> enters transcribing state
    await act(async () => {
      fireEvent.click(voiceBtn);
    });

    expect(voiceBtn.classList.contains("transcribing")).toBe(true);
    expect(voiceBtn.disabled).toBe(true);
    expect(voiceBtn.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTitle("Transcribing audio...")).toBeTruthy();

    const throbber = voiceBtn.querySelector(".voice-throbber");
    expect(throbber).toBeTruthy();
    expect(throbber?.classList.contains("spin")).toBe(true);
    expect(throbber?.classList.contains("processing-indicator")).toBe(true);
    expect(throbber?.getAttribute("role")).toBe("status");
    expect(throbber?.getAttribute("aria-label")).toBe("Transcribing audio...");

    // Complete transcription
    await act(async () => {
      if (resolveTranscribe) {
        resolveTranscribe({ text: "testing audio transcription" });
      }
    });

    expect(voiceBtn.classList.contains("transcribing")).toBe(false);
    expect(voiceBtn.getAttribute("aria-busy")).toBe("false");
    expect(voiceBtn.querySelector(".voice-throbber")).toBeNull();
  });
});
