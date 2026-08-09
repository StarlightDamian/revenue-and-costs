import { describe, expect, it } from "vitest";
import { applyTheme, initialTheme, normalizeTheme, THEME_NAMES, THEME_STORAGE_KEY } from "../../src/web/theme";

describe("web theme contract", () => {
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
});
