import { describe, expect, it } from "vitest";
import { accountingPeriodContains, accountingPeriodStartDate, parseAccountingPeriodScope } from "../../src/shared/accounting-period.js";

describe("accounting period scope", () => {
  it("accepts an inclusive same-year month range", () => {
    const scope = parseAccountingPeriodScope({ periodStart: "2026-04", periodEnd: "2026-06" });
    expect(scope).toEqual({ periodStart: "2026-04", periodEnd: "2026-06" });
    expect(accountingPeriodContains(scope, "2026-04")).toBe(true);
    expect(accountingPeriodContains(scope, "2026-06")).toBe(true);
    expect(accountingPeriodContains(scope, "2026-03")).toBe(false);
    expect(accountingPeriodStartDate("2026-04")).toBe("2026-04-01");
  });

  it("keeps the legacy unbounded scope when both ends are absent", () => {
    expect(parseAccountingPeriodScope({})).toBeUndefined();
    expect(accountingPeriodContains(undefined, "2025-06")).toBe(true);
  });

  it.each([
    [{ periodStart: "2026-04" }, "ACCOUNTING_PERIOD_SCOPE_INCOMPLETE"],
    [{ periodStart: "2026-4", periodEnd: "2026-06" }, "ACCOUNTING_PERIOD_SCOPE_INVALID"],
    [{ periodStart: "2026-07", periodEnd: "2026-06" }, "ACCOUNTING_PERIOD_SCOPE_REVERSED"],
    [{ periodStart: "2025-12", periodEnd: "2026-01" }, "ACCOUNTING_PERIOD_SCOPE_CROSS_YEAR"],
  ])("rejects invalid scope %#", (input, code) => {
    expect(() => parseAccountingPeriodScope(input)).toThrow(expect.objectContaining({ code }));
  });
});
