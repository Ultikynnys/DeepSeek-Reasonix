import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAB_THEME,
  LEGACY_THEME_KEY,
  LEGACY_THEME_STYLE_KEY,
  clearTabTheme,
  readTabTheme,
  tabThemeKey,
  writeTabTheme,
} from "./tab-theme";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

describe("tab theme persistence", () => {
  it("reads a tab's own stored theme (style wins over theme)", () => {
    const storage = fakeStorage({
      [tabThemeKey("tab-1", "theme")]: "light",
      [tabThemeKey("tab-1", "themeStyle")]: "porcelain",
    });
    expect(readTabTheme(storage, "tab-1")).toEqual({ theme: "light", themeStyle: "porcelain" });
  });

  it("derives the style from the stored theme when only the theme key exists", () => {
    const storage = fakeStorage({ [tabThemeKey("tab-2", "theme")]: "light" });
    expect(readTabTheme(storage, "tab-2")).toEqual({ theme: "light", themeStyle: "sandstone" });
  });

  it("migrates from the legacy global keys when the tab has none of its own", () => {
    const storage = fakeStorage({
      [LEGACY_THEME_KEY]: "dark",
      [LEGACY_THEME_STYLE_KEY]: "midnight",
    });
    expect(readTabTheme(storage, "tab-3")).toEqual({ theme: "dark", themeStyle: "midnight" });
  });

  it("prefers the tab's own keys over the legacy global keys", () => {
    const storage = fakeStorage({
      [LEGACY_THEME_KEY]: "dark",
      [tabThemeKey("tab-4", "theme")]: "light",
      [tabThemeKey("tab-4", "themeStyle")]: "sandstone",
    });
    expect(readTabTheme(storage, "tab-4")).toEqual({ theme: "light", themeStyle: "sandstone" });
  });

  it("returns null when neither the tab nor the legacy keys are set", () => {
    expect(readTabTheme(fakeStorage(), "tab-5")).toBeNull();
    expect(
      readTabTheme(fakeStorage({ [tabThemeKey("other", "theme")]: "dark" }), "tab-5"),
    ).toBeNull();
  });

  it("round-trips through writeTabTheme", () => {
    const storage = fakeStorage();
    writeTabTheme(storage, "tab-6", { theme: "light", themeStyle: "porcelain" });
    expect(readTabTheme(storage, "tab-6")).toEqual({ theme: "light", themeStyle: "porcelain" });
  });

  it("drops a tab's keys on clearTabTheme", () => {
    const storage = fakeStorage({
      [tabThemeKey("tab-7", "theme")]: "light",
      [tabThemeKey("tab-7", "themeStyle")]: "sandstone",
    });
    clearTabTheme(storage, "tab-7");
    expect(readTabTheme(storage, "tab-7")).toBeNull();
  });

  it("ignores garbage values and falls back to the default", () => {
    const storage = fakeStorage({
      [tabThemeKey("tab-8", "theme")]: "neon",
      [tabThemeKey("tab-8", "themeStyle")]: "rainbow",
    });
    expect(readTabTheme(storage, "tab-8")).toBeNull();
    expect(DEFAULT_TAB_THEME).toEqual({ theme: "dark", themeStyle: "graphite" });
  });
});
