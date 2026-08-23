// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISection } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("OpenAISection", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderCard(props: Partial<Parameters<typeof OpenAISection>[0]> = {}) {
    const onBegin = vi.fn();
    const onCancel = vi.fn();
    const onSignOut = vi.fn();
    const onSaveApiKey = vi.fn();
    render(
      <OpenAISection
        signedIn={false}
        account={undefined}
        waiting={false}
        onBegin={onBegin}
        onCancel={onCancel}
        onSignOut={onSignOut}
        onSaveApiKey={onSaveApiKey}
        {...props}
      />,
    );
    return { onBegin, onCancel, onSignOut, onSaveApiKey };
  }

  it("shows the sign-in button when signed out", () => {
    renderCard();
    expect(screen.getByText("Sign in with OpenAI")).toBeTruthy();
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  it("starts the flow on click", () => {
    const { onBegin } = renderCard();
    fireEvent.click(screen.getByText("Sign in with OpenAI"));
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it("disables sign-in and shows Cancel while waiting", () => {
    const { onCancel } = renderCard({ waiting: true });
    expect(screen.getByText("Sign in with OpenAI").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the signed-in state with the masked account and signs out", () => {
    const { onSignOut } = renderCard({ signedIn: true, account: "u@example.com" });
    expect(screen.getByText(/u@example\.com/)).toBeTruthy();
    fireEvent.click(screen.getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Sign in with OpenAI")).toBeNull();
  });

  it("saves a pasted OpenAI API key and clears the input", () => {
    const { onSaveApiKey } = renderCard();
    const input = screen.getByPlaceholderText("sk-…");
    fireEvent.change(input, { target: { value: "sk-abc123" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSaveApiKey).toHaveBeenCalledWith("sk-abc123");
    expect((input as HTMLInputElement).value).toBe("");
  });
});
