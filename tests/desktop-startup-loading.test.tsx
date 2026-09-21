// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StartupLoadingOverlay } from "../desktop/src/ui/startup-loading";

describe("desktop startup loading overlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a throbber overlay with accessible status role and theme spinner", () => {
    render(<StartupLoadingOverlay />);

    const overlay = screen.getByRole("status");
    expect(overlay).toBeTruthy();
    expect(overlay.classList.contains("startup-loading-overlay")).toBe(true);
    expect(screen.getByText("Loading workspaces…")).toBeTruthy();
    expect(screen.getByText("Restoring sessions and workspace state…")).toBeTruthy();
    const spinner = overlay.querySelector(".startup-loading-spinner");
    expect(spinner).toBeTruthy();
    expect(spinner?.classList.contains("spin")).toBe(true);
  });

  it("suppresses mouse click and mousedown events", () => {
    render(<StartupLoadingOverlay />);
    const overlay = screen.getByRole("status");

    const downEvt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    overlay.dispatchEvent(downEvt);
    expect(downEvt.defaultPrevented).toBe(true);

    const clickEvt = new MouseEvent("click", { bubbles: true, cancelable: true });
    overlay.dispatchEvent(clickEvt);
    expect(clickEvt.defaultPrevented).toBe(true);
  });
});
