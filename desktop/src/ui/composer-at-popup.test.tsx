// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
});

function renderComposer(props?: Partial<React.ComponentProps<typeof Composer>>) {
  const textareaRef = createRef<HTMLTextAreaElement>();
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
      workspaceDir="/repo"
      {...props}
    />,
  );

  return { ...utils, textareaRef };
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

  it("renders distinct category headers for DeepSeek, ChatGPT, Z.AI, Custom, and external providers", () => {
    const { container } = renderComposer({
      customModels: ["my-fine-tuned-model"],
      antigravityModels: ["gemini-3.7-flash-tiered"],
      ollamaModels: ["llama3.1:latest"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const groups = Array.from(container.querySelectorAll(".model-menu-group")).map(
      (el) => el.querySelector(".grow")?.textContent,
    );
    expect(groups).toEqual([
      "DeepSeek",
      "ChatGPT",
      "Z.AI",
      "Custom",
      "Google Antigravity",
      "Ollama",
    ]);
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
