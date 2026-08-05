/** Per-tab theme persistence for the desktop shell — each tab remembers its
 *  own theme/style so switching tabs never mixes themes up. */

import {
  THEME,
  THEME_STYLE,
  type Theme,
  type ThemeStyle,
  defaultStyleForTheme,
  isTheme,
  isThemeStyle,
  themeForStyle,
} from "./theme";

export type TabTheme = {
  theme: Theme;
  themeStyle: ThemeStyle;
};

export const DEFAULT_TAB_THEME: TabTheme = {
  theme: THEME.DARK,
  themeStyle: THEME_STYLE.GRAPHITE,
};

/** Legacy global keys — read once as a migration fallback, never written. */
export const LEGACY_THEME_KEY = "reasonix.theme";
export const LEGACY_THEME_STYLE_KEY = "reasonix.themeStyle";

export function tabThemeKey(tabId: string, field: "theme" | "themeStyle"): string {
  return `reasonix.${field}.${tabId}`;
}

/** Read a tab's stored theme: its own keys first, then the legacy global keys
 *  (one-time migration), then null so callers can fall back to inheritance. */
export function readTabTheme(storage: Pick<Storage, "getItem">, tabId: string): TabTheme | null {
  const storedTheme = storage.getItem(tabThemeKey(tabId, "theme"));
  const storedStyle = storage.getItem(tabThemeKey(tabId, "themeStyle"));
  if (isThemeStyle(storedStyle))
    return { theme: themeForStyle(storedStyle), themeStyle: storedStyle };
  if (isTheme(storedTheme))
    return { theme: storedTheme, themeStyle: defaultStyleForTheme(storedTheme) };

  const legacyTheme = storage.getItem(LEGACY_THEME_KEY);
  const legacyStyle = storage.getItem(LEGACY_THEME_STYLE_KEY);
  if (isThemeStyle(legacyStyle))
    return { theme: themeForStyle(legacyStyle), themeStyle: legacyStyle };
  if (isTheme(legacyTheme))
    return { theme: legacyTheme, themeStyle: defaultStyleForTheme(legacyTheme) };
  return null;
}

export function writeTabTheme(
  storage: Pick<Storage, "setItem" | "removeItem">,
  tabId: string,
  tabTheme: TabTheme,
): void {
  storage.setItem(tabThemeKey(tabId, "theme"), tabTheme.theme);
  storage.setItem(tabThemeKey(tabId, "themeStyle"), tabTheme.themeStyle);
}

export function clearTabTheme(storage: Pick<Storage, "removeItem">, tabId: string): void {
  storage.removeItem(tabThemeKey(tabId, "theme"));
  storage.removeItem(tabThemeKey(tabId, "themeStyle"));
}
