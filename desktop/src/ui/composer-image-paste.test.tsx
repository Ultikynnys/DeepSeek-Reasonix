// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// vitest runs with globals:false — testing-library's auto-cleanup never
// registers, so unmount between tests to keep queries unambiguous.
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
});

import { Composer, type SlashCmd } from "./composer";

const baseProps = {
  draft: "",
  setDraft: vi.fn(),
  onSend: vi.fn(),
  onAbort: vi.fn(),
  modelLabel: "gpt-5.6-sol",
  reasoningEffort: "high",
  onModelChange: vi.fn(),
  onEffortChange: vi.fn(),
  editMode: "review",
  onEditModeChange: vi.fn(),
  textareaRef: { current: null },
  slashCommands: [] as SlashCmd[],
} as const;

function firePaste(textarea: HTMLTextAreaElement, file: File): void {
  // jsdom's ClipboardEvent constructor ignores a clipboardData init — build a
  // plain bubbling paste event and attach the items manually (React reads
  // e.clipboardData off the synthetic event).
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { items: [{ type: file.type, getAsFile: () => file }] },
  });
  textarea.dispatchEvent(ev);
}

describe("Composer image paste (ChatGPT vision path)", () => {
  it("routes a clipboard image to onPasteImage when the model is image-capable", async () => {
    const onPasteImage = vi.fn(async () => undefined);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", {
      type: "image/png",
    });
    const { container } = render(
      <Composer {...baseProps} imageCapable onPasteImage={onPasteImage} />,
    );
    const textarea = container.querySelector("textarea")!;
    firePaste(textarea, file);
    await vi.waitFor(() => expect(onPasteImage).toHaveBeenCalledWith(file));
    // The vision path must NOT fall through to the save-to-disk mention path.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects the paste without a path mention when the model can't accept images", async () => {
    const onImageRejected = vi.fn();
    const setDraft = vi.fn();
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    const { container } = render(
      <Composer
        {...baseProps}
        setDraft={setDraft}
        imageCapable={false}
        onPasteImage={vi.fn(async () => undefined)}
        onImageRejected={onImageRejected}
      />,
    );
    const textarea = container.querySelector("textarea")!;
    firePaste(textarea, file);
    await vi.waitFor(() => expect(onImageRejected).toHaveBeenCalled());
    // The paste must never fall through to the temp-file save or inject a
    // @temp-path mention: the daemon only converts mentions for vision
    // models, so the path would just reach the model as dead text.
    expect(invoke).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("renders pending image thumbnails with a working remove button", () => {
    const onRemoveImage = vi.fn();
    const { container } = render(
      <Composer
        {...baseProps}
        pendingImages={[{ id: "img-1", thumbnail: "data:image/png;base64,AA" }]}
        onRemoveImage={onRemoveImage}
      />,
    );
    const img = container.querySelector(".composer-image img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AA");
    fireEvent.click(container.querySelector(".composer-image-remove")!);
    expect(onRemoveImage).toHaveBeenCalledWith("img-1");
  });
});

describe("Composer image pick button (ChatGPT vision path)", () => {
  const pickButton = (container: HTMLElement) =>
    container.querySelector('button[title="Insert file or image (@ mention)"]') as HTMLButtonElement;

  it("routes a picked PNG to onPickImage when the model is image-capable", async () => {
    const onPickImage = vi.fn();
    const setDraft = vi.fn();
    vi.mocked(open).mockResolvedValue("C:\\shots\\chart.png");
    const { container } = render(
      <Composer {...baseProps} setDraft={setDraft} imageCapable onPickImage={onPickImage} />,
    );
    fireEvent.click(pickButton(container));
    await vi.waitFor(() => expect(onPickImage).toHaveBeenCalledWith("C:\\shots\\chart.png"));
    // The vision path must not fall through to the mention path.
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("falls back to an @-mention for gif picks even when image-capable (#no stranded send)", async () => {
    const onPickImage = vi.fn();
    const setDraft = vi.fn();
    vi.mocked(open).mockResolvedValue("C:\\shots\\anim.gif");
    const { container } = render(
      <Composer {...baseProps} setDraft={setDraft} imageCapable onPickImage={onPickImage} />,
    );
    fireEvent.click(pickButton(container));
    await vi.waitFor(() => expect(setDraft).toHaveBeenCalled());
    expect(onPickImage).not.toHaveBeenCalled();
    const updater = setDraft.mock.calls[0]![0] as (cur: string) => string;
    expect(updater("")).toBe("@C:\\shots\\anim.gif ");
  });

  it("keeps the @-mention path when the model is DeepSeek", async () => {
    const onPickImage = vi.fn();
    const setDraft = vi.fn();
    vi.mocked(open).mockResolvedValue("/ws/shot.png");
    const { container } = render(
      <Composer
        {...baseProps}
        setDraft={setDraft}
        imageCapable={false}
        onPickImage={onPickImage}
      />,
    );
    fireEvent.click(pickButton(container));
    await vi.waitFor(() => expect(setDraft).toHaveBeenCalled());
    expect(onPickImage).not.toHaveBeenCalled();
  });
});
