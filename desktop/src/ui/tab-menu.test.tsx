// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabBar } from "../App";
import { TabMenu, getTabsToClear } from "./tab-menu";

afterEach(() => {
  cleanup();
});

describe("getTabsToClear", () => {
  const tabs = [
    { id: "tab-1", workspaceDir: "/ws1" },
    { id: "tab-2", workspaceDir: "/ws2" },
    { id: "tab-3", workspaceDir: "/ws3" },
    { id: "tab-4", workspaceDir: "/ws4" },
  ];

  it("returns all tabs when scope is 'all'", () => {
    const result = getTabsToClear(tabs, "tab-2", "all");
    expect(result.map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
  });

  it("returns tabs to the right of the active tab", () => {
    const result = getTabsToClear(tabs, "tab-2", "right");
    expect(result.map((t) => t.id)).toEqual(["tab-3", "tab-4"]);
  });

  it("returns tabs to the left of the active tab", () => {
    const result = getTabsToClear(tabs, "tab-3", "left");
    expect(result.map((t) => t.id)).toEqual(["tab-1", "tab-2"]);
  });

  it("returns empty array for 'left' when active tab is the first tab", () => {
    const result = getTabsToClear(tabs, "tab-1", "left");
    expect(result).toEqual([]);
  });

  it("returns empty array for 'right' when active tab is the last tab", () => {
    const result = getTabsToClear(tabs, "tab-4", "right");
    expect(result).toEqual([]);
  });

  it("handles unknown activeId safely", () => {
    expect(getTabsToClear(tabs, "unknown", "all").map((t) => t.id)).toEqual([
      "tab-1",
      "tab-2",
      "tab-3",
      "tab-4",
    ]);
    expect(getTabsToClear(tabs, "unknown", "right")).toEqual([]);
    expect(getTabsToClear(tabs, "unknown", "left")).toEqual([]);
  });
});

describe("TabMenu component", () => {
  const tabs = [
    { id: "tab-1" },
    { id: "tab-2" },
    { id: "tab-3" },
  ];

  it("renders the 3 options and handles clicking each option", () => {
    const onClear = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <TabMenu
        anchor={{ x: 100, y: 100 }}
        tabs={tabs}
        activeId="tab-2"
        onClear={onClear}
        onClose={onClose}
      />,
    );

    const clearAllBtn = screen.getByRole("menuitem", { name: "Clear all tabs" });
    const clearRightBtn = screen.getByRole("menuitem", { name: "Clear tabs to the right" });
    const clearLeftBtn = screen.getByRole("menuitem", { name: "Clear tabs to the left" });

    expect(clearAllBtn).toBeTruthy();
    expect(clearRightBtn).toBeTruthy();
    expect(clearLeftBtn).toBeTruthy();

    fireEvent.click(clearAllBtn);
    expect(onClear).toHaveBeenCalledWith("all");
    expect(onClose).toHaveBeenCalledTimes(1);

    onClear.mockReset();
    onClose.mockReset();

    rerender(
      <TabMenu
        anchor={{ x: 100, y: 100 }}
        tabs={tabs}
        activeId="tab-2"
        onClear={onClear}
        onClose={onClose}
      />,
    );

    fireEvent.click(clearRightBtn);
    expect(onClear).toHaveBeenCalledWith("right");
    expect(onClose).toHaveBeenCalledTimes(1);

    onClear.mockReset();
    onClose.mockReset();

    rerender(
      <TabMenu
        anchor={{ x: 100, y: 100 }}
        tabs={tabs}
        activeId="tab-2"
        onClear={onClear}
        onClose={onClose}
      />,
    );

    fireEvent.click(clearLeftBtn);
    expect(onClear).toHaveBeenCalledWith("left");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape key", () => {
    const onClose = vi.fn();
    render(
      <TabMenu
        anchor={{ x: 100, y: 100 }}
        tabs={tabs}
        activeId="tab-2"
        onClear={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on outside click", () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">Outside area</div>
        <TabMenu
          anchor={{ x: 100, y: 100 }}
          tabs={tabs}
          activeId="tab-2"
          onClear={vi.fn()}
          onClose={onClose}
        />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("TabBar context menu integration", () => {
  it("opens drop down menu on right-clicking the ribbon and clears tabs", () => {
    const onClearTabs = vi.fn();
    const tabs = [
      { id: "tab-1", workspaceDir: "/project/alpha" },
      { id: "tab-2", workspaceDir: "/project/beta" },
      { id: "tab-3", workspaceDir: "/project/gamma" },
    ];

    const { container } = render(
      <TabBar
        tabs={tabs}
        activeId="tab-2"
        setActive={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onClearTabs={onClearTabs}
      />,
    );

    const tabbar = container.querySelector(".tabbar")!;
    expect(screen.queryByRole("menu")).toBeNull();

    // Right-click the ribbon
    fireEvent.contextMenu(tabbar, { clientX: 200, clientY: 50 });

    // Context menu should appear
    expect(screen.getByRole("menu")).toBeTruthy();

    // Click "Clear tabs to the right"
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear tabs to the right" }));
    expect(onClearTabs).toHaveBeenCalledWith("right");

    // Menu should close
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
