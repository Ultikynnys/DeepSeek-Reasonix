import { describe, expect, it } from "vitest";
import {
  THEME,
  THEME_STYLES,
  THEME_STYLE_THEME,
  isThemeStyle,
  themeForStyle,
} from "./theme";

describe("theme styles", () => {
  it("offers at least 15 styles", () => {
    expect(THEME_STYLES.length).toBeGreaterThanOrEqual(15);
  });

  it("keeps style ids unique", () => {
    expect(new Set(THEME_STYLES).size).toBe(THEME_STYLES.length);
  });

  it("maps every style to a valid dark/light theme", () => {
    const valid = new Set([THEME.DARK, THEME.LIGHT]);
    for (const style of THEME_STYLES) {
      expect(THEME_STYLE_THEME[style]).toBeDefined();
      expect(valid.has(themeForStyle(style))).toBe(true);
      expect(isThemeStyle(style)).toBe(true);
    }
  });

  it("rejects unknown style ids", () => {
    expect(isThemeStyle("rainbow")).toBe(false);
    expect(isThemeStyle(undefined)).toBe(false);
  });
});
