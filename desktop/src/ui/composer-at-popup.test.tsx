// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
});

function renderComposer(props?: Partial<React.ComponentProps<typeof Composer>>) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const onMentionQuery = vi.fn();
  const utils = render(
    <Composer
      draft=""
      setDraft={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      disabled={false}
      busy={false}
      modelLabel="deepseek-v4-flash"
      reasoningEffort="high"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      editMode="review"
      onEditModeChange={vi.fn()}
      textareaRef={textareaRef}
      slashCommands={[]}
      onMentionQuery={onMentionQuery}
      onMentionPreview={vi.fn()}
      onMentionPicked={vi.fn()}
      mentionResults={null}
      workspaceDir="/repo"
      {...props}
    />,
  );

  return { ...utils, textareaRef, onMentionQuery };
}

describe("desktop Composer model catalog", () => {
  it("shows only the signed-in account's discovered Antigravity models", () => {
    const { container } = renderComposer({
      antigravityModels: ["gemini-account-model", "claude-account-model", "chat_20706"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const text = container.querySelector(".model-menu-list")?.textContent ?? "";
    expect(text).toContain("Google Antigravity");
    expect(text).toContain("gemini-account-model");
    expect(text).toContain("claude-account-model");
    expect(text).toContain("chat_20706");
    expect(text).not.toContain("gemini-2.5-pro");
  });

  it("refreshes Antigravity models and surfaces refresh errors", () => {
    const onRefreshAntigravityModels = vi.fn();
    const { container } = renderComposer({
      antigravityModels: ["gemini-account-model"],
      antigravityModelsError: "quota unavailable",
      onRefreshAntigravityModels,
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    expect(container.querySelector(".model-menu-list")?.textContent).toContain("quota unavailable");
    const refresh = container.querySelector(
      'button[title="Refresh"]',
    ) as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();
    fireEvent.click(refresh!);
    expect(onRefreshAntigravityModels).toHaveBeenCalledOnce();
  });

  it("renders a subagent model menu that shares the main-agent catalog (DRY)", () => {
    const onModelChange = vi.fn();
    const onSubagentModelChange = vi.fn();
    const { container } = renderComposer({
      subagentModelLabel: "deepseek-v4-flash",
      onModelChange,
      onSubagentModelChange,
    });

    // Main-agent menu exposes the catalog.
    fireEvent.click(container.querySelector(".model-pill")!);
    const mainList = container.querySelector(".model-menu-list");
    expect(mainList?.textContent).toContain("deepseek-v4-flash");
    expect(mainList?.textContent).toContain("deepseek-v4-pro");

    // The subagent menu is its own button with the same catalog (DRY).
    fireEvent.click(container.querySelector(".subagent-pill")!);
    const subList = container.querySelector(".model-menu-list");
    expect(subList?.textContent).toContain("deepseek-v4-flash");
    expect(subList?.textContent).toContain("deepseek-v4-pro");

    // Clicking a model in the subagent menu routes to onSubagentModelChange.
    const flash = Array.from(subList!.querySelectorAll(".popup-item")).find((el) =>
      el.textContent?.includes("deepseek-v4-flash"),
    );
    fireEvent.click(flash!);
    expect(onSubagentModelChange).toHaveBeenCalledWith("deepseek-v4-flash");
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("subagent menu shares the backend-generated Ollama and Gemini models with the main agent", () => {
    const ollamaModels = ["llama3.1:latest", "qwen3:32b", "llava"];
    const antigravityModels = ["gemini-2.5-pro", "gemini-2.5-flash", "claude-3-5-sonnet"];
    const { container } = renderComposer({
      subagentModelLabel: "deepseek-v4-flash",
      ollamaModels,
      antigravityModels,
    });

    fireEvent.click(container.querySelector(".model-pill")!);
    const mainText = container.querySelector(".model-menu-list")?.textContent ?? "";

    fireEvent.click(container.querySelector(".subagent-pill")!);
    const subText = container.querySelector(".model-menu-list")?.textContent ?? "";

    // The subagent menu carries the SAME backend-fetched models as the main
    // agent — Ollama catalog ids and the signed-in Antigravity/Gemini ids.
    for (const id of [...ollamaModels, ...antigravityModels]) {
      expect(mainText).toContain(id);
      expect(subText).toContain(id);
    }
    expect(subText).toContain("Google Antigravity");
    expect(subText).toContain("Ollama");
  });
});

describe("desktop Composer @ popup", () => {
  it("keeps the active mention row when async results shrink", async () => {
    const { container, rerender, onMentionQuery } = renderComposer();
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.change(textarea, { target: { value: "@re" } });

    await waitFor(() => expect(onMentionQuery).toHaveBeenCalled());
    const nonce = onMentionQuery.mock.calls[0]?.[1] as number;

    rerender(
      <Composer
        draft="@re"
        setDraft={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        disabled={false}
        busy={false}
        modelLabel="deepseek-v4-flash"
        reasoningEffort="high"
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        editMode="review"
        onEditModeChange={vi.fn()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        slashCommands={[]}
        onMentionQuery={onMentionQuery}
        onMentionPreview={vi.fn()}
        onMentionPicked={vi.fn()}
        mentionResults={{ nonce, query: "re", results: ["alpha", "beta", "gamma"] }}
        workspaceDir="/repo"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.popup-item[data-active="true"]')?.textContent).toContain(
        "alpha",
      );
    });

    const items = container.querySelectorAll(".popup-item");
    fireEvent.mouseEnter(items[1]!);

    expect(container.querySelector('.popup-item[data-active="true"]')?.textContent).toContain(
      "beta",
    );

    rerender(
      <Composer
        draft="@re"
        setDraft={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        disabled={false}
        busy={false}
        modelLabel="deepseek-v4-flash"
        reasoningEffort="high"
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        editMode="review"
        onEditModeChange={vi.fn()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        slashCommands={[]}
        onMentionQuery={onMentionQuery}
        onMentionPreview={vi.fn()}
        onMentionPicked={vi.fn()}
        mentionResults={{ nonce, query: "re", results: ["alpha", "beta"] }}
        workspaceDir="/repo"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.popup-item[data-active="true"]')?.textContent).toContain(
        "beta",
      );
    });
  });

  it("uses the wider at popup class for mention results", async () => {
    const { container, rerender, onMentionQuery } = renderComposer();
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.change(textarea, { target: { value: "@re" } });
    await waitFor(() => expect(onMentionQuery).toHaveBeenCalled());
    const nonce = onMentionQuery.mock.calls[0]?.[1] as number;

    rerender(
      <Composer
        draft="@re"
        setDraft={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        disabled={false}
        busy={false}
        modelLabel="deepseek-v4-flash"
        reasoningEffort="high"
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        editMode="review"
        onEditModeChange={vi.fn()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        slashCommands={[]}
        onMentionQuery={onMentionQuery}
        onMentionPreview={vi.fn()}
        onMentionPicked={vi.fn()}
        mentionResults={{ nonce, query: "re", results: ["alpha"] }}
        workspaceDir="/repo"
      />,
    );

    expect(container.querySelector(".popup-list.at-popup-list")).not.toBeNull();
  });

  it("routes a mentioned image file to onPickImage when the model is image-capable", async () => {
    const onPickImage = vi.fn();
    const setDraft = vi.fn();
    const { container, rerender, onMentionQuery } = renderComposer({
      imageCapable: true,
      onPickImage,
      setDraft,
    });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.change(textarea, { target: { value: "@sho" } });
    await waitFor(() => expect(onMentionQuery).toHaveBeenCalled());
    const nonce = onMentionQuery.mock.calls[0]?.[1] as number;

    rerender(
      <Composer
        draft="@sho"
        setDraft={setDraft}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        disabled={false}
        busy={false}
        modelLabel="gpt-5.6-sol"
        reasoningEffort="high"
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        editMode="review"
        onEditModeChange={vi.fn()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        slashCommands={[]}
        onMentionQuery={onMentionQuery}
        onMentionPreview={vi.fn()}
        onMentionPicked={vi.fn()}
        mentionResults={{ nonce, query: "sho", results: ["assets/shot.png"] }}
        workspaceDir="/repo"
        imageCapable
        onPickImage={onPickImage}
      />,
    );

    // Typing already exercised setDraft — clear so the click's effect is
    // isolated: the image mention must attach, not insert @text.
    setDraft.mockClear();
    fireEvent.click(container.querySelectorAll(".popup-item")[0]!);

    // The workspace-relative mention resolves against the composer workspaceDir
    // and attaches as a vision pending image — no @text, no draft change.
    expect(onPickImage).toHaveBeenCalledWith("/repo/assets/shot.png");
    expect(setDraft).not.toHaveBeenCalled();
  });
});
