// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// vitest runs with globals:false — testing-library's auto-cleanup never
// registers, so unmount between tests to keep queries unambiguous.
afterEach(cleanup);

import type { QueuedSendItem } from "./composer";
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

function renderQueued({
  queuedSends,
  onDequeueSend,
  onSendNow,
}: {
  queuedSends?: QueuedSendItem[];
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

  it("renders image thumbnails inside the queued chip when a message has images", () => {
    renderQueued({
      queuedSends: [
        {
          text: "describe this diagram",
          images: [
            { id: "img-1", thumbnail: "data:image/png;base64,ABC" },
            { id: "img-2", thumbnail: "data:image/png;base64,DEF" },
          ],
        },
      ],
    });

    const chip = document.querySelector(".composer-queue-chip");
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("title")).toBe("describe this diagram (2 images)");

    const images = chip?.querySelectorAll(".composer-queue-chip-img");
    expect(images?.length).toBe(2);
    expect(images?.[0]?.getAttribute("src")).toBe("data:image/png;base64,ABC");
    expect(images?.[1]?.getAttribute("src")).toBe("data:image/png;base64,DEF");
    expect(screen.getByText("describe this diagram")).toBeTruthy();
  });

  it("forwards pending images to onQueueWhileBusy when pressing Enter while busy", () => {
    const onQueueWhileBusy = vi.fn();
    const pendingImages = [{ id: "img-1", thumbnail: "data:image/png;base64,ABC" }];

    render(
      <Composer
        {...baseProps}
        busy={true}
        draft="check this image"
        pendingImages={pendingImages}
        onQueueWhileBusy={onQueueWhileBusy}
      />,
    );

    const textarea = document.querySelector("textarea")!;
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onQueueWhileBusy).toHaveBeenCalledTimes(1);
    expect(onQueueWhileBusy).toHaveBeenCalledWith("check this image", pendingImages);
  });
});
