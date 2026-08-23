// Theme-name vocabulary shared by config validation. The TUI palettes that
// used to live here were removed with the TUI; config.ts still persists the
// theme name setting, so the name set + normalizers stay in the engine.

export type ThemeName = "dark" | "light" | "midnight" | "deep-blue" | "high-contrast";

const DEFAULT_THEME_NAME: ThemeName = "dark";

const THEME_NAMES: readonly ThemeName[] = [
  "dark",
  "light",
  "midnight",
  "deep-blue",
  "high-contrast",
];

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

export function resolveThemeName(value?: string | null): ThemeName {
  if (!value || value === "auto") return DEFAULT_THEME_NAME;
  // Handle old theme names
  if (value === "default" || value === "github-dark") return "dark";
  if (value === "github-light") return "light";
  if (value === "tokyo-night") return "midnight";
  return isThemeName(value) ? value : DEFAULT_THEME_NAME;
}
