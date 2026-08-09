import { describe, expect, it, vi } from "vitest";
import { formatFxRateColumn, normalizeCurrencyCode } from "../../src/web/fx-conversion.js";
import { writeTextToClipboard, type ClipboardEnvironment } from "../../src/web/clipboard.js";
import { FX_CURRENCY_OPTIONS } from "../../src/web/fx-history.js";

describe("FX batch conversion page model", () => {
  it("copies only the eight-decimal rate column for direct Excel paste", () => {
    expect(formatFxRateColumn([
      { rate: "6.96780000" },
      { rate: "6.97710000" },
    ])).toBe("6.96780000\n6.97710000");
  });

  it("preserves blank rows so pasted rates remain aligned with input rows", () => {
    expect(formatFxRateColumn([
      { rate: "6.96780000" },
      { rate: null },
      { rate: "6.97710000" },
    ])).toBe("6.96780000\n\n6.97710000");
  });

  it("normalizes manual currency input and offers the default currencies", () => {
    expect(normalizeCurrencyCode(" cny ")).toBe("CNY");
    expect(FX_CURRENCY_OPTIONS).toEqual(expect.arrayContaining(["CNY", "USD"]));
  });
});

describe("clipboard compatibility", () => {
  it("uses the legacy copy path on an insecure LAN origin", async () => {
    const legacyCopy = vi.fn(() => true);
    const writeText = vi.fn(async () => undefined);
    const environment: ClipboardEnvironment = { secure: false, writeText, legacyCopy };

    await writeTextToClipboard("6.96780000\n6.97710000", environment);

    expect(writeText).not.toHaveBeenCalled();
    expect(legacyCopy).toHaveBeenCalledWith("6.96780000\n6.97710000");
  });

  it("falls back when the modern clipboard API rejects the write", async () => {
    const legacyCopy = vi.fn(() => true);
    const environment: ClipboardEnvironment = {
      secure: true,
      writeText: vi.fn(async () => { throw new Error("denied"); }),
      legacyCopy,
    };

    await writeTextToClipboard("6.96780000", environment);

    expect(legacyCopy).toHaveBeenCalledWith("6.96780000");
  });
});
