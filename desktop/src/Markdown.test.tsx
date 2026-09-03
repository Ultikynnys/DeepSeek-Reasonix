// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

import { Markdown, WorkspaceProvider } from "./Markdown";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn() },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("Markdown", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("wraps tables in a horizontal scroll container", () => {
    const { container } = render(
      <Markdown
        source={`| A | B | C | D |
| - | - | - | - |
| 1 | 2 | 3 | 4 |`}
      />,
    );

    const wrap = container.querySelector(".markdown-table-wrap");
    expect(wrap).toBeTruthy();
    expect(wrap?.querySelector("table")).toBeTruthy();
  });

  it("recognizes a line-qualified custom extension in prose", () => {
    render(
      <Markdown source="Added the HACK comment to tails_animations_animation.qci:81. Done." />,
    );

    expect(screen.getByRole("button", { name: /tails_animations_animation\.qci:81/ })).toBeTruthy();
  });

  it("recognizes a custom extension with a directory path without a line", () => {
    render(<Markdown source="Updated scripts/tails_animations_animation.qci successfully." />);

    expect(
      screen.getByRole("button", { name: "scripts/tails_animations_animation.qci" }),
    ).toBeTruthy();
  });

  it("does not treat a bare custom extension without a line as prose file reference", () => {
    render(<Markdown source="Version release.qci is descriptive prose." />);

    expect(screen.queryByRole("button", { name: "release.qci" })).toBeNull();
  });

  it("resolves a bare reference through the workspace before revealing it", async () => {
    invoke
      .mockResolvedValueOnce({
        status: "unique",
        path: "/repo/game/tails_animations_animation.qci",
      })
      .mockResolvedValueOnce(undefined);
    render(
      <WorkspaceProvider value={{ dir: "/repo" }}>
        <Markdown source="tails_animations_animation.qci:81" />
      </WorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /tails_animations_animation\.qci:81/ }));

    await waitFor(() =>
      expect(invoke).toHaveBeenNthCalledWith(1, "resolve_workspace_file", {
        path: "tails_animations_animation.qci",
        workspace: "/repo",
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "reveal_in_explorer", {
      path: "/repo/game/tails_animations_animation.qci",
      workspace: null,
    });
  });

  it("shows all ambiguous workspace matches instead of choosing one", async () => {
    invoke.mockResolvedValueOnce({
      status: "ambiguous",
      paths: ["/repo/a/shared.qci", "/repo/b/shared.qci"],
    });
    render(
      <WorkspaceProvider value={{ dir: "/repo" }}>
        <Markdown source="shared.qci:12" />
      </WorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /shared\.qci:12/ }));

    expect(
      (await screen.findByText("Select a workspace file")).closest(".file-pill-matches"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "/repo/a/shared.qci" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "/repo/b/shared.qci" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "/repo/b/shared.qci" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenNthCalledWith(2, "reveal_in_explorer", {
        path: "/repo/b/shared.qci",
        workspace: null,
      }),
    );
    expect(screen.queryByText("Select a workspace file")).toBeNull();
  });

  it("marks a missing workspace reference without revealing it", async () => {
    invoke.mockResolvedValueOnce({ status: "not_found" });
    render(
      <WorkspaceProvider value={{ dir: "/repo" }}>
        <Markdown source="missing.qci:9" />
      </WorkspaceProvider>,
    );

    const pill = screen.getByRole("button", { name: /missing\.qci:9/ });
    fireEvent.click(pill);

    await waitFor(() =>
      expect(pill.getAttribute("title")).toBe("File not found in workspace: missing.qci"),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
