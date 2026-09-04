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

  it("is disabled when busy prop is true", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} busy onSend={onSend} />);

    const proceedBtn = screen.getByRole("button", { name: /Proceed/i });
    expect(proceedBtn.hasAttribute("disabled")).toBe(true);

    fireEvent.click(proceedBtn);
    expect(onSend).not.toHaveBeenCalled();
  });
});
