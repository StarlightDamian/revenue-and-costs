import { describe, expect, it } from "vitest";
import { decimal, decimal8, display2 } from "../../src/shared/decimal";

describe("decimal finance boundary", () => {
  it("uses decimal half-up rather than binary floating point", () => {
    expect(decimal8(decimal("0.1").plus("0.2"))).toBe("0.30000000");
    expect(display2("1.005")).toBe("1.01");
  });
  it("rejects exponent and non-decimal inputs", () => {
    expect(() => decimal("1e3")).toThrow("INVALID_DECIMAL");
  });
});
