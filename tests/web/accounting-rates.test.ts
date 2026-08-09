import { describe, expect, it } from "vitest";
import { percentInputToRatio, ratioToPercentInput } from "../../src/web/accounting-rates.js";

describe("accounting rate form conversion", () => {
  it("converts percentage-point text without JavaScript number arithmetic", () => {
    expect(percentInputToRatio("4.370000", "利润率")).toBe("0.04370000");
    expect(percentInputToRatio("", "利润率")).toBeNull();
    expect(ratioToPercentInput("0.15000000")).toBe("15");
  });

  it("rejects out-of-range or over-precise percentage text", () => {
    expect(() => percentInputToRatio("100.000001", "利润率")).toThrow("利润率必须在 0% 到 100% 之间");
    expect(() => percentInputToRatio("4.1234567", "利润率")).toThrow("利润率最多保留 6 位小数");
  });
});
