// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(cleanup);

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

  it("disables voice button when composer is disabled or busy", () => {
    const { rerender } = render(<Composer {...baseProps} disabled={true} />);
    let voiceBtn = screen.getByTitle("Voice input") as HTMLButtonElement;
    expect(voiceBtn.disabled).toBe(true);

    rerender(<Composer {...baseProps} busy={true} />);
    voiceBtn = screen.getByTitle("Voice input") as HTMLButtonElement;
    expect(voiceBtn.disabled).toBe(true);
  });
});
