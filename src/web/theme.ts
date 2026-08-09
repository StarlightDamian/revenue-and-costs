export const THEME_STORAGE_KEY = "revenueCostsThemeV01";
export const THEMES = ["comfort", "tech", "light", "dark"] as const;
export type ThemeId = (typeof THEMES)[number];

export const THEME_NAMES: Readonly<Record<ThemeId, string>> = {
  comfort: "舒适",
  tech: "科技",
  light: "浅色",
  dark: "深色",
};

export function normalizeTheme(value: unknown): ThemeId {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as ThemeId)
    : "comfort";
}

export function initialTheme(storage?: Pick<Storage, "getItem">): ThemeId {
  try {
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "comfort";
  }
}

export function applyTheme(
  theme: ThemeId,
  root: Pick<HTMLElement, "dataset"> = document.documentElement,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  root.dataset.theme = theme;
  storage.setItem(THEME_STORAGE_KEY, theme);
}
