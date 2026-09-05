// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkdirPop } from "./workdir-pop";

afterEach(() => {
  cleanup();
});

describe("WorkdirPop component", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <WorkdirPop
        open={false}
        onClose={vi.fn()}
        recent={["/repo/alpha", "/repo/beta"]}
        onPick={vi.fn()}
        onBrowse={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders recent workspaces and allows picking one", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkdirPop
        open
        onClose={onClose}
        recent={["/repo/alpha", "/repo/beta"]}
        current="/repo/current"
        onPick={onPick}
        onBrowse={vi.fn()}
      />,
    );

    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();

    fireEvent.click(screen.getByText("alpha"));
    expect(onPick).toHaveBeenCalledWith("/repo/alpha");
    expect(onClose).toHaveBeenCalled();
  });

  it("renders remove button for recent workspaces when onRemove is provided", () => {
    const onRemove = vi.fn();
    const onPick = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkdirPop
        open
        onClose={onClose}
        recent={["/repo/alpha", "/repo/beta"]}
        current="/repo/current"
        onPick={onPick}
        onRemove={onRemove}
        onBrowse={vi.fn()}
      />,
    );

    const removeBtns = screen.getAllByRole("button", { name: "Remove from recent" });
    expect(removeBtns.length).toBe(2);

    // Clicking the remove button must call onRemove and NOT call onPick or onClose
    fireEvent.click(removeBtns[0]!);
    expect(onRemove).toHaveBeenCalledWith("/repo/alpha");
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("triggers remove on keyboard Enter or Space", () => {
    const onRemove = vi.fn();
    const onPick = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkdirPop
        open
        onClose={onClose}
        recent={["/repo/alpha"]}
        onPick={onPick}
        onRemove={onRemove}
        onBrowse={vi.fn()}
      />,
    );

    const btn = screen.getByRole("button", { name: "Remove from recent" });
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(onRemove).toHaveBeenCalledWith("/repo/alpha");
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(btn, { key: " " });
    expect(onRemove).toHaveBeenCalledTimes(2);
  });

  it("renders checkmark for current workspace when recent is empty and does not render remove button", () => {
    render(
      <WorkdirPop
        open
        onClose={vi.fn()}
        recent={[]}
        current="/repo/current"
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onBrowse={vi.fn()}
      />,
    );

    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove from recent" })).toBeNull();
  });
});
