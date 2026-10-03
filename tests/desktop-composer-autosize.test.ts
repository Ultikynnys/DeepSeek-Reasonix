import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPOSER_ROWS,
  getComposerTextareaSizing,
} from "../desktop/src/ui/composer-sizing";

// The composer must hold a fixed height and never resize (#1594 regression):
// it previously expanded past a five-row threshold, so the box jumped as the
// user typed across that boundary.
describe("desktop composer textarea never resizes", () => {
  const height = DEFAULT_COMPOSER_ROWS * 20 + 18;

  it("holds the fixed height for a single line", () => {
    const sizing = getComposerTextareaSizing({
      contentRows: 1,
      lineHeightPx: 20,
      verticalPaddingPx: 18,
    });

    expect(sizing.heightPx).toBe(height);
    expect(sizing.overflowY).toBe("hidden");
  });

  it("keeps the same height regardless of how much content is typed", () => {
    for (const contentRows of [1, 2, 3, 5, 10, 20]) {
      const sizing = getComposerTextareaSizing({
        contentRows,
        lineHeightPx: 20,
        verticalPaddingPx: 18,
      });

      expect(sizing.heightPx).toBe(height);
    }
  });

  it("scrolls inside the box instead of growing once content overflows", () => {
    const fits = getComposerTextareaSizing({
      contentRows: DEFAULT_COMPOSER_ROWS,
      lineHeightPx: 20,
      verticalPaddingPx: 18,
    });
    const overflows = getComposerTextareaSizing({
      contentRows: DEFAULT_COMPOSER_ROWS + 1,
      lineHeightPx: 20,
      verticalPaddingPx: 18,
    });

    expect(fits.overflowY).toBe("hidden");
    expect(overflows.overflowY).toBe("auto");
    expect(overflows.heightPx).toBe(height);
  });
});
