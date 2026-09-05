import { useCallback, useEffect, useRef, useState } from "react";

const PIN_THRESHOLD = 80; // px from bottom to consider "pinned"

/**
 * Auto-scroll to bottom while content grows; un-pin immediately on user scroll-up.
 *
 * Sticky-bottom auto-scroll rules:
 * 1. User scrolling UP (wheel deltaY < 0, touch dragging down, PageUp/ArrowUp,
 *    or dragging scrollbar up) immediately un-pins the view so auto-scroll
 *    never snaps the viewport back to the bottom while the user reads earlier content.
 * 2. User scrolling DOWN re-pins only when the viewport actually reaches the bottom
 *    (within PIN_THRESHOLD).
 * 3. While the user is actively dragging the scrollbar, ResizeObserver auto-scroll
 *    is disabled so the scrollbar thumb never rubber-bands.
 * 4. Turn start re-pins so the user sees the new turn's incoming tokens.
 * 5. Turn end only settles at the bottom if the user remained pinned. If the user
 *    scrolled up to read, turn end does not yank them back to the bottom.
 */
export function useAutoScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
  busy: boolean,
  /** Optional boot-time restore: the offset the transcript should open at. */
  getRestoreScrollTop?: () => number | null,
  /** True when this tab is the visible one. Inactive tabs render no thread
   *  content (see TabRuntime), so the boot restore / pin-to-bottom must be
   *  re-applied the moment a tab becomes active and its content mounts. */
  active?: boolean,
) {
  const [showJumpButton, setShowJumpButton] = useState(false);
  const isPinnedRef = useRef(true);
  const wasBusyRef = useRef(busy);
  const rafIdRef = useRef<number>(0);
  const draggingRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  const isAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - PIN_THRESHOLD;
  }, [containerRef]);

  const refreshJumpButton = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setShowJumpButton(!isPinnedRef.current && el.scrollHeight > el.clientHeight + PIN_THRESHOLD);
  }, [containerRef]);

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const el = containerRef.current;
      if (!el) return;
      isPinnedRef.current = true;
      setShowJumpButton(false);
      el.scrollTo({
        top: el.scrollHeight,
        behavior: smooth ? "smooth" : "instant",
      });
    },
    [containerRef],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let pendingFrame = 0;

    const unpin = () => {
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
      }
      isPinnedRef.current = false;
      refreshJumpButton();
    };

    const checkPinAfterScroll = () => {
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        if (isAtBottom()) {
          isPinnedRef.current = true;
          setShowJumpButton(false);
        } else {
          refreshJumpButton();
        }
      });
    };

    // Wheel: deltaY < 0 is an unambiguous user intent to scroll UP.
    // Un-pin immediately so a concurrent ResizeObserver cannot snap the view
    // back to the bottom mid-gesture.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        unpin();
      } else if (e.deltaY > 0) {
        checkPinAfterScroll();
      }
    };

    // Touch: track touch movement. deltaY < 0 (finger moving down) scrolls UP.
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      const deltaY = touchStartY - currentY;
      touchStartY = currentY;
      if (deltaY < 0) {
        unpin();
      } else if (deltaY > 0) {
        checkPinAfterScroll();
      }
    };

    // Keyboard: keys that move viewport UP immediately un-pin.
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "ArrowUp" ||
        e.key === "Home" ||
        (e.key === " " && e.shiftKey)
      ) {
        unpin();
      } else if (
        e.key === "PageDown" ||
        e.key === "ArrowDown" ||
        e.key === "End" ||
        (e.key === " " && !e.shiftKey)
      ) {
        checkPinAfterScroll();
      }
    };

    // Scrollbar drag / selection: while dragging, disable ResizeObserver auto-scroll
    // and track directional scroll changes.
    const onScrollDuringDrag = () => {
      const currentScrollTop = el.scrollTop;
      const delta = currentScrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;
      if (delta < 0) {
        unpin();
      } else if (delta > 0 && isAtBottom()) {
        isPinnedRef.current = true;
        setShowJumpButton(false);
      }
    };

    const onPointerDown = () => {
      lastScrollTopRef.current = el.scrollTop;
      if (draggingRef.current) return;
      draggingRef.current = true;
      el.addEventListener("scroll", onScrollDuringDrag, { passive: true });
    };

    const endDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      el.removeEventListener("scroll", onScrollDuringDrag);
      if (isAtBottom()) {
        isPinnedRef.current = true;
        setShowJumpButton(false);
      } else {
        refreshJumpButton();
      }
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return () => {
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScrollDuringDrag);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [containerRef, isAtBottom, refreshJumpButton]);

  // Turn start: user just sent a message and expects to see the new turn.
  // Turn end: settle on final answer ONLY if the user was already following along.
  // If the user scrolled up, do not yank them away from what they are reading.
  useEffect(() => {
    if (wasBusyRef.current !== busy) {
      if (busy) {
        scrollToBottom(true);
      } else if (isPinnedRef.current) {
        scrollToBottom(true);
      }
    }
    wasBusyRef.current = busy;
  }, [busy, scrollToBottom]);

  // Watch content size changes (streaming text, tool results, new messages)
  // and follow the bottom while pinned (unless actively dragging scrollbar).
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const ro = new ResizeObserver(() => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const el = containerRef.current;
        if (!el) return;
        if (isPinnedRef.current && !draggingRef.current) {
          el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
        } else {
          refreshJumpButton();
        }
      });
    });

    ro.observe(content);
    return () => {
      ro.disconnect();
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [containerRef, contentRef, refreshJumpButton]);

  // Initial scroll when the hook mounts or the tab becomes active.
  useEffect(() => {
    if (active === false) return;
    const el = containerRef.current;
    if (!el) return;
    const id = setTimeout(() => {
      const restore = getRestoreScrollTop?.() ?? null;
      if (restore != null && restore > PIN_THRESHOLD) {
        isPinnedRef.current = false;
        el.scrollTop = restore;
        refreshJumpButton();
      } else {
        isPinnedRef.current = true;
        setShowJumpButton(false);
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    }, 60);
    return () => clearTimeout(id);
  }, [containerRef, getRestoreScrollTop, refreshJumpButton, active]);

  return { showJumpButton, scrollToBottom };
}
