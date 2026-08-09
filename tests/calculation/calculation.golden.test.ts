import { describe, expect, it } from "vitest";
import { calculateFinancials, type FactFxConversion, type ShipmentFact, type TransactionFact } from "../../src/modules/calculation";

const fx: FactFxConversion = {
  requestedDate: "2026-09-30",
  hitDate: "2026-09-30",
  fallbackDays: "0",
  rate: "7.00000000",
  quoteIds: ["usd-quote"],
};

const identity = {
  datasetVersionId: "version-1",
  sourceFileId: "source-1",
  rowNumber: "1",
  rowHash: "hash-1",
  marketplace: "amazon.de",
  localMonth: "2026-10",
  currency: "USD",
  fxDate: "2026-09-30",
} as const;

const shipment: ShipmentFact = {
  ...identity,
  id: "shipment-1",
  kind: "SHIPMENT",
  shippedQuantity: "999",
  amounts: {
    productPrice: "100", productTax: "10", shippingPrice: "5", shippingTax: "0.5",
    giftWrapPrice: "2", giftWrapTax: "0.2", productPromotionDiscount: "-3", shipmentPromotionDiscount: "-1",
  },
};

function transaction(id: string, type: string, description: string, overrides: Partial<TransactionFact["amounts"]>): TransactionFact {
  return {
    ...identity,
    id,
    kind: "TRANSACTION",
    type,
    description,
    amounts: {
      productSales: "0", productSalesTax: "0", shippingCredits: "0", shippingCreditsTax: "0",
      giftWrapCredits: "0", giftWrapCreditsTax: "0", regulatoryFee: "0", taxOnRegulatoryFee: "0",
      promotionalRebates: "0", promotionalRebatesTax: "0", marketplaceWithheldTax: "0",
      sellingFees: "0", fbaFees: "0", otherTransactionFees: "0", other: "0", ...overrides,
    },
  };
}

describe("财务口径 Golden", () => {
  it("收入八字段是行总额，不乘发货数量；退款严格九字段；费用单元格互斥", () => {
    const refund = transaction("transaction-1", "Refund", "Cost of Advertising", {
      productSales: "-10", productSalesTax: "-1", shippingCredits: "-2", shippingCreditsTax: "-0.2",
      giftWrapCredits: "-0.5", giftWrapCreditsTax: "-0.05", regulatoryFee: "-0.3",
      taxOnRegulatoryFee: "-0.03", promotionalRebates: "1",
      promotionalRebatesTax: "-99", marketplaceWithheldTax: "-2", sellingFees: "-3",
      fbaFees: "-4", otherTransactionFees: "-5", other: "-6",
    });
    const storage = transaction("transaction-2", "FBA Inventory Fee", "", { other: "-8" });
    const transfer = transaction("transaction-3", "Transfer", "", { other: "-100" });
    const output = calculateFinancials({
      shipments: [[shipment, fx]],
      transactions: [[refund, fx], [storage, fx], [transfer, fx]],
    });

    expect(output.summary).toEqual({
      income: "795.90000000",
      refund: "91.56000000",
      withheldTax: "14.00000000",
      platformFee: "21.00000000",
      fbaFulfillmentFee: "28.00000000",
      advertisingFee: "35.00000000",
      fbaStorageFee: "56.00000000",
      otherDeduction: "42.00000000",
      platformBalance: "508.34000000",
    });
    expect(output.results.some((result) => result.sourceColumn === "promotionalRebatesTax")).toBe(false);
    expect(output.results.filter((result) => result.factId === "transaction-3" && result.sourceColumn === "other")).toHaveLength(0);
    expect(new Set(output.results.map((result) => `${result.factId}:${result.sourceColumn}`)).size).toBe(output.results.length);
  });

  it("冲回保留来源符号，允许负成本", () => {
    const reversal = transaction("reversal", "Order", "", { sellingFees: "5" });
    const output = calculateFinancials({ shipments: [], transactions: [[reversal, fx]] });
    expect(output.summary.platformFee).toBe("-35.00000000");
    expect(output.summary.platformBalance).toBe("35.00000000");
  });

  it("零金额保留显式汇总但不生成无贡献的结果或汇率使用来源", () => {
    const zeroShipment: ShipmentFact = {
      ...shipment,
      id: "zero-shipment",
      amounts: Object.fromEntries(Object.keys(shipment.amounts).map((field) => [field, "0"])) as unknown as ShipmentFact["amounts"],
    };
    const zeroTransaction = transaction("zero-transaction", "Order", "", {});
    const output = calculateFinancials({
      shipments: [[zeroShipment, fx]],
      transactions: [[zeroTransaction, fx]],
    });

    expect(output.results).toEqual([]);
    expect(output.summary).toEqual({
      income: "0.00000000",
      refund: "0.00000000",
      withheldTax: "0.00000000",
      platformFee: "0.00000000",
      fbaFulfillmentFee: "0.00000000",
      advertisingFee: "0.00000000",
      fbaStorageFee: "0.00000000",
      otherDeduction: "0.00000000",
      platformBalance: "0.00000000",
    });
  });

  it("新计算拒绝命中输入日期之前的旧方向汇率", () => {
    expect(() => calculateFinancials({
      shipments: [[shipment, { ...fx, hitDate: "2026-09-29", fallbackDays: "1" }]],
      transactions: [],
    })).toThrow("INVALID_FX_HIT_DATE:shipment-1");
  });
});
