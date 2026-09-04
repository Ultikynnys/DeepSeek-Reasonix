// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  onVoiceError: vi.fn(),
  textareaRef: { current: null },
} as const;

describe("Composer quick send Proceed button", () => {
  it("renders the quick proceed button with label and title", () => {
    render(<Composer {...baseProps} />);

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    expect(proceedBtn).toBeTruthy();
    expect(proceedBtn.getAttribute("title")).toBe("Quick send");
  });

  it("calls onSend with 'proceed' when clicked", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} />);

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    fireEvent.click(proceedBtn);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("proceed");
  });

  it("clears draft and calls onSend with 'proceed' when clicked with active draft", () => {
    const onSend = vi.fn();
    const setDraft = vi.fn();
    render(
      <Composer {...baseProps} draft="some unfinished text" setDraft={setDraft} onSend={onSend} />,
    );

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    fireEvent.click(proceedBtn);

    expect(setDraft).toHaveBeenCalledWith("");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("proceed");
  });

  it("is enabled when draft is empty (unlike regular send button)", () => {
    render(<Composer {...baseProps} draft="" />);

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    expect(proceedBtn.hasAttribute("disabled")).toBe(false);
  });

  it("is disabled when disabled prop is true", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} disabled onSend={onSend} />);

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    expect(proceedBtn.hasAttribute("disabled")).toBe(true);

    fireEvent.click(proceedBtn);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("remains enabled when busy and queues the quick send message via onQueueWhileBusy", () => {
    const onSend = vi.fn();
    const onQueueWhileBusy = vi.fn();
    render(
      <Composer
        {...baseProps}
        busy
        onSend={onSend}
        onQueueWhileBusy={onQueueWhileBusy}
      />,
    );

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    expect(proceedBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(proceedBtn);
    expect(onSend).not.toHaveBeenCalled();
    expect(onQueueWhileBusy).toHaveBeenCalledTimes(1);
    expect(onQueueWhileBusy).toHaveBeenCalledWith({ text: "proceed", echo: "proceed" });
  });

  it("queues custom quickSend with message and shorthand when clicked while busy", () => {
    const onSend = vi.fn();
    const onQueueWhileBusy = vi.fn();
    const quickSend = {
      id: "commit-and-push",
      label: "Commit and Push all changes",
      message: "commit and push all changes",
      shorthand: "commit and push",
    };
    render(
      <Composer
        {...baseProps}
        busy
        quickSend={quickSend}
        onSend={onSend}
        onQueueWhileBusy={onQueueWhileBusy}
      />,
    );

    const btn = screen.getByRole("button", { name: "commit and push" });
    expect(btn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(btn);
    expect(onSend).not.toHaveBeenCalled();
    expect(onQueueWhileBusy).toHaveBeenCalledTimes(1);
    expect(onQueueWhileBusy).toHaveBeenCalledWith({
      text: "commit and push all changes",
      echo: "commit and push",
    });
  });

  it("renders quickSend shorthand instead of label on the button", () => {
    const quickSend = {
      id: "commit-and-push",
      label: "Commit and Push all changes",
      message: "commit and push all changes",
      shorthand: "commit and push",
    };
    render(<Composer {...baseProps} quickSend={quickSend} />);

    expect(screen.getByRole("button", { name: "commit and push" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Commit and Push all changes" })).toBeNull();
  });

  it("sends message and echoes shorthand when quickSend is clicked", () => {
    const onSend = vi.fn();
    const quickSend = {
      id: "commit-and-push",
      label: "Commit and Push all changes",
      message: "commit and push all changes",
      shorthand: "commit and push",
    };
    render(<Composer {...baseProps} quickSend={quickSend} onSend={onSend} />);

    const btn = screen.getByRole("button", { name: "commit and push" });
    fireEvent.click(btn);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      text: "commit and push all changes",
      echo: "commit and push",
    });
  });
});

describe("Composer voice button availability", () => {
  it("is enabled by default when voiceAvailable is omitted", () => {
    render(<Composer {...baseProps} />);

    const voiceBtn = screen.getByTitle("Voice input");
    expect(voiceBtn.hasAttribute("disabled")).toBe(false);
  });

  it("is disabled when no voice model is installed", () => {
    render(<Composer {...baseProps} voiceAvailable={false} />);

    const voiceBtn = screen.getByTitle(/No voice model installed/);
    expect(voiceBtn.hasAttribute("disabled")).toBe(true);
  });
});
