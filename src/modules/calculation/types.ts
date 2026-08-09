export const SHIPMENT_INCOME_FIELDS = [
  "productPrice",
  "productTax",
  "shippingPrice",
  "shippingTax",
  "giftWrapPrice",
  "giftWrapTax",
  "productPromotionDiscount",
  "shipmentPromotionDiscount",
] as const;

export const REFUND_FIELDS = [
  "productSales",
  "productSalesTax",
  "shippingCredits",
  "shippingCreditsTax",
  "giftWrapCredits",
  "giftWrapCreditsTax",
  "regulatoryFee",
  "taxOnRegulatoryFee",
  "promotionalRebates",
] as const;

export type ShipmentIncomeField = typeof SHIPMENT_INCOME_FIELDS[number];
export type RefundField = typeof REFUND_FIELDS[number];

export interface FactIdentity {
  readonly id: string;
  readonly datasetVersionId: string;
  readonly sourceFileId: string;
  readonly rowNumber: string;
  readonly rowHash: string;
  readonly marketplace: string;
  readonly localMonth: string;
  readonly currency: string;
  readonly fxDate: string;
}

export interface ShipmentFact extends FactIdentity {
  readonly kind: "SHIPMENT";
  readonly shippedQuantity: string;
  readonly amounts: Readonly<Record<ShipmentIncomeField, string>>;
}

export interface TransactionFact extends FactIdentity {
  readonly kind: "TRANSACTION";
  readonly type: string;
  readonly description: string;
  readonly fulfillmentMode: "AMAZON" | "MERCHANT" | "BLANK";
  readonly amounts: Readonly<Record<RefundField, string>> & {
    readonly promotionalRebatesTax: string;
    readonly marketplaceWithheldTax: string;
    readonly sellingFees: string;
    readonly fbaFees: string;
    readonly otherTransactionFees: string;
    readonly other: string;
  };
}

export interface FactFxConversion {
  readonly requestedDate: string;
  readonly hitDate: string;
  readonly fallbackDays: string;
  readonly rate: string;
  readonly quoteIds: readonly string[];
  readonly overrideIds?: readonly string[];
}

export type FinancialComponent =
  | "INCOME"
  | "REFUND"
  | "WITHHELD_TAX"
  | "PLATFORM_FEE"
  | "FBA_FULFILLMENT_FEE"
  | "ADVERTISING_FEE"
  | "FBA_STORAGE_FEE"
  | "OTHER_DEDUCTION";

export interface CalculationFactResult {
  readonly factKind: ShipmentFact["kind"] | TransactionFact["kind"];
  readonly factId: string;
  readonly datasetVersionId: string;
  readonly sourceColumn: string;
  readonly component: FinancialComponent;
  readonly amountOriginal: string;
  readonly amountCny: string;
  readonly fx: FactFxConversion;
}

export interface FinancialSummary {
  readonly income: string;
  readonly refund: string;
  readonly withheldTax: string;
  readonly platformFee: string;
  readonly fbaFulfillmentFee: string;
  readonly advertisingFee: string;
  readonly fbaStorageFee: string;
  readonly otherDeduction: string;
  readonly platformBalance: string;
}
