// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderApiKeyRow } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

afterEach(cleanup);

describe("TypeSafe JAI API-key settings", () => {
  it("renders a password input and saves the key through the typed settings patch", () => {
    const onSave = vi.fn();
    render(
      <ProviderApiKeyRow
        engine="typesafe"
        patchKey="typesafeApiKey"
        signupUrl="https://console.typesafe.ai"
        onSave={onSave}
      />,
    );

    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(screen.getByText("JAI API key (TypeSafe)")).toBeTruthy();
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "  typesafe-secret  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ typesafeApiKey: "typesafe-secret" });
    expect(input.value).toBe("");
  });

  it("shows only the masked prefix and can clear the saved key", () => {
    const onSave = vi.fn();
    render(
      <ProviderApiKeyRow
        engine="typesafe"
        patchKey="typesafeApiKey"
        signupUrl="https://console.typesafe.ai"
        prefix="type…ret"
        onSave={onSave}
      />,
    );

    expect(screen.getByText(/type…ret/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onSave).toHaveBeenCalledWith({ typesafeApiKey: null });
  });
});
