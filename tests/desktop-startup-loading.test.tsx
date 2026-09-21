// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { StartupLoadingOverlay } from "../desktop/src/ui/startup-loading";

describe("desktop startup loading overlay", () => {
  it("renders a throbber overlay with accessible status role", () => {
    render(<StartupLoadingOverlay />);

    const overlay = screen.getByRole("status");
    expect(overlay).toBeTruthy();
    expect(overlay.classList.contains("startup-loading-overlay")).toBe(true);
    expect(screen.getByText("Loading workspaces…")).toBeTruthy();
    expect(screen.getByText("Restoring sessions and workspace state…")).toBeTruthy();
    expect(overlay.querySelector(".startup-loading-spinner")).toBeTruthy();
  });
});
