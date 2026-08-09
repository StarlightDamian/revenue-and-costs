import { describe, expect, it } from "vitest";
import {
  calculateCostAccounting,
  normalizeAccountingAssumptions,
} from "../../src/modules/accounting-preferences/index.js";

describe("accounting habit cost calculations", () => {
  it("preserves the existing zero-procurement result when both optional rates are blank", () => {
    expect(calculateCostAccounting({
      incomeTotalCny: "1000.00000000",
      netIncomeCny: "900.00000000",
      platformExpensesCny: "400.00000000",
    }, { profitRate: null, minimumSalesCostRate: null })).toEqual({
      targetProfitCny: null,
      profitCny: "500.00000000",
      procurementCny: "0.00000000",
      salesCostRate: "0.00000000",
      minimumAdjusted: false,
    });
  });

  it("derives target profit, procurement cost, and gross-revenue sales cost rate", () => {
    expect(calculateCostAccounting({
      incomeTotalCny: "1000.00000000",
      netIncomeCny: "900.00000000",
      platformExpensesCny: "400.00000000",
    }, { profitRate: "0.10000000", minimumSalesCostRate: null })).toEqual({
      targetProfitCny: "90.00000000",
      profitCny: "90.00000000",
      procurementCny: "410.00000000",
      salesCostRate: "0.41000000",
      minimumAdjusted: false,
    });
  });

  it("raises procurement to the minimum rate and lowers profit to preserve the accounting identity", () => {
    expect(calculateCostAccounting({
      incomeTotalCny: "1000.00000000",
      netIncomeCny: "900.00000000",
      platformExpensesCny: "700.00000000",
    }, { profitRate: "0.10000000", minimumSalesCostRate: "0.15000000" })).toEqual({
      targetProfitCny: "90.00000000",
      profitCny: "50.00000000",
      procurementCny: "150.00000000",
      salesCostRate: "0.15000000",
      minimumAdjusted: true,
    });
  });

  it("does not mark an adjustment when the base sales cost rate exactly equals the minimum", () => {
    expect(calculateCostAccounting({
      incomeTotalCny: "1000.00000000",
      netIncomeCny: "900.00000000",
      platformExpensesCny: "400.00000000",
    }, { profitRate: "0.10000000", minimumSalesCostRate: "0.41000000" })).toMatchObject({
      profitCny: "90.00000000",
      procurementCny: "410.00000000",
      salesCostRate: "0.41000000",
      minimumAdjusted: false,
    });
  });

  it("does not apply the minimum or divide when gross revenue is zero or negative", () => {
    expect(calculateCostAccounting({
      incomeTotalCny: "0.00000000",
      netIncomeCny: "10.00000000",
      platformExpensesCny: "3.00000000",
    }, { profitRate: "0.10000000", minimumSalesCostRate: "0.15000000" })).toMatchObject({
      procurementCny: "6.00000000",
      salesCostRate: "0.00000000",
      minimumAdjusted: false,
    });
    expect(calculateCostAccounting({
      incomeTotalCny: "-10.00000000",
      netIncomeCny: "10.00000000",
      platformExpensesCny: "3.00000000",
    }, { profitRate: "0.10000000", minimumSalesCostRate: "0.15000000" })).toMatchObject({
      procurementCny: "6.00000000",
      salesCostRate: "0.00000000",
      minimumAdjusted: false,
    });
  });

  it("accepts only optional fixed-point ratios between zero and one", () => {
    expect(normalizeAccountingAssumptions({ profitRate: "0.0437", minimumSalesCostRate: null })).toEqual({
      profitRate: "0.04370000",
      minimumSalesCostRate: null,
    });
    expect(() => normalizeAccountingAssumptions({ profitRate: "1.00000001", minimumSalesCostRate: null }))
      .toThrow("INVALID_ACCOUNTING_RATE:profitRate");
    expect(() => normalizeAccountingAssumptions({ profitRate: "0.123456789", minimumSalesCostRate: null }))
      .toThrow("INVALID_ACCOUNTING_RATE:profitRate");
  });
});
