import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../../src/web/api/types";
import { acceptSession, clearSession } from "../../src/web/session";
import {
  applyTheme,
  clearPendingThemePreference,
  initialTheme,
  normalizeTheme,
  stageThemePreference,
  THEME_NAMES,
  THEME_STORAGE_KEY,
} from "../../src/web/theme";

const account: Me = {
  id: "00000000-0000-4000-8000-000000000001",
  phoneMasked: "138****0000",
  avatarId: 1,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 0,
  isFirstLogin: false,
};

function installThemeDom() {
  const root = { dataset: {} as DOMStringMap };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  return root;
}

describe("web theme contract", () => {
  afterEach(() => {
    clearSession();
    clearPendingThemePreference();
    vi.unstubAllGlobals();
  });

  it("accepts only the four frozen theme ids", () => {
    expect(normalizeTheme("comfort")).toBe("comfort");
    expect(normalizeTheme("tech")).toBe("tech");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("system")).toBe("comfort");
    expect(THEME_NAMES).toEqual({ comfort: "舒适", tech: "科技", light: "浅色", dark: "深色" });
  });

  it("falls back safely when storage is unavailable or invalid", () => {
    expect(initialTheme({ getItem: () => "dark" })).toBe("dark");
    expect(initialTheme({ getItem: () => "unknown" })).toBe("comfort");
    expect(initialTheme({ getItem: () => { throw new Error("blocked"); } })).toBe("comfort");
  });

  it("updates root and the independent storage key", () => {
    const root = { dataset: {} as DOMStringMap };
    const writes: Array<[string, string]> = [];
    applyTheme("tech", root, { setItem: (key, value) => { writes.push([key, value]); } });
    expect(root.dataset.theme).toBe("tech");
    expect(writes).toEqual([[THEME_STORAGE_KEY, "tech"]]);
  });

  it("keeps a theme explicitly selected on the login page when accepting the session", () => {
    const root = installThemeDom();

    applyTheme("dark");
    stageThemePreference("dark");
    acceptSession(account);

    expect(root.dataset.theme).toBe("dark");
  });

  it("uses the account preference when there was no anonymous theme selection", () => {
    const root = installThemeDom();

    applyTheme("dark");
    acceptSession(account);

    expect(root.dataset.theme).toBe("comfort");
  });
});
