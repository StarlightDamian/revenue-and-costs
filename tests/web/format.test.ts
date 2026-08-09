import { describe, expect, it } from "vitest";
import { formatMoney, formatRatio } from "../../src/web/format";

describe("financial display formatting", () => {
  it("rounds decimal strings half up without binary floating point", () => {
    expect(formatMoney("1234567.00500000")).toBe("1,234,567.01");
    expect(formatMoney("-0.00500000")).toBe("-0.01");
  });

  it("keeps the specified unavailable ratio mark", () => {
    expect(formatRatio()).toBe("—");
    expect(formatRatio("0.12345678")).toBe("12.35%");
  });
});
