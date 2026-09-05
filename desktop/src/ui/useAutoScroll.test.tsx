// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useAutoScroll } from "./useAutoScroll";

let resizeCallback: (() => void) | null = null;

class MockResizeObserver {
  constructor(cb: () => void) {
    resizeCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallback = null;
  }
}

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(performance.now());
    return 1;
  });
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  resizeCallback = null;
  vi.restoreAllMocks();
});

function TestHarness({
  busy = false,
  getRestoreScrollTop,
  active = true,
}: {
  busy?: boolean;
  getRestoreScrollTop?: () => number | null;
  active?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { showJumpButton, scrollToBottom } = useAutoScroll(
    containerRef,
    contentRef,
    busy,
    getRestoreScrollTop,
    active,
  );

  return (
    <div>
      <div
        ref={containerRef}
        data-testid="container"
        style={{ height: 400, overflowY: "auto" }}
      >
        <div ref={contentRef} data-testid="content" style={{ height: 1000 }} />
      </div>
      {showJumpButton ? (
        <button type="button" data-testid="jump-btn" onClick={() => scrollToBottom(true)}>
          Jump
        </button>
      ) : null}
    </div>
  );
}

describe("useAutoScroll", () => {
  it("auto-scrolls to bottom on resize while pinned", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 600, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    act(() => {
      resizeCallback?.();
    });

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
  });

  it("immediately unpins and shows jump button when user scrolls up with wheel", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 580, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    // User scrolls up by 20px (within PIN_THRESHOLD 80px, but intentional up-scroll)
    fireEvent.wheel(container, { deltaY: -20 });

    // Jump button must be visible now
    expect(screen.getByTestId("jump-btn")).toBeTruthy();

    // Now content resizes (e.g. streaming token arrived)
    scrollToSpy.mockClear();
    act(() => {
      resizeCallback?.();
    });

    // Must NOT scroll to bottom because user unpinned
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("unpins when user presses PageUp or ArrowUp", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 550, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    fireEvent.keyDown(container, { key: "PageUp" });
    expect(screen.getByTestId("jump-btn")).toBeTruthy();

    scrollToSpy.mockClear();
    act(() => {
      resizeCallback?.();
    });
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("re-pins when clicking jump button", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 300, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    // Unpin first
    fireEvent.wheel(container, { deltaY: -50 });
    const jumpBtn = screen.getByTestId("jump-btn");
    expect(jumpBtn).toBeTruthy();

    // Click jump
    fireEvent.click(jumpBtn);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

    // Jump button is dismissed
    expect(screen.queryByTestId("jump-btn")).toBeNull();

    // Subsequent resize follows bottom again
    scrollToSpy.mockClear();
    act(() => {
      resizeCallback?.();
    });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
  });

  it("does not scroll to bottom on turn end if user scrolled up", () => {
    const { rerender } = render(<TestHarness busy={true} />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 400, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    // User scrolls up during turn
    fireEvent.wheel(container, { deltaY: -100 });
    scrollToSpy.mockClear();

    // Turn ends (busy becomes false)
    rerender(<TestHarness busy={false} />);

    // Must NOT yank user to bottom
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("settles at bottom on turn end if user stayed pinned", () => {
    const { rerender } = render(<TestHarness busy={true} />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 600, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    // Turn ends without user unpinning
    rerender(<TestHarness busy={false} />);

    // Should settle at bottom
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("unpins when user drags touch downward (scrolling content up)", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 550, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    fireEvent.touchStart(container, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(container, { touches: [{ clientY: 250 }] }); // finger moved down -> scrolls UP

    expect(screen.getByTestId("jump-btn")).toBeTruthy();
    scrollToSpy.mockClear();
    act(() => {
      resizeCallback?.();
    });
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("disables auto-scroll during pointer/scrollbar dragging and unpins if dragged up", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 600, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    fireEvent.pointerDown(container);
    // User drags scrollbar thumb up
    Object.defineProperty(container, "scrollTop", { value: 500, writable: true });
    fireEvent.scroll(container);

    expect(screen.getByTestId("jump-btn")).toBeTruthy();

    scrollToSpy.mockClear();
    act(() => {
      resizeCallback?.();
    });
    expect(scrollToSpy).not.toHaveBeenCalled();

    // Release drag
    fireEvent.pointerUp(window);
  });

  it("re-pins when scrolling down to bottom with wheel", () => {
    render(<TestHarness />);
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    Object.defineProperty(container, "scrollTop", { value: 400, writable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

    // Unpin first
    fireEvent.wheel(container, { deltaY: -50 });
    expect(screen.getByTestId("jump-btn")).toBeTruthy();

    // Scroll down until within PIN_THRESHOLD of bottom (e.g. scrollTop 550 + clientHeight 400 = 950 >= 1000 - 80)
    Object.defineProperty(container, "scrollTop", { value: 550, writable: true });
    fireEvent.wheel(container, { deltaY: 50 });

    // Jump button is hidden and view is pinned again
    expect(screen.queryByTestId("jump-btn")).toBeNull();
  });
});
