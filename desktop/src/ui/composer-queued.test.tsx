// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// vitest runs with globals:false — testing-library's auto-cleanup never
// registers, so unmount between tests to keep queries unambiguous.
afterEach(cleanup);

import { Composer, type SlashCmd } from "./composer";

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
  slashCommands: [] as SlashCmd[],
} as const;

function renderQueued({
  queuedSends,
  onDequeueSend,
  onSendNow,
}: {
  queuedSends?: string[];
  onDequeueSend?: (index: number) => void;
  onSendNow?: () => void;
}) {
  return render(
    <Composer
      {...baseProps}
      queuedSends={queuedSends ?? []}
      onDequeueSend={onDequeueSend}
      onSendNow={onSendNow}
    />,
  );
}

describe("Composer queued-sends row", () => {
  it("renders the queue label, per-message chips, and a Send now button", () => {
    renderQueued({
      queuedSends: ["first message", "second message"],
      onDequeueSend: vi.fn(),
      onSendNow: vi.fn(),
    });

    expect(screen.getByText("queued 2")).toBeTruthy();
    expect(screen.getByText("first message")).toBeTruthy();
    expect(screen.getByText("second message")).toBeTruthy();
    expect(screen.getByText("send now")).toBeTruthy();
  });

  it("removing a chip calls onDequeueSend with its index", () => {
    const onDequeueSend = vi.fn();
    renderQueued({
      queuedSends: ["first message", "second message"],
      onDequeueSend,
      onSendNow: vi.fn(),
    });

    const removeButtons = document.querySelectorAll(".composer-queue-chip .x");
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[1]);
    expect(onDequeueSend).toHaveBeenCalledWith(1);
  });

  it("Send now fires onSendNow", () => {
    const onSendNow = vi.fn();
    renderQueued({ queuedSends: ["queued text"], onSendNow });

    fireEvent.click(screen.getByText("send now"));
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it("omits the Send now button when onSendNow is not wired", () => {
    renderQueued({ queuedSends: ["queued text"], onDequeueSend: vi.fn() });
    expect(screen.queryByText("send now")).toBeNull();
  });

  it("renders nothing when the queue is empty", () => {
    renderQueued({ queuedSends: [] });
    expect(screen.queryByText(/queued \d/)).toBeNull();
  });
});
