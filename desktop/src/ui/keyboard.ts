/** Keyboard handlers shared by click-to-activate / click-to-close targets —
 *  the keyboard twins of their onClick actions (a11y useKeyWithClickEvents). */
import type { KeyboardEvent } from "react";

/** Enter and Space run the action (Space prevented so the page doesn't
 *  scroll). For non-button click targets; pair with tabIndex={0}. */
export function activationHandler(action: (e: KeyboardEvent) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action(e);
    }
  };
}

/** Escape closes — the keyboard equivalent of a click-outside mask. */
export function escapeHandler(action: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Escape") action();
  };
}
